/**
 * Hard per-provider spend budgets.
 *
 * A provider with a budget (`providers.<id>.budget` in models.yml) is metered
 * against a cross-process ledger in `spend.db`. Every request is admitted only
 * when the cycle's spend, plus the worst-case cost of every request still in
 * flight, plus this request's worst case, stays within the limit minus the
 * reserve. Admission and the reservation happen in one `BEGIN IMMEDIATE`
 * transaction, so parallel sessions and subagents cannot jointly overshoot.
 * A finished request replaces its reservation with its reported cost.
 *
 * The ledger counts only spend observed by omp on this machine. It cannot see
 * spend from other tools sharing the same API organization.
 */
import type { Database } from "bun:sqlite";
import { calculateUsageCost } from "@oh-my-pi/pi-catalog/models";
import { getSpendDbPath, logger, openSqliteDatabaseSync } from "@oh-my-pi/pi-utils";
import type { AssistantMessage, Context, Model, Usage } from "./types";
import type { UsageLimit, UsageReport } from "./usage";
import type { AssistantMessageEventStream } from "./utils/event-stream";

/** Budget of one provider, from models.yml. */
export interface ProviderSpendBudget {
	/** Spend allowed per cycle, in USD. */
	limitUsd: number;
	/** Day of the month (1-31, local time) the cycle restarts; clamped to short months. */
	resetDay: number;
	/** USD kept unspent as a margin for spend the local estimate misses. */
	reserveUsd: number;
}

/** A request the budget refused to send. */
export class SpendBudgetExceededError extends Error {
	constructor(
		readonly provider: string,
		readonly spentUsd: number,
		readonly requestUsd: number,
		readonly budget: ProviderSpendBudget,
		readonly resetsAt: number,
	) {
		super(
			`${provider} budget reached: $${spentUsd.toFixed(2)} of $${budget.limitUsd.toFixed(2)} spent this cycle` +
				(budget.reserveUsd > 0 ? ` ($${budget.reserveUsd.toFixed(2)} held in reserve)` : "") +
				`, and this request could cost up to $${requestUsd.toFixed(2)}. ` +
				`The budget resets ${new Date(resetsAt).toLocaleDateString()}. Switch to another model to continue.`,
		);
		this.name = "SpendBudgetExceededError";
	}
}

/** A budgeted provider's model has no price, so its spend cannot be metered. */
export class UnpricedBudgetModelError extends Error {
	constructor(
		readonly provider: string,
		readonly modelId: string,
	) {
		super(
			`${provider} has a spend budget, but ${modelId} has no price, so its spend cannot be metered. ` +
				`Set its \`cost\` in models.yml.`,
		);
		this.name = "UnpricedBudgetModelError";
	}
}

const budgets = new Map<string, ProviderSpendBudget>();

/** Replace the configured budgets (models.yml load). */
export function setProviderSpendBudgets(next: ReadonlyMap<string, ProviderSpendBudget>): void {
	budgets.clear();
	for (const [provider, budget] of next) budgets.set(provider, budget);
}

/** Budget of `provider`, when one is configured. */
export function getProviderSpendBudget(provider: string): ProviderSpendBudget | undefined {
	return budgets.get(provider);
}

