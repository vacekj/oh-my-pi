import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

type RpcFrame = Record<string, unknown>;

interface RpcServer {
	request: (frame: { type: string } & Record<string, unknown>) => Promise<RpcFrame>;
	close: () => Promise<void>;
	agentDir: string;
}

async function startRpcServer(env: Record<string, string> = {}): Promise<RpcServer> {
	const temp = await TempDir.create("@rpc-session-overrides-");
	const agentDir = temp.join("agent");
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--mode",
			"rpc",
			"--no-extensions",
			"--no-skills",
			"--tools",
			"read,bash",
			"--no-session",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd: temp.path(),
			env: {
				PATH: Bun.env.PATH,
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: agentDir,
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				CI: "true",
				PI_NO_TITLE: "1",
				...env,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderr = new Response(child.stderr).text().catch(() => "");
	const waiting = new Map<string, PromiseWithResolvers<RpcFrame>>();
	let ended: Error | undefined;
	const pump = (async () => {
		try {
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (isRecord(frame) && frame.type === "response" && typeof frame.id === "string") {
					waiting.get(frame.id)?.resolve(frame);
				}
			}
		} catch {}
		ended = new Error(`RPC stream ended early: ${await stderr}`);
		for (const waiter of waiting.values()) waiter.reject(ended);
	})();
	let counter = 0;
	return {
		request: frame => {
			if (ended) return Promise.reject(ended);
			const id = `req-${counter++}`;
			const waiter = Promise.withResolvers<RpcFrame>();
			waiting.set(id, waiter);
			child.stdin.write(`${JSON.stringify({ ...frame, id })}\n`);
			void child.stdin.flush();
			return waiter.promise;
		},
		close: async () => {
			try {
				child.stdin.end();
			} catch {}
			child.kill();
			await child.exited.catch(() => {});
			await pump;
			await temp.remove();
		},
		agentDir,
	};
}

interface PromptState {
	model?: { provider: string; id: string };
	modelRoles: Record<string, string>;
	modelRoleOverrides: Record<string, string>;
	systemPrompt: string[];
	systemPromptSources: {
		overrides?: Record<string, string>;
		sections: Array<{ id: string; block: number; start: number; end: number; replacement?: unknown }>;
		excluded: Array<{ id: string; replacement?: unknown }>;
	};
}

async function state(server: RpcServer): Promise<PromptState> {
	const response = await server.request({ type: "get_state" });
	expect(response.success).toBe(true);
	return response.data as PromptState;
}

function textOf(prompt: PromptState, id: string): string | undefined {
	const section = prompt.systemPromptSources.sections.find(entry => entry.id === id);
	return section && prompt.systemPrompt[section.block].slice(section.start, section.end);
}

describe("prompt text overrides over RPC", () => {
	let server: RpcServer;
	beforeAll(async () => {
		server = await startRpcServer();
	});
	afterAll(() => server.close());

	test("set_prompt_overrides rebuilds the prompt and reports replacement provenance", async () => {
		expect(await server.request({ type: "set_prompt_overrides", overrides: {} })).toMatchObject({
			command: "set_prompt_overrides",
			success: true,
		});
		const before = await state(server);
		expect(textOf(before, "template:role/engineering")).toContain("# Engineering");

		expect(
			await server.request({
				type: "set_prompt_overrides",
				overrides: { "template:role/engineering": "Session engineering." },
			}),
		).toMatchObject({ command: "set_prompt_overrides", success: true });

		const after = await state(server);
		expect(after.systemPromptSources.overrides).toEqual({
			"template:role/engineering": "Session engineering.",
		});
		expect(textOf(after, "template:role/engineering")).toBe("Session engineering.");
		const replaced = after.systemPromptSources.sections.find(entry => entry.id === "template:role/engineering");
		expect(replaced?.replacement).toEqual({ kind: "session", setting: "promptOverrides" });
		expect(after.systemPrompt.join("\n")).not.toContain("# Engineering");
	}, 60000);

	test("an empty replacement is deliberate and an empty map clears the overrides", async () => {
		await server.request({
			type: "set_prompt_overrides",
			overrides: { "template:role/engineering": "" },
		});
		const emptied = await state(server);
		const section = emptied.systemPromptSources.sections.find(entry => entry.id === "template:role/engineering");
		expect(section?.replacement).toBeDefined();
		expect(section?.start).toBe(section?.end);
		expect(emptied.systemPrompt.join("\n")).not.toContain("# Engineering");

		await server.request({ type: "set_prompt_overrides", overrides: {} });
		const cleared = await state(server);
		expect(cleared.systemPromptSources.overrides).toBeUndefined();
		expect(textOf(cleared, "template:role/engineering")).toContain("# Engineering");
		expect(
			cleared.systemPromptSources.sections.find(entry => entry.id === "template:role/engineering")?.replacement,
		).toBeUndefined();
	}, 60000);

	test("invalid override payloads are rejected without changing the prompt", async () => {
		expect(await server.request({ type: "set_prompt_overrides", overrides: [] })).toMatchObject({
			command: "set_prompt_overrides",
			success: false,
			error: "Invalid prompt overrides",
		});
		expect(await server.request({ type: "set_prompt_overrides", overrides: { tools: 1 } })).toMatchObject({
			command: "set_prompt_overrides",
			success: false,
			error: "Invalid prompt override",
		});
		expect(await server.request({ type: "set_prompt_overrides", overrides: { "": "x" } })).toMatchObject({
			command: "set_prompt_overrides",
			success: false,
			error: "Invalid prompt override id",
		});
		const current = await state(server);
		expect(current.systemPromptSources.overrides).toBeUndefined();
	}, 60000);
});

