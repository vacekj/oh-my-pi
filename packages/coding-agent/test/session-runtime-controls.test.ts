import { expect, test } from "bun:test";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { getMcpSessionOverrides, setMcpSessionOverrides } from "@oh-my-pi/pi-coding-agent/mcp/session-overrides";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getSessionPromptParts, setSessionPromptSections } from "@oh-my-pi/pi-coding-agent/session/prompt-sections";
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
		expect(getSessionPromptParts()).toEqual(["First", "Second"]);
		setSessionPromptSections([]);
		expect(getSessionPromptParts()).toEqual([]);
		expect(() => setSessionPromptSections([{ title: "bad", text: "x".repeat(50_001), enabled: true }])).toThrow();
	} finally {
		setSessionPromptSections([]);
	}
});
