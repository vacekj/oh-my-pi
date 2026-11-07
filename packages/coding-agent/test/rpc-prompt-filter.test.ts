import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

type RpcFrame = Record<string, unknown>;

interface RpcServer {
	request: (frame: { type: string } & Record<string, unknown>) => Promise<RpcFrame>;
	close: () => Promise<void>;
}

/** One RPC-mode CLI over its stdin/stdout, with the read and bash tools and no network. */
async function startRpcServer(env: Record<string, string> = {}): Promise<RpcServer> {
	const temp = await TempDir.create("@rpc-prompt-filter-");
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
				PI_CODING_AGENT_DIR: temp.join("agent"),
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
	};
}

interface PromptState {
	systemPrompt: string[];
	dumpTools: Array<{ name: string }>;
	systemPromptSources: {
		filter: { mode: string; ids: string[] };
		excluded: Array<{ id: string }>;
		sections: Array<{
			id: string;
			parent: string | null;
			block: number;
			start: number;
			end: number;
			origin: unknown;
		}>;
	};
}

async function state(server: RpcServer): Promise<PromptState> {
	const response = await server.request({ type: "get_state" });
	expect(response.success).toBe(true);
	return response.data as PromptState;
}

describe("prompt filter over RPC", () => {
	let server: RpcServer;
	beforeAll(async () => {
		server = await startRpcServer();
	});
	afterAll(() => server.close());

	test("get_state reports sections that tile every block, with where the bundled template declares them", async () => {
		const { systemPrompt, systemPromptSources } = await state(server);
		expect(systemPromptSources.filter).toEqual({ mode: "exclude", ids: [] });
		expect(systemPromptSources.excluded).toEqual([]);
		const ids = systemPromptSources.sections.map(section => section.id);
		expect(ids).toEqual(
			expect.arrayContaining(["template:role", "tools", "tool:read", "tool:bash", "template:critical"]),
		);
		systemPrompt.forEach((block, index) => {
			let cursor = 0;
			const top = systemPromptSources.sections.filter(section => section.block === index && section.parent === null);
			for (const section of top.sort((a, b) => a.start - b.start)) {
				expect(block.slice(cursor, section.start).trim()).toBe("");
				cursor = Math.max(cursor, section.end);
			}
			expect(block.slice(cursor).trim()).toBe("");
		});
		const tools = systemPromptSources.sections.find(section => section.id === "tools");
		expect(systemPrompt[tools!.block].slice(tools!.start, tools!.end)).toBe(
			"# Tool Inventory\n- Read: `read`\n- Bash: `bash`",
		);
	}, 60000);

	test("set_prompt_filter rebuilds the prompt, so the next get_state reflects it, and leaves the tools alone", async () => {
		const base = await state(server);
		const toolNames = base.dumpTools.map(tool => tool.name).sort();
		expect(toolNames).toEqual(["bash", "read"]);

		expect(await server.request({ type: "set_prompt_filter", filter: { mode: "only", ids: [] } })).toMatchObject({
			type: "response",
			command: "set_prompt_filter",
			success: true,
		});
		const empty = await state(server);
		expect(empty.systemPrompt).toEqual([]);
		expect(empty.systemPromptSources.sections).toEqual([]);
		expect(empty.systemPromptSources.filter).toEqual({ mode: "only", ids: [] });
		expect(empty.systemPromptSources.excluded.map(ref => ref.id)).toContain("template:role");
		expect(empty.dumpTools.map(tool => tool.name).sort()).toEqual(toolNames);

		await server.request({ type: "set_prompt_filter", filter: { mode: "only", ids: ["tools"] } });
		const toolsOnly = await state(server);
		expect(toolsOnly.systemPrompt).toEqual(["# Tool Inventory\n- Read: `read`\n- Bash: `bash`"]);
		expect(
			toolsOnly.systemPromptSources.sections.filter(section => section.parent === null).map(section => section.id),
		).toEqual(["tools"]);

		await server.request({ type: "set_prompt_filter", filter: { mode: "exclude", ids: ["template:tool-policy"] } });
		const without = await state(server);
		expect(without.systemPrompt.join("\n")).not.toContain("§ Tool Policy");
		expect(without.systemPrompt.join("\n")).toContain("§ Workflow");
		expect(without.systemPromptSources.excluded.map(ref => ref.id)).toEqual(["template:tool-policy"]);

		await server.request({ type: "set_prompt_filter", filter: { mode: "exclude", ids: [] } });
		expect((await state(server)).systemPrompt).toEqual(base.systemPrompt);
	}, 60000);

	test("rejects a filter that is not a mode and string ids, and keeps the one in force", async () => {
		const response = await server.request({ type: "set_prompt_filter", filter: { mode: "some", ids: [] } });
		expect(response).toMatchObject({ command: "set_prompt_filter", success: false, error: "Invalid prompt filter" });
		expect((await state(server)).systemPromptSources.filter).toEqual({ mode: "exclude", ids: [] });
	}, 60000);

	test("set_prompt_sections takes plain and titled sections, and refuses a titled one without text", async () => {
		expect(
			await server.request({ type: "set_prompt_sections", sections: ["Plain", { title: "Style", text: "Terse" }] }),
		).toMatchObject({ command: "set_prompt_sections", success: true });
		expect(await server.request({ type: "set_prompt_sections", sections: [{ title: "Style" }] })).toMatchObject({
			command: "set_prompt_sections",
			success: false,
			error: "Invalid prompt section",
		});
		await server.request({ type: "set_prompt_sections", sections: [] });
	}, 60000);

	test("lists a session section the filter removed as excluded, with its title and kind", async () => {
		await server.request({ type: "set_prompt_sections", sections: [{ title: "Style", text: "Terse" }] });
		try {
			await server.request({ type: "set_prompt_filter", filter: { mode: "exclude", ids: ["session-section:0"] } });
			const { systemPromptSources } = await state(server);
			expect(systemPromptSources.excluded).toEqual([
				expect.objectContaining({ id: "session-section:0", title: "Style", kind: "session-section", parent: null }),
			]);
			await server.request({ type: "set_prompt_filter", filter: { mode: "only", ids: [] } });
			const empty = await state(server);
			expect(empty.systemPromptSources.excluded.map(ref => ref.id)).toContain("session-section:0");
		} finally {
			await server.request({ type: "set_prompt_filter", filter: { mode: "exclude", ids: [] } });
			await server.request({ type: "set_prompt_sections", sections: [] });
		}
	}, 60000);
});

describe("OMP_SESSION_PROMPT_FILTER", () => {
	test("applies the filter from the first prompt build", async () => {
		const server = await startRpcServer({
			OMP_SESSION_PROMPT_FILTER: JSON.stringify({ mode: "only", ids: ["tools"] }),
		});
		try {
			const { systemPrompt, systemPromptSources } = await state(server);
			expect(systemPrompt).toEqual(["# Tool Inventory\n- Read: `read`\n- Bash: `bash`"]);
			expect(systemPromptSources.filter).toEqual({ mode: "only", ids: ["tools"] });
		} finally {
			await server.close();
		}
	}, 60000);
});
