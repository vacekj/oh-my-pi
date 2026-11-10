import { expect, test } from "bun:test";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { getMcpSessionOverrides, setMcpSessionOverrides } from "@oh-my-pi/pi-coding-agent/mcp/session-overrides";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	getSessionPromptBlocks,
	getSessionPromptFilter,
	parsePromptFilter,
	parsePromptOverrides,
	setSessionPromptFilter,
	setSessionPromptSections,
} from "@oh-my-pi/pi-coding-agent/session/prompt-sections";
import { TempDir } from "@oh-my-pi/pi-utils";

test("hot swapping disconnects only the changed MCP and reconnects it without shared writes", async () => {
	using directory = TempDir.createSync("omp-mcp-hot-swap-");
	const config = {
		type: "stdio" as const,
		command: process.execPath,
		args: [path.join(import.meta.dir, "fixtures", "notifications-mcp.ts")],
	};
	const manager = new MCPManager(directory.path(), null, async () => ({
		configs: { ...(getMcpSessionOverrides().alpha === false ? {} : { alpha: config }), beta: config },
		sources: {},
		exaApiKeys: [],
	}));
	try {
		await manager.discoverAndConnect({ startupTimeoutMs: 0 });
		const beta = await manager.waitForConnection("beta");
		expect(manager.getConnectionStatus("alpha")).toBe("connected");
		await manager.reconcileSessionOverrides({ alpha: false });
		expect(manager.getConnectionStatus("alpha")).toBe("disconnected");
		expect(await manager.waitForConnection("beta")).toBe(beta);
		await manager.reconcileSessionOverrides({ alpha: true });
		expect(manager.getConnectionStatus("alpha")).toBe("connected");
		expect(await manager.waitForConnection("beta")).toBe(beta);
	} finally {
		await manager.disconnectAll();
		setMcpSessionOverrides({});
	}
});

test("strict session ownership refuses a locked file without creating a fork", async () => {
	using directory = TempDir.createSync("omp-strict-owner-");
	const owner = SessionManager.create(directory.path(), directory.path(), new FileSessionStorage());
	await owner.ensureOnDisk();
	const file = owner.getSessionFile()!;
	await owner.close();
	const before = await Bun.file(file).text();
	class LockedStorage extends FileSessionStorage {
		override claimSession(): null {
			return null;
		}
	}
	const previous = process.env.OMP_STRICT_SESSION_LOCK;
	process.env.OMP_STRICT_SESSION_LOCK = "1";
	try {
		await expect(
			SessionManager.open(file, directory.path(), new LockedStorage(), { suppressBreadcrumb: true }),
		).rejects.toThrow("locked by another process");
		expect(await Bun.file(file).text()).toBe(before);
	} finally {
		if (previous === undefined) delete process.env.OMP_STRICT_SESSION_LOCK;
		else process.env.OMP_STRICT_SESSION_LOCK = previous;
	}
});

test("prompt sections keep order, omit disabled parts, and can be replaced", () => {
	try {
		setSessionPromptSections([
			{ title: "one", text: "First", enabled: true },
			{ title: "off", text: "Hidden", enabled: false },
			{ title: "two", text: "Second", enabled: true },
		]);
		expect(getSessionPromptBlocks().map(block => block.text)).toEqual(["First", "Second"]);
		setSessionPromptSections([]);
		expect(getSessionPromptBlocks()).toEqual([]);
		expect(() => setSessionPromptSections([{ title: "bad", text: "x".repeat(50_001), enabled: true }])).toThrow();
	} finally {
		setSessionPromptSections([]);
	}
});

test("prompt sections accept plain text and titled sections, and report each under its index", () => {
	try {
		setSessionPromptSections([
			"Plain",
			{ title: "Style", text: "Terse" },
			{ title: "Off", text: "x", enabled: false },
		]);
		expect(getSessionPromptBlocks()).toEqual([
			{ id: "session-section:0", kind: "session-section", title: "Session section 1", text: "Plain" },
			{ id: "session-section:1", kind: "session-section", title: "Style", text: "Terse" },
		]);
		expect(() => setSessionPromptSections([{ text: "no title" }])).toThrow("Invalid prompt section");
	} finally {
		setSessionPromptSections([]);
	}
});

test("the prompt filter removes session sections it excludes, and keeps only the ones it lists", () => {
	try {
		setSessionPromptSections([
			{ title: "a", text: "A" },
			{ title: "b", text: "B" },
		]);
		setSessionPromptFilter({ mode: "exclude", ids: ["session-section:0"] });
		expect(getSessionPromptBlocks().map(block => block.id)).toEqual(["session-section:1"]);
		setSessionPromptFilter({ mode: "only", ids: [] });
		expect(getSessionPromptBlocks()).toEqual([]);
		setSessionPromptFilter({ mode: "only", ids: ["session-section:0"] });
		expect(getSessionPromptBlocks().map(block => block.id)).toEqual(["session-section:0"]);
	} finally {
		setSessionPromptSections([]);
		setSessionPromptFilter({ mode: "exclude", ids: [] });
	}
});

test("a prompt filter must name a mode and string ids", () => {
	expect(parsePromptFilter({ mode: "only", ids: ["tools", "tools"] })).toEqual({ mode: "only", ids: ["tools"] });
	expect(() => parsePromptFilter({ mode: "some", ids: [] })).toThrow("Invalid prompt filter");
	expect(() => parsePromptFilter({ mode: "only", ids: [1] })).toThrow("Invalid prompt filter");
	expect(getSessionPromptFilter()).toEqual({ mode: "exclude", ids: [] });
});

test("prompt overrides bound each replacement like a prompt section", () => {
	expect(parsePromptOverrides({ "template:text with spaces": "" })).toEqual({ "template:text with spaces": "" });
	expect(parsePromptOverrides({ "template:text": "x".repeat(50_000) })["template:text"]).toHaveLength(50_000);
	expect(() => parsePromptOverrides({ "template:text": "x".repeat(50_001) })).toThrow("Prompt override is too large");

	const four = Object.fromEntries(
		Array.from({ length: 4 }, (_, index): [string, string] => [`template:text/${index + 1}`, "x".repeat(50_000)]),
	);
	expect(Object.keys(parsePromptOverrides(four))).toHaveLength(4);
	const overTotal = Object.fromEntries(
		Array.from({ length: 5 }, (_, index): [string, string] => [`template:text/${index + 1}`, "x".repeat(40_001)]),
	);
	expect(() => parsePromptOverrides(overTotal)).toThrow("Prompt overrides are too large");

	const tooMany = Object.fromEntries(Array.from({ length: 257 }, (_, index): [string, string] => [`id-${index}`, ""]));
	expect(() => parsePromptOverrides(tooMany)).toThrow("Use at most 256 prompt overrides");
});