describe("OMP_SESSION_PROMPT_OVERRIDES", () => {
	let server: RpcServer;
	beforeAll(async () => {
		server = await startRpcServer({
			OMP_SESSION_PROMPT_OVERRIDES: JSON.stringify({ tools: "Startup tool list." }),
		});
	});
	afterAll(() => server.close());

	test("seeds the session's overrides at startup", async () => {
		const seeded = await state(server);
		expect(seeded.systemPromptSources.overrides).toEqual({ tools: "Startup tool list." });
		expect(textOf(seeded, "tools")).toBe("Startup tool list.");
		expect(seeded.systemPromptSources.sections.some(entry => entry.id === "tool:read")).toBe(false);
	}, 60000);
});

describe("session model roles over RPC", () => {
	let server: RpcServer;
	beforeAll(async () => {
		server = await startRpcServer();
	});
	afterAll(() => server.close());

	test("set_model_roles replaces the local map without switching the main model or writing config", async () => {
		const before = await state(server);
		const mainModel = before.model;
		expect(before.modelRoleOverrides).toEqual({});
		// The launch model is a configured `default` role; it is not a session
		// override and must not be reported as one.
		expect(before.modelRoles).toMatchObject({ default: "anthropic/claude-sonnet-4-5" });

		expect(
			await server.request({
				type: "set_model_roles",
				roles: { task: "anthropic/claude-sonnet-4-5:high" },
			}),
		).toMatchObject({ command: "set_model_roles", success: true });

		const after = await state(server);
		expect(after.modelRoleOverrides).toEqual({ task: "anthropic/claude-sonnet-4-5:high" });
		expect(after.modelRoles).toMatchObject({
			default: "anthropic/claude-sonnet-4-5",
			task: "anthropic/claude-sonnet-4-5:high",
		});
		expect(after.model).toEqual(mainModel);

		// Shared configuration is untouched: the role map was never persisted.
		expect(await Bun.file(path.join(server.agentDir, "config.yml")).exists()).toBe(false);

		expect(await server.request({ type: "set_model_roles", roles: {} })).toMatchObject({
			command: "set_model_roles",
			success: true,
		});
		const cleared = await state(server);
		expect(cleared.modelRoleOverrides).toEqual({});
		expect(cleared.modelRoles).toMatchObject({ default: "anthropic/claude-sonnet-4-5" });
		expect(cleared.modelRoles.task).toBeUndefined();
		expect(cleared.model).toEqual(mainModel);
	}, 60000);

	test("invalid role payloads are rejected", async () => {
		expect(await server.request({ type: "set_model_roles", roles: [] })).toMatchObject({
			command: "set_model_roles",
			success: false,
			error: "Invalid model roles",
		});
		expect(await server.request({ type: "set_model_roles", roles: { task: "" } })).toMatchObject({
			command: "set_model_roles",
			success: false,
		});
		expect(
			await server.request({ type: "set_model_roles", roles: { "": "anthropic/claude-sonnet-4-5" } }),
		).toMatchObject({
			command: "set_model_roles",
			success: false,
			error: "Invalid model role name",
		});
		expect(
			await server.request({ type: "set_model_roles", roles: { "bad role": "anthropic/claude-sonnet-4-5" } }),
		).toMatchObject({ command: "set_model_roles", success: false, error: "Invalid model role name" });
		expect(await server.request({ type: "set_model_roles", roles: { task: "has space/model" } })).toMatchObject({
			command: "set_model_roles",
			success: false,
		});
		expect(
			await server.request({ type: "set_model_roles", roles: { task: "-anthropic/claude-sonnet-4-5" } }),
		).toMatchObject({ command: "set_model_roles", success: false });
		expect((await state(server)).modelRoleOverrides).toEqual({});

		// Selector punctuation (provider/model@upstream:level) and role punctuation
		// are preserved; only whitespace, control characters and a leading dash fail.
		expect(
			await server.request({
				type: "set_model_roles",
				roles: { "custom.role,one": "openrouter/model@cerebras:high" },
			}),
		).toMatchObject({ command: "set_model_roles", success: true });
		expect((await state(server)).modelRoleOverrides).toEqual({
			"custom.role,one": "openrouter/model@cerebras:high",
		});
		await server.request({ type: "set_model_roles", roles: {} });
	}, 60000);
});

describe("OMP_SESSION_MODEL_ROLES", () => {
	let server: RpcServer;
	beforeAll(async () => {
		server = await startRpcServer({
			OMP_SESSION_MODEL_ROLES: JSON.stringify({ task: "anthropic/claude-sonnet-4-5:low" }),
		});
	});
	afterAll(() => server.close());

	test("seeds the session's role assignments at startup", async () => {
		const seeded = await state(server);
		expect(seeded.modelRoleOverrides).toEqual({ task: "anthropic/claude-sonnet-4-5:low" });
		expect(seeded.modelRoles).toMatchObject({
			default: "anthropic/claude-sonnet-4-5",
			task: "anthropic/claude-sonnet-4-5:low",
		});
	}, 60000);
});
