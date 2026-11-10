import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	SpendBudgetExceededError,
	SpendLedger,
	setProviderSpendBudgets,
	setSpendLedgerPath,
	spendBudgetReports,
	estimateWorstCaseCostUsd,
	spendCycle,
	UnpricedBudgetModelError,
} from "@oh-my-pi/pi-ai/spend-budget";
import { complete, stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const PROVIDER = "claude-credits";

function makeModel(provider = PROVIDER): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-budget-test",
		name: "Budget test",
		provider,
		api: "anthropic-messages",
		baseUrl: "http://localhost/anthropic",
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

const context: Context = { messages: [{ role: "user", content: "Reply briefly.", timestamp: 0 }] };

/** 1,000 input + 200 output tokens at $5/$25 per million. */
const ACTUAL_COST = (1_000 * 5 + 200 * 25) / 1_000_000;

function sseResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg",
				type: "message",
				role: "assistant",
				model: "claude-budget-test",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 1_000, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 200 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function usedUsd(): number {
	const report = spendBudgetReports().find(r => r.provider === PROVIDER);
	return report?.limits[0]?.amount.used ?? Number.NaN;
}

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-spend-"));
	setSpendLedgerPath(path.join(dir, "spend.db"));
});

afterEach(() => {
	setProviderSpendBudgets(new Map());
	setSpendLedgerPath(undefined);
	fs.rmSync(dir, { recursive: true, force: true });
});

function budget(limitUsd: number, reserveUsd = 0): void {
	setProviderSpendBudgets(new Map([[PROVIDER, { limitUsd, resetDay: 1, reserveUsd }]]));
}

describe("spendCycle", () => {
	it("starts on the reset day and clamps it to short months", () => {
		const midMarch = new Date(2026, 2, 20, 12).getTime();
		expect(spendCycle(15, midMarch)).toEqual({
			start: new Date(2026, 2, 15).getTime(),
			end: new Date(2026, 3, 15).getTime(),
		});
		const earlyMarch = new Date(2026, 2, 2, 12).getTime();
		expect(spendCycle(31, earlyMarch)).toEqual({
			start: new Date(2026, 1, 28).getTime(),
			end: new Date(2026, 2, 31).getTime(),
		});
	});
});

describe("provider spend budget", () => {
	it("settles a request at its reported cost, once, on every entry point", async () => {
		budget(10);
		const model = makeModel();
		await streamSimple(model, context, { apiKey: "k", fetch: async () => sseResponse() }).result();
		expect(usedUsd()).toBeCloseTo(ACTUAL_COST, 9);
		await stream(model, context, { apiKey: "k", fetch: async () => sseResponse() }).result();
		expect(usedUsd()).toBeCloseTo(2 * ACTUAL_COST, 9);
		await complete(model, context, { apiKey: "k", fetch: async () => sseResponse() });
		expect(usedUsd()).toBeCloseTo(3 * ACTUAL_COST, 9);
	});

	it("refuses a request whose worst case does not fit, without sending it", async () => {
		// Worst case is the 8,192-token output cap alone: about $0.20.
		budget(0.1);
		let sent = 0;
		const fetch = async () => {
			sent++;
			return sseResponse();
		};
		expect(() => streamSimple(makeModel(), context, { apiKey: "k", fetch })).toThrow(SpendBudgetExceededError);
		expect(() => stream(makeModel(), context, { apiKey: "k", fetch })).toThrow(SpendBudgetExceededError);
		expect(sent).toBe(0);
		expect(usedUsd()).toBe(0);
	});

	it("keeps the reserve unspent", async () => {
		budget(0.3, 0.15);
		expect(() => streamSimple(makeModel(), context, { apiKey: "k", fetch: async () => sseResponse() })).toThrow(
			SpendBudgetExceededError,
		);
	});

	it("counts in-flight requests at their worst case, so parallel requests cannot overshoot", async () => {
		budget(0.45);
		const model = makeModel();
		const gates: Array<() => void> = [];
		const slowFetch = () =>
			new Promise<Response>(resolve => {
				gates.push(() => resolve(sseResponse()));
			});
		const first = streamSimple(model, context, { apiKey: "k", fetch: slowFetch });
		const second = streamSimple(model, context, { apiKey: "k", fetch: slowFetch });
		expect(() => streamSimple(model, context, { apiKey: "k", fetch: slowFetch })).toThrow(SpendBudgetExceededError);
		while (gates.length < 2) await Bun.sleep(1);
		for (const open of gates) open();
		await Promise.all([first.result(), second.result()]);
		expect(usedUsd()).toBeCloseTo(2 * ACTUAL_COST, 9);
		await streamSimple(model, context, { apiKey: "k", fetch: async () => sseResponse() }).result();
	});

	it("shares the ledger between processes' connections", () => {
		const limit = { limitUsd: 1, resetDay: 1, reserveUsd: 0 };
		const a = new SpendLedger(path.join(dir, "shared.db"));
		const b = new SpendLedger(path.join(dir, "shared.db"));
		try {
			a.admit(PROVIDER, "m", limit, 0.6);
			expect(() => b.admit(PROVIDER, "m", limit, 0.6)).toThrow(SpendBudgetExceededError);
			b.admit(PROVIDER, "m", limit, 0.4);
		} finally {
			a.close();
			b.close();
		}
	});

	it("refuses a budgeted model without a price instead of metering it at zero", () => {
		budget(100);
		const free = buildModel({ ...makeModel(), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		expect(() => streamSimple(free, context, { apiKey: "k", fetch: async () => sseResponse() })).toThrow(
			UnpricedBudgetModelError,
		);
	});

	it("prices only what reaches the wire", () => {
		const tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
		const lean: Context = { ...context, tools: [tool] as Context["tools"] };
		const heavy: Context = {
			messages: [{ ...context.messages[0], details: "x".repeat(1_000_000) } as Context["messages"][number]],
			tools: [{ ...tool, session: { blob: "x".repeat(1_000_000) } }] as unknown as Context["tools"],
		};
		expect(estimateWorstCaseCostUsd(makeModel(), heavy, undefined)).toBe(
			estimateWorstCaseCostUsd(makeModel(), lean, undefined),
		);
	});

	it("leaves providers without a budget alone", async () => {
		budget(0);
		const message = await streamSimple(makeModel("other"), context, {
			apiKey: "k",
			fetch: async () => sseResponse(),
		}).result();
		expect(message.stopReason).toBe("stop");
	});

	it("reports spend in USD against the limit", async () => {
		budget(100);
		await streamSimple(makeModel(), context, { apiKey: "k", fetch: async () => sseResponse() }).result();
		const [report] = spendBudgetReports();
		expect(report.provider).toBe(PROVIDER);
		expect(report.limits[0].amount).toMatchObject({ limit: 100, unit: "usd" });
		expect(report.limits[0].status).toBe("ok");
		expect(report.limits[0].window?.resetsAt).toBe(spendCycle(1).end);
	});
});
