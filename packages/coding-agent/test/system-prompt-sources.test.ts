import { describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import { __resetDirsFromEnvForTests, TempDir } from "@oh-my-pi/pi-utils";
import {
	type BuildSystemPromptOptions,
	type BuildSystemPromptResult,
	buildSystemPrompt,
	composeAppendPrompt,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import { SystemPromptManifestLog, type SystemPromptSource } from "@oh-my-pi/pi-coding-agent/system-prompt-sources";
import { restoreEnvValue } from "./helpers/settings-test-state";

/** Runs with an empty HOME and agent dir, so no real SYSTEM.md, PERSONALITY.md or skills leak in. */
async function inEmptyHome<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	using tempDir = TempDir.createSync("@omp-system-prompt-sources-");
	const home = tempDir.join("home");
	const homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = home;
	restoreEnvValue("PI_CODING_AGENT_DIR", tempDir.join("agent"));
	__resetDirsFromEnvForTests();
	try {
		return await fn(tempDir.join("project"));
	} finally {
		homedirSpy.mockRestore();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		restoreEnvValue("PI_CODING_AGENT_DIR", previousAgentDir);
		__resetDirsFromEnvForTests();
	}
}

function options(cwd: string, overrides: Partial<BuildSystemPromptOptions> = {}): BuildSystemPromptOptions {
	return {
		cwd,
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["read", "bash"],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		activeRepoContext: null,
		...overrides,
	};
}

function textOf(result: BuildSystemPromptResult, id: string): string | undefined {
	const source = result.manifest?.sources.find(entry => entry.id === id);
	return source && result.systemPrompt[source.block].slice(source.start, source.end);
}

const CONTEXT_FILE = "# House rules\n\n| Rule   |   Why |\n|--------|------|\n| tabs   | taste |\n\n\n\nLast line.   ";
const SKILL = {
	name: "deploy",
	description: "Ship the app",
	filePath: "/skills/deploy/SKILL.md",
	baseDir: "/skills/deploy",
	source: "test",
};

describe("system prompt source manifest", () => {
	it("locates each input's own text, even where post-render formatting rewrote it", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				options(cwd, {
					contextFiles: [{ path: `${cwd}/AGENTS.md`, content: CONTEXT_FILE, depth: 0, level: "project" }],
					skills: [SKILL],
					personality: "pragmatic",
					optionSettings: { personality: "personality" },
					appendPromptParts: [{ id: "memory", kind: "append", label: "Memory", text: "# Memory\nRecall first." }],
					resolvedAppendSystemPrompt: "Operator note.",
				}),
			);

			// Table padding and the blank-line run are normalized in the prompt; the
			// span still covers exactly the file's text and none of the <file> wrapper.
			const file = textOf(result, `context-file:${cwd}/AGENTS.md`);
			expect(file?.startsWith("# House rules")).toBe(true);
			expect(file?.endsWith("Last line.")).toBe(true);
			expect(file).toContain("|tabs|taste|");
			expect(file).not.toContain("<file");
			expect(file).not.toContain("</file>");

			expect(textOf(result, "skill:deploy")).toBe("deploy: Ship the app");
			expect(textOf(result, "memory")).toBe("# Memory\nRecall first.");
			expect(textOf(result, "user-append")).toBe("Operator note.");
			const personality = result.manifest?.sources.find(entry => entry.id === "personality");
			expect(personality).toMatchObject({ setting: "personality", value: "pragmatic" });
			expect(result.manifest?.unlocated).toEqual([]);

			// Spans never overlap except where one input sits inside another.
			const spans = (result.manifest?.sources ?? []).filter(s => s.block === 0).sort((a, b) => a.start - b.start);
			for (let i = 1; i < spans.length; i++) {
				expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
			}
		});
	});

	it("reports nothing for inputs a template conditional left out", async () => {
		await inEmptyHome(async cwd => {
			// No skill-reading tool: the skill list is not rendered. Personality "none" omits its block.
			const result = await buildSystemPrompt(
				options(cwd, { toolNames: ["bash"], skills: [SKILL], personality: "none" }),
			);
			const ids = (result.manifest?.sources ?? []).map((source: SystemPromptSource) => source.id);
			expect(ids).not.toContain("skill:deploy");
			expect(ids).not.toContain("personality");
			expect(result.systemPrompt.join("\n")).not.toContain("Ship the app");
		});
	});

	it("attributing append parts leaves the prompt bytes unchanged", async () => {
		await inEmptyHome(async cwd => {
			const parts = [
				{ id: "memory", kind: "append" as const, label: "Memory", text: "# Memory\nRecall first." },
				{ id: "mcp-server:docs", kind: "append" as const, label: "docs", text: "### docs\nCite pages." },
			];
			const attributed = await buildSystemPrompt(
				options(cwd, { appendPromptParts: parts, resolvedAppendSystemPrompt: "Operator note." }),
			);
			const composed = await buildSystemPrompt(
				options(cwd, {
					resolvedAppendSystemPrompt: composeAppendPrompt(
						parts.map(part => part.text),
						"Operator note.",
					),
				}),
			);
			expect(attributed.systemPrompt).toEqual(composed.systemPrompt);
		});
	});
});

describe("SystemPromptManifestLog", () => {
	const build = (blocks: string[]): BuildSystemPromptResult => ({
		systemPrompt: blocks,
		manifest: { template: { kind: "bundled" }, tools: [], gates: [], sources: [], unlocated: [] },
	});

	it("describes a live prompt that starts with a recorded build, counting blocks added after it", () => {
		const log = new SystemPromptManifestLog();
		log.record(build(["static", "project"]));
		expect(log.describe(["static", "project", "memory recall"])?.builtBlocks).toBe(2);
	});

	it("matches an older build when a newer one was abandoned", () => {
		const log = new SystemPromptManifestLog();
		log.record(build(["static", "old project"]));
		log.record(build(["static", "new project"]));
		expect(log.describe(["static", "old project"])?.builtBlocks).toBe(2);
	});

	it("has no manifest for a prompt an extension replaced", () => {
		const log = new SystemPromptManifestLog();
		log.record(build(["static", "project"]));
		expect(log.describe(["replaced by a before_agent_start hook"])).toBeNull();
	});
});