/** Providers with a configured budget. */
export function listProviderSpendBudgets(): ReadonlyMap<string, ProviderSpendBudget> {
	return budgets;
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

function cycleDate(year: number, month: number, resetDay: number): Date {
	const daysInMonth = new Date(year, month + 1, 0).getDate();
	return new Date(year, month, Math.min(resetDay, daysInMonth));
}

/** `[start, end)` of the cycle containing `now`, in epoch ms. */
export function spendCycle(resetDay: number, now: number = Date.now()): { start: number; end: number } {
	const today = new Date(now);
	let start = cycleDate(today.getFullYear(), today.getMonth(), resetDay);
	if (start.getTime() > now) start = cycleDate(today.getFullYear(), today.getMonth() - 1, resetDay);
	const end = cycleDate(start.getFullYear(), start.getMonth() + 1, resetDay);
	return { start: start.getTime(), end: end.getTime() };
}

// ---------------------------------------------------------------------------
// Worst-case request cost
// ---------------------------------------------------------------------------

/** Generous per-image token allowance (Claude caps an image near 1,600 tokens). */
const IMAGE_TOKENS = 2_000;
/** Characters per token, low enough to overestimate prompts of code and prose. */
const CHARS_PER_TOKEN = 3;

function estimateContextTokens(context: Context): number {
	let images = 0;
	// Only what reaches the wire: runtime tool objects carry sessions and runners,
	// and tool results carry UI `details`, none of which is sent.
	const wire = {
		system: context.systemPrompt,
		messages: context.messages.map(message => ({ role: message.role, content: message.content })),
		tools: context.tools?.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	};
	const json = JSON.stringify(wire, (key, value) => {
		if (
			value &&
			typeof value === "object" &&
			(value as { type?: unknown }).type === "image" &&
			typeof (value as { data?: unknown }).data === "string"
		) {
			images++;
			return { type: "image" };
		}
		// Signatures and encrypted reasoning replay as opaque blobs the provider does not bill as text.
		if (key === "thinkingSignature" || key === "textSignature" || key === "encryptedContent") return undefined;
		return value;
	});
	return Math.ceil(json.length / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

/**
 * Upper bound of one request's cost: every prompt token billed as a 1-hour
 * cache write (2x input, the dearest input bucket) and the full output cap used.
 */
export function estimateWorstCaseCostUsd(model: Model, context: Context, maxTokens: number | undefined): number {
	const promptTokens = estimateContextTokens(context);
	const output = Math.max(maxTokens ?? 0, model.maxTokens ?? 0);
	const usage: Usage = {
		input: 0,
		output,
		cacheRead: 0,
		cacheWrite: promptTokens,
		cttl: { ephemeral1h: promptTokens },
		totalTokens: promptTokens + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return calculateUsageCost(model.cost, usage).total;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

interface SpendTotals {
	settledUsd: number;
	pendingUsd: number;
	pendingCount: number;
}

/** Cross-process spend ledger (`spend.db`). */
export class SpendLedger {
	readonly #db: Database;

	constructor(dbPath: string) {
		this.#db = openSqliteDatabaseSync(dbPath, db => {
			db.run(`
				PRAGMA journal_mode=WAL;
				PRAGMA synchronous=NORMAL;
				CREATE TABLE IF NOT EXISTS spend_ledger (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					provider TEXT NOT NULL,
					cycle_start INTEGER NOT NULL,
					model TEXT,
					reserved_usd REAL NOT NULL,
					cost_usd REAL,
					created_at INTEGER NOT NULL,
					settled_at INTEGER
				);
				CREATE INDEX IF NOT EXISTS spend_ledger_cycle ON spend_ledger(provider, cycle_start);
			`);
			return db;
		});
	}

	#totals(provider: string, cycleStart: number): SpendTotals {
		const row = this.#db
			.query<{ settled: number | null; pending: number | null; pending_count: number }, [string, number]>(
				`SELECT
					SUM(CASE WHEN settled_at IS NOT NULL THEN cost_usd END) AS settled,
					SUM(CASE WHEN settled_at IS NULL THEN reserved_usd END) AS pending,
					COUNT(CASE WHEN settled_at IS NULL THEN 1 END) AS pending_count
				FROM spend_ledger WHERE provider = ? AND cycle_start = ?`,
			)
			.get(provider, cycleStart);
		return { settledUsd: row?.settled ?? 0, pendingUsd: row?.pending ?? 0, pendingCount: row?.pending_count ?? 0 };
	}

	/** Spend of the cycle containing `now`: settled costs plus pending reservations. */
	totals(provider: string, budget: ProviderSpendBudget, now: number = Date.now()): SpendTotals & { resetsAt: number } {
		const cycle = spendCycle(budget.resetDay, now);
		return { ...this.#totals(provider, cycle.start), resetsAt: cycle.end };
	}

	/**
	 * Reserve `requestUsd` when it fits the budget; returns the reservation id.
	 * Throws {@link SpendBudgetExceededError} otherwise, recording nothing.
	 */
	admit(
		provider: string,
		modelId: string,
		budget: ProviderSpendBudget,
		requestUsd: number,
		now: number = Date.now(),
	): number {
		const cycle = spendCycle(budget.resetDay, now);
		const reserve = this.#db.transaction(() => {
			const totals = this.#totals(provider, cycle.start);
			const spent = totals.settledUsd + totals.pendingUsd;
			if (spent + requestUsd > budget.limitUsd - budget.reserveUsd) {
				throw new SpendBudgetExceededError(provider, spent, requestUsd, budget, cycle.end);
			}
			const row = this.#db
				.query<{ id: number }, [string, number, string, number, number]>(
					`INSERT INTO spend_ledger (provider, cycle_start, model, reserved_usd, created_at)
					VALUES (?, ?, ?, ?, ?) RETURNING id`,
				)
				.get(provider, cycle.start, modelId, requestUsd, now);
			return row!.id;
		});
		return reserve.immediate();
	}

	/**
	 * Replace a reservation with the request's actual cost. `undefined` (cost
	 * unknown) keeps the reserved worst case, which can only over-count.
	 */
	settle(id: number, costUsd: number | undefined, now: number = Date.now()): void {
		if (costUsd === undefined) {
			this.#db
				.query(
					`UPDATE spend_ledger SET cost_usd = reserved_usd, settled_at = ? WHERE id = ? AND settled_at IS NULL`,
				)
				.run(now, id);
			return;
		}
		this.#db
			.query(`UPDATE spend_ledger SET cost_usd = ?, settled_at = ? WHERE id = ? AND settled_at IS NULL`)
			.run(Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0, now, id);
	}

	close(): void {
		this.#db.close();
	}
}

let ledger: SpendLedger | undefined;
let ledgerPath: string | undefined;

/** Point the process ledger at another file (tests). */
export function setSpendLedgerPath(dbPath: string | undefined): void {
	ledger?.close();
	ledger = undefined;
	ledgerPath = dbPath;
}

function processLedger(): SpendLedger {
	ledger ??= new SpendLedger(ledgerPath ?? getSpendDbPath());
	return ledger;
}

// ---------------------------------------------------------------------------
// Stream gate
// ---------------------------------------------------------------------------

/** Marks options whose request already holds a reservation, so nested dispatch does not reserve twice. */
const SPEND_ADMITTED = Symbol.for("omp.spendAdmitted");

type GatedOptions = { maxTokens?: number; [SPEND_ADMITTED]?: true };

/** Copy the "already admitted" mark from one request's options onto options rebuilt for the same request. */
export function carrySpendAdmission<T extends object>(from: object | undefined, to: T): T {
	if (!(from as GatedOptions | undefined)?.[SPEND_ADMITTED]) return to;
	(to as GatedOptions)[SPEND_ADMITTED] = true;
	return to;
}

/** A request admitted against its provider's budget. */
export interface SpendAdmission<TOptions> {
	/** Options to send the request with. */
	options: TOptions;
	/** Settles the reservation from the request's result; returns the same stream. */
	meter(stream: AssistantMessageEventStream): AssistantMessageEventStream;
	/** Releases the reservation of a request that was never sent. */
	release(): void;
}

/**
 * Admit one request against its provider's budget. The returned admission is
 * a no-op when the provider has no budget or the request is already admitted
 * by an outer dispatch. Throws {@link SpendBudgetExceededError} when the
 * request does not fit.
 */
export function admitSpend<TOptions extends object | undefined>(
	model: Model,
	context: Context,
	options: TOptions,
): SpendAdmission<TOptions> {
	const budget = budgets.get(model.provider);
	const gated = options as GatedOptions | undefined;
	if (!budget || gated?.[SPEND_ADMITTED]) return { options, meter: stream => stream, release: () => {} };

	if (!(model.cost.input > 0) || !(model.cost.output > 0))
		throw new UnpricedBudgetModelError(model.provider, model.id);
	const requestUsd = estimateWorstCaseCostUsd(model, context, gated?.maxTokens);
	const book = processLedger();
	const id = book.admit(model.provider, model.id, budget, requestUsd);
	let settled = false;
	const settle = (costUsd: number | undefined) => {
		if (settled) return;
		settled = true;
		try {
			book.settle(id, costUsd);
		} catch (error) {
			// The reservation stays pending at its worst case, which only over-counts.
			logger.warn("Spend ledger settle failed", { provider: model.provider, error: String(error) });
		}
	};
	return {
		options: { ...options, [SPEND_ADMITTED]: true } as TOptions,
		meter: stream => {
			stream.result().then(
				(message: AssistantMessage) => settle(message.usage?.cost?.total ?? 0),
				// A stream that failed without a final message may still have been billed.
				() => settle(undefined),
			);
			return stream;
		},
		release: () => settle(0),
	};
}

// ---------------------------------------------------------------------------
// Usage report
// ---------------------------------------------------------------------------

/** Usage report of every budgeted provider, from the local ledger. */
export function spendBudgetReports(now: number = Date.now()): UsageReport[] {
	const reports: UsageReport[] = [];
	for (const [provider, budget] of budgets) {
		let totals: SpendTotals & { resetsAt: number };
		try {
			totals = processLedger().totals(provider, budget, now);
		} catch (error) {
			logger.warn("Spend ledger read failed", { provider, error: String(error) });
			continue;
		}
		const used = totals.settledUsd + totals.pendingUsd;
		const usable = Math.max(0, budget.limitUsd - budget.reserveUsd);
		const usedFraction = budget.limitUsd > 0 ? used / budget.limitUsd : 1;
		const cycle = spendCycle(budget.resetDay, now);
		const limit: UsageLimit = {
			id: "budget",
			label: "Budget",
			scope: { provider, windowId: "cycle" },
			window: {
				id: "cycle",
				label: "Billing cycle",
				durationMs: cycle.end - cycle.start,
				resetsAt: totals.resetsAt,
			},
			amount: {
				used,
				limit: budget.limitUsd,
				remaining: Math.max(0, budget.limitUsd - used),
				usedFraction,
				remainingFraction: Math.max(0, 1 - usedFraction),
				unit: "usd",
			},
			status: used >= usable ? "exhausted" : usedFraction >= 0.8 ? "warning" : "ok",
			notes: totals.pendingCount > 0 ? [`${totals.pendingCount} request(s) in flight`] : undefined,
		};
		reports.push({
			provider,
			fetchedAt: now,
			limits: [limit],
			notes: ["Spend observed by omp on this machine"],
			metadata: { budget: { ...budget } },
		});
	}
	return reports;
}
