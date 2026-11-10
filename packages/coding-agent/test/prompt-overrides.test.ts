import { describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import { __resetDirsFromEnvForTests, TempDir } from "@oh-my-pi/pi-utils";
import {
	type BuildSystemPromptOptions,
	type BuildSystemPromptResult,
	buildSystemPrompt,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import type { PromptSection } from "@oh-my-pi/pi-coding-agent/system-prompt-sources";
import { restoreEnvValue } from "./helpers/settings-test-state";

/** Runs with an empty HOME and agent dir, so no real SYSTEM.md, PERSONALITY.md or skills leak in. */
async function inEmptyHome<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	using tempDir = TempDir.createSync("@omp-prompt-overrides-");
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

function section(result: BuildSystemPromptResult, id: string): PromptSection | undefined {
	return result.manifest?.sections.find(entry => entry.id === id);
}

function textOf(result: BuildSystemPromptResult, id: string): string | undefined {
	const located = result.manifest?.sources.find(entry => entry.id === id);
	return located && result.systemPrompt[located.block].slice(located.start, located.end);
}

function promptText(result: BuildSystemPromptResult): string {
	return result.systemPrompt.join("\n");
}

describe("session prompt text overrides", () => {
	it("replaces a template section's text and keeps its declaration metadata", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				options(cwd, {
					promptOverrides: {
						"template:role/engineering": "Session engineering rules.",
					},
				}),
			);
			const replaced = section(result, "template:role/engineering");
			expect(replaced?.replacement).toEqual({ kind: "session", setting: "promptOverrides" });
			expect(replaced?.title).toBe("Engineering");
			expect(replaced?.origin?.file).toBe("src/prompts/system/system-prompt.md");
			expect(promptText(result)).toContain("Session engineering rules.");
			expect(promptText(result)).not.toContain("# Engineering");
			expect(result.manifest?.overrides).toEqual({
				"template:role/engineering": "Session engineering rules.",
			});
			// Untouched siblings keep their declared text.
			expect(promptText(result)).toContain("You are omp's trusted coding assistant.");
		});
	});

	it("replaces a parent's whole body, so its children are no longer in the tree", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				options(cwd, { promptOverrides: { "template:runtime": "Session runtime." } }),
			);
			expect(promptText(result)).toContain("Session runtime.");
			expect(section(result, "template:runtime")?.replacement).toBeDefined();
			expect(section(result, "template:runtime/skills-rules")).toBeUndefined();
			expect(section(result, "template:runtime/skills")).toBeUndefined();
			expect(promptText(result)).not.toContain("Matching skill");
		});
	});

	it("replaces attributed input sections (context file, personality, tools) without losing their source", async () => {
		await inEmptyHome(async cwd => {
			const contextPath = `${cwd}/AGENTS.md`;
			const result = await buildSystemPrompt(
				options(cwd, {
					contextFiles: [{ path: contextPath, content: "# House rules\n\nUse tabs.", depth: 0, level: "project" }],
					personality: "pragmatic",
					optionSettings: { personality: "personality" },
					promptOverrides: {
						[`context-file:${contextPath}`]: "Session house rules.",
						personality: "Session persona.",
						tools: "Session tool list.",
					},
				}),
			);

			const context = section(result, `context-file:${contextPath}`);
			expect(context?.replacement).toBeDefined();
			expect(context?.source?.path).toBe(contextPath);
			expect(textOf(result, `context-file:${contextPath}`)).toBe("Session house rules.");

			const personality = section(result, "personality");
			expect(personality?.replacement).toBeDefined();
			expect(personality?.source).toMatchObject({ setting: "personality", value: "pragmatic" });
			expect(promptText(result)).toContain("Session persona.");
			expect(promptText(result)).toContain("Session house rules.");
			expect(promptText(result)).not.toContain("Use tabs.");

			const tools = section(result, "tools");
			expect(tools?.replacement).toBeDefined();
			expect(promptText(result)).toContain("Session tool list.");
			expect(promptText(result)).not.toContain("# Tool Inventory");
			expect(section(result, "tool:read")).toBeUndefined();
			expect(section(result, "tool:bash")).toBeUndefined();
		});
	});

	it("honours an empty replacement as a deliberate empty section", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(options(cwd, { promptOverrides: { "template:role/engineering": "" } }));
			const replaced = section(result, "template:role/engineering");
			expect(replaced?.replacement).toBeDefined();
			expect(replaced?.start).toBe(replaced?.end);
			expect(promptText(result)).not.toContain("# Engineering");
			expect(result.manifest?.overrides).toEqual({ "template:role/engineering": "" });
		});
	});

	it("lets the filter win over an override and reports the replacement on the excluded ref", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				options(cwd, {
					promptFilter: { mode: "exclude", ids: ["template:role"] },
					promptOverrides: { "template:role": "Never rendered." },
				}),
			);
			expect(promptText(result)).not.toContain("Never rendered.");
			expect(section(result, "template:role")).toBeUndefined();
			expect(result.manifest?.excluded).toContainEqual(
				expect.objectContaining({
					id: "template:role",
					replacement: { kind: "session", setting: "promptOverrides" },
				}),
			);
		});
	});

	it("applies to sections declared by a custom template, including a template without sections", async () => {
		await inEmptyHome(async cwd => {
			const sectioned = await buildSystemPrompt(
				options(cwd, {
					systemPromptTemplate: '{{#section "custom" title="Custom"}}Declared custom text.{{/section}}',
					promptOverrides: { "template:custom": "Session custom text." },
				}),
			);
			expect(promptText(sectioned)).toContain("Session custom text.");
			expect(promptText(sectioned)).not.toContain("Declared custom text.");
			expect(section(sectioned, "template:custom")?.replacement).toBeDefined();

			const whole = await buildSystemPrompt(
				options(cwd, {
					systemPromptTemplate: "Declared whole template.",
					promptOverrides: { "template:root": "Session whole template." },
				}),
			);
			// The override replaces block 0's template only; the project-context
			// block is a separate build block and keeps its own text.
			expect(whole.systemPrompt[0]).toBe("Session whole template.");
			const root = section(whole, "template:root");
			expect(root?.replacement).toBeDefined();
			expect(whole.systemPrompt[root!.block].slice(root!.start, root!.end)).toBe("Session whole template.");
			expect(whole.systemPrompt.some(block => block.includes("<project-context>"))).toBe(true);
			expect(promptText(whole)).not.toContain("Declared whole template.");
		});
	});

	it("replaces loose template text and its numbered stretches reported as sections", async () => {
		await inEmptyHome(async cwd => {
			const template = [
				"Opening loose.",
				'{{#section "first" title="First"}}First section.{{/section}}',
				"Middle loose.",
				'{{#section "second" title="Second"}}Second section.{{/section}}',
				"Closing loose.",
			].join("\n");
			const declared = await buildSystemPrompt(options(cwd, { systemPromptTemplate: template }));
			expect(section(declared, "template:text")).toBeDefined();
			expect(section(declared, "template:text/2")).toBeDefined();

			const result = await buildSystemPrompt(
				options(cwd, {
					systemPromptTemplate: template,
					promptOverrides: {
						"template:text": "Replaced opening.",
						"template:text/2": "Replaced middle.",
					},
				}),
			);
			const opening = section(result, "template:text")!;
			const middle = section(result, "template:text/2")!;
			expect(result.systemPrompt[opening.block].slice(opening.start, opening.end)).toBe("Replaced opening.");
			expect(result.systemPrompt[middle.block].slice(middle.start, middle.end)).toBe("Replaced middle.");
			expect(opening.replacement).toEqual({ kind: "session", setting: "promptOverrides" });
			expect(middle.replacement).toEqual({ kind: "session", setting: "promptOverrides" });
			expect(promptText(result)).not.toContain("Opening loose.");
			expect(promptText(result)).not.toContain("Middle loose.");
			expect(promptText(result)).toContain("Closing loose.");
			expect(result.manifest?.overrides).toEqual({
				"template:text": "Replaced opening.",
				"template:text/2": "Replaced middle.",
			});
		});
	});

	it("replaces an advertised eval-prelude block and reports its provenance", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				options(cwd, {
					evalPreludes: [{ name: "browser", guidance: "Browser guidance." }],
					promptOverrides: { "eval-prelude:browser": "Session browser guidance." },
				}),
			);
			const prelude = section(result, "eval-prelude:browser");
			expect(prelude?.replacement).toEqual({ kind: "session", setting: "promptOverrides" });
			expect(prelude).toBeDefined();
			expect(result.systemPrompt[prelude!.block].slice(prelude!.start, prelude!.end)).toBe(
				"Session browser guidance.",
			);
			expect(promptText(result)).not.toContain("Browser guidance.");
			expect(promptText(result)).toContain("Session browser guidance.");
		});
	});

	it("keeps a named zero-width section when a whole-template replacement is empty", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				options(cwd, {
					systemPromptTemplate: "Declared whole template.",
					promptOverrides: { "template:root": "" },
				}),
			);
			const root = section(result, "template:root");
			expect(root).toBeDefined();
			expect(root?.replacement).toEqual({ kind: "session", setting: "promptOverrides" });
			expect(root?.start).toBe(root?.end);
			expect(promptText(result)).not.toContain("Declared whole template.");

			const kept = await buildSystemPrompt(
				options(cwd, {
					systemPromptTemplate: "Declared whole template.",
					promptFilter: { mode: "only", ids: ["template:root"] },
					promptOverrides: { "template:root": "" },
				}),
			);
			expect(kept.systemPrompt[0]).toBe("");
			const keptRoot = section(kept, "template:root");
			expect(keptRoot?.replacement).toEqual({ kind: "session", setting: "promptOverrides" });
			expect(keptRoot?.start).toBe(keptRoot?.end);
		});
	});

	it("keeps the prompt and the manifest free of replacement metadata when no override is set", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(options(cwd));
			expect(result.manifest?.overrides).toBeUndefined();
			expect(result.manifest?.sections.every(entry => entry.replacement === undefined)).toBe(true);
			expect(result.manifest?.sources.every(entry => !("replacement" in entry))).toBe(true);
		});
	});
});
