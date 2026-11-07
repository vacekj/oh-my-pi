import { describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import { __resetDirsFromEnvForTests, TempDir } from "@oh-my-pi/pi-utils";
import {
	type BuildSystemPromptOptions,
	type BuildSystemPromptResult,
	buildSystemPrompt,
	composeAppendPrompt,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import {
	type PromptFilter,
	type PromptSection,
	SystemPromptManifestLog,
	type SystemPromptSource,
} from "@oh-my-pi/pi-coding-agent/system-prompt-sources";
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
		manifest: {
			template: { kind: "bundled" },
			tools: [],
			gates: [],
			sources: [],
			unlocated: [],
			sections: [],
			filter: { mode: "exclude", ids: [] },
			excluded: [],
		},
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

const TEMPLATE_DIR = new URL("../src/prompts/system/", import.meta.url);
const ALL_TOOLS = [
	"read",
	"edit",
	"write",
	"bash",
	"find",
	"grep",
	"glob",
	"lsp",
	"ast_grep",
	"ast_edit",
	"task",
	"todo",
	"ask",
	"think",
];

/** The text of a section, sliced from the block it lives in. */
function sectionText(result: BuildSystemPromptResult, section: PromptSection): string {
	return result.systemPrompt[section.block].slice(section.start, section.end);
}

/** A block with one section cut out. */
function sectionless(result: BuildSystemPromptResult, section: PromptSection): string {
	const block = result.systemPrompt[section.block];
	return block.slice(0, section.start) + block.slice(section.end);
}

/**
 * The contract every build must meet: sections form a tree, and the top-level
 * sections of every block tile it, so no non-whitespace text is unattributed.
 */
function expectSectionInvariants(result: BuildSystemPromptResult): PromptSection[] {
	const sections = result.manifest?.sections ?? [];
	const byId = new Map<string, PromptSection>();
	sections.forEach((section, index) => {
		// An input a custom template renders in both blocks appears once per block.
		expect(byId.get(section.id)?.block === section.block).toBe(false);
		byId.set(section.id, section);
		expect(section.block).toBeGreaterThanOrEqual(0);
		expect(section.block).toBeLessThan(result.systemPrompt.length);
		expect(section.start).toBeLessThan(section.end);
		expect(section.end).toBeLessThanOrEqual(result.systemPrompt[section.block].length);
		if (section.parent !== null) {
			const parent = byId.get(section.parent);
			// Parents come before their children and contain them.
			expect(parent).toBeDefined();
			expect(parent?.block).toBe(section.block);
			expect(section.start).toBeGreaterThanOrEqual(parent!.start);
			expect(section.end).toBeLessThanOrEqual(parent!.end);
		}
		expect(index).toBe(sections.indexOf(section));
	});
	// Siblings do not overlap.
	const siblings = new Map<string, PromptSection[]>();
	for (const section of sections) {
		const key = `${section.block}:${section.parent}`;
		siblings.set(key, [...(siblings.get(key) ?? []), section]);
	}
	for (const group of siblings.values()) {
		const ordered = [...group].sort((a, b) => a.start - b.start);
		for (let i = 1; i < ordered.length; i++) expect(ordered[i].start).toBeGreaterThanOrEqual(ordered[i - 1].end);
	}
	// Top-level sections tile every block.
	result.systemPrompt.forEach((block, index) => {
		let cursor = 0;
		const top = sections.filter(section => section.block === index && section.parent === null);
		for (const section of top.sort((a, b) => a.start - b.start)) {
			expect(block.slice(cursor, section.start).trim()).toBe("");
			cursor = Math.max(cursor, section.end);
		}
		expect(block.slice(cursor).trim()).toBe("");
	});
	return sections;
}

describe("system prompt section manifest", () => {
	const builds: Array<[string, (cwd: string) => BuildSystemPromptOptions]> = [
		["tools on", cwd => options(cwd, { toolNames: ALL_TOOLS })],
		["tools off", cwd => options(cwd, { toolNames: [] })],
		["personality none", cwd => options(cwd, { personality: "none" })],
		["subagent", cwd => options(cwd, { subagent: true, toolNames: ["read", "task"] })],
		[
			"skills, rules and context files",
			cwd =>
				options(cwd, {
					toolNames: ["read", "bash"],
					skills: [SKILL],
					rules: [{ name: "style", description: "Keep it tidy", path: "/rules/style.md", globs: ["*.ts"] }],
					alwaysApplyRules: [{ name: "always", content: "Always do this.", path: "/rules/always.md" }],
					contextFiles: [{ path: `${cwd}/AGENTS.md`, content: CONTEXT_FILE, depth: 0, level: "project" }],
				}),
		],
		[
			"everything the project block can carry",
			cwd =>
				options(cwd, {
					toolNames: ALL_TOOLS,
					includeWorkspaceTree: true,
					workspaceTree: {
						rootPath: cwd,
						rendered: "src/\n  a.ts",
						truncated: true,
						totalLines: 2,
						agentsMdFiles: [],
					},
					additionalWorkspaceRoots: ["/elsewhere"],
					appendPromptParts: [{ id: "memory", kind: "append", label: "Memory", text: "# Memory\nRecall first." }],
					resolvedAppendSystemPrompt: "Operator note.",
					xdevTools: [{ name: "probe", summary: "a probe" }],
					xdevDocs: "probe docs",
					evalPreludes: [{ name: "browser", guidance: "Browser guidance." }],
					renderSvg: true,
					renderMermaid: true,
					autoGraph: true,
					reactions: true,
					secretsEnabled: true,
					eagerTasks: true,
					intentField: "intent",
					model: "provider/model",
				}),
		],
		[
			"custom prompt",
			cwd => options(cwd, { resolvedCustomPrompt: "You are custom.", skills: [SKILL], secretsEnabled: true }),
		],
		[
			"custom template without sections",
			cwd =>
				options(cwd, {
					systemPromptTemplate: "Hello {{#if skills.length}}skills{{/if}} {{model}}\nbye",
					model: "m",
				}),
		],
		[
			"custom template with sections and loose text",
			cwd =>
				options(cwd, {
					systemPromptTemplate: 'loose\n{{#section "mine" title="Mine"}}\ninside\n{{/section}}\ntrailing',
					systemPromptTemplatePath: "/home/me/SYSTEM.template.md",
				}),
		],
	];

	for (const [name, build] of builds) {
		it(`tiles every block and nests sections consistently: ${name}`, async () => {
			await inEmptyHome(async cwd => {
				const result = await buildSystemPrompt(build(cwd));
				const sections = expectSectionInvariants(result);
				expect(sections.length).toBeGreaterThan(0);
				// Inputs keep reporting their source, located where the sources list puts them.
				for (const source of result.manifest?.sources ?? []) {
					const section = sections.find(entry => entry.id === source.id && entry.block === source.block);
					expect(section).toMatchObject({ start: source.start, end: source.end, source: { id: source.id } });
				}
				expect(result.manifest?.unlocated).toEqual([]);
			});
		});
	}

	it("declares every template section in the template, with its line range", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				build(cwd, ALL_TOOLS, { xdevTools: [{ name: "probe", summary: "s" }], xdevDocs: "d", model: "m" }),
			);
			const templates = new Map<string, string[]>();
			const sections = (result.manifest?.sections ?? []).filter(section => section.kind === "template");
			expect(sections.length).toBeGreaterThan(30);
			for (const section of sections) {
				expect(section.origin).not.toBeNull();
				const origin = section.origin!;
				expect(section.id.startsWith("template:") || section.id === "tools").toBe(true);
				expect(origin.file.startsWith("src/prompts/system/")).toBe(true);
				if (!templates.has(origin.file)) {
					const text = await Bun.file(
						new URL(origin.file.replace("src/prompts/system/", ""), TEMPLATE_DIR),
					).text();
					templates.set(origin.file, text.split("\n"));
				}
				const lines = templates.get(origin.file)!;
				const declared = section.id === "tools" ? "tools" : section.id.slice("template:".length);
				expect(lines[origin.startLine - 1]).toContain(`{{#section "${declared}"`);
				expect(lines[origin.endLine - 1].trim()).toBe("{{/section}}");
				// The section's own title comes from the template, not from the rendered text.
				const title = /title="([^"]*)"/.exec(lines[origin.startLine - 1])?.[1] ?? "";
				expect(title).not.toBe("");
				expect(section.title).toBe(title);
			}
		});
	});

	it("places each section by its marker even when the same text appears elsewhere", async () => {
		await inEmptyHome(async cwd => {
			// A context file spells the project block's own headings; the sections still start at the real ones.
			const result = await buildSystemPrompt(
				options(cwd, {
					contextFiles: [
						{
							path: `${cwd}/AGENTS.md`,
							content: "<critical>\n- Each response MUST advance the task;\n</critical>",
							depth: 0,
						},
					],
				}),
			);
			const critical = result.manifest?.sections.find(section => section.id === "template:project/critical");
			const file = result.manifest?.sections.find(section => section.id === `context-file:${cwd}/AGENTS.md`);
			expect(critical && file && critical.start > file.end).toBe(true);
			expect(sectionText(result, critical!).startsWith("<critical>\n- Each response MUST advance the task;")).toBe(
				true,
			);
			expect(sectionText(result, critical!)).toContain("completion only stopping condition");
		});
	});

	it("reports the conditionals directly around a section, with the setting they read", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				options(cwd, {
					toolNames: ["read", "think"],
					personality: "pragmatic",
					optionSettings: { personality: "personality" },
				}),
			);
			const find = (id: string) => result.manifest?.sections.find(section => section.id === id);
			expect(find("template:role/personality")?.gates).toEqual([
				{ name: "personality", value: "true", setting: "personality" },
			]);
			expect(find("template:scratchpad")?.gates).toEqual([{ name: 'tools has "think"', value: "true" }]);
			expect(find("template:tool-policy/general")?.gates).toEqual([]);
			expect(find("template:workflow/verify")?.gates).toEqual([{ name: "not subagent", value: "true" }]);
		});
	});

	it("reports the template block's file for a user template, and one section for a template that declares none", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				options(cwd, {
					systemPromptTemplate: "Hello {{model}}\nbye",
					systemPromptTemplatePath: "/home/me/SYSTEM.template.md",
					model: "m",
				}),
			);
			const root = result.manifest?.sections.find(section => section.id === "template:root");
			expect(root?.origin).toEqual({ file: "/home/me/SYSTEM.template.md", startLine: 1, endLine: 2 });
			expect(sectionText(result, root!)).toBe("Hello m\nbye");
			expect(root?.parent).toBeNull();
		});
	});

	it("gives text outside a template's declared sections a section of its own", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				options(cwd, {
					systemPromptTemplate: 'loose\n{{#section "mine" title="Mine"}}\ninside\n{{/section}}\ntrailing',
				}),
			);
			const sections = result.manifest?.sections.filter(section => section.block === 0) ?? [];
			expect(sections.map(section => [section.id, sectionText(result, section)])).toEqual([
				["template:text", "loose"],
				["template:mine", "inside"],
				["template:text/2", "trailing"],
			]);
		});
	});
});

function build(cwd: string, toolNames: string[], overrides: Partial<BuildSystemPromptOptions> = {}) {
	return options(cwd, { toolNames, ...overrides });
}

describe("system prompt filter", () => {
	it("excluding a parent removes its text and everything inside it, and lists it as excluded", async () => {
		await inEmptyHome(async cwd => {
			const full = await buildSystemPrompt(build(cwd, ALL_TOOLS));
			const filtered = await buildSystemPrompt(
				build(cwd, ALL_TOOLS, { promptFilter: { mode: "exclude", ids: ["template:tool-policy"] } }),
			);
			const policy = full.manifest?.sections.find(section => section.id === "template:tool-policy");
			expect(full.systemPrompt[0]).toContain("⁂ Tool Policy");
			expect(filtered.systemPrompt[0]).not.toContain("⁂ Tool Policy");
			expect(filtered.systemPrompt[0]).not.toContain("# Delegation");
			expect(filtered.systemPrompt[0]).toContain("⁂ Workflow");
			const squash = (text: string) => text.replace(/\s+/g, " ");
			expect(squash(filtered.systemPrompt[0])).toBe(squash(sectionless(full, policy!)));
			const ids = filtered.manifest?.sections.map(section => section.id) ?? [];
			expect(ids.some(id => id.startsWith("template:tool-policy"))).toBe(false);
			expect(filtered.manifest?.filter).toEqual({ mode: "exclude", ids: ["template:tool-policy"] });
			expect(filtered.manifest?.excluded.map(ref => ref.id)).toEqual(["template:tool-policy"]);
			expect(filtered.manifest?.excluded[0]).toMatchObject({
				title: "Tool policy",
				kind: "template",
				origin: { file: "src/prompts/system/system-prompt.md" },
			});
			expectSectionInvariants(filtered);
		});
	});

	it("excluding an input drops it from the template data, so its list item vanishes too", async () => {
		await inEmptyHome(async cwd => {
			const other = { ...SKILL, name: "review", description: "Check the diff", filePath: "/skills/review/SKILL.md" };
			const filtered = await buildSystemPrompt(
				build(cwd, ["read"], { skills: [SKILL, other], promptFilter: { mode: "exclude", ids: ["skill:deploy"] } }),
			);
			expect(filtered.systemPrompt[0]).not.toContain("deploy");
			expect(filtered.systemPrompt[0]).toContain("- review: Check the diff");
			expect(filtered.manifest?.excluded.map(ref => ref.id)).toEqual(["skill:deploy"]);
			expect(filtered.manifest?.excluded[0].parent).toBe("template:runtime/skills");

			// Dropping the last skill takes its section and the heading's reason with it.
			const none = await buildSystemPrompt(
				build(cwd, ["read"], { skills: [SKILL], promptFilter: { mode: "exclude", ids: ["skill:deploy"] } }),
			);
			expect(none.systemPrompt[0]).not.toContain("Matching skill");
			expect(none.systemPrompt[0]).not.toContain("# Skills & Rules");
		});
	});

	it("excluding a context file removes its wrapper and its mention", async () => {
		await inEmptyHome(async cwd => {
			const filtered = await buildSystemPrompt(
				build(cwd, ["read"], {
					contextFiles: [{ path: `${cwd}/AGENTS.md`, content: CONTEXT_FILE, depth: 0 }],
					promptFilter: { mode: "exclude", ids: [`context-file:${cwd}/AGENTS.md`] },
				}),
			);
			expect(filtered.systemPrompt.join("\n")).not.toContain("House rules");
			expect(filtered.systemPrompt.join("\n")).not.toContain("<repo-rules>");
			expect(filtered.systemPrompt.join("\n")).not.toContain("Context files above auto-loaded");
		});
	});

	it("only with no ids gives an empty prompt, and still says what it removed", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				build(cwd, ALL_TOOLS, {
					skills: [SKILL],
					appendPromptParts: [{ id: "memory", kind: "append", label: "Memory", text: "Recall." }],
					evalPreludes: [{ name: "browser", guidance: "Browser guidance." }],
					promptFilter: { mode: "only", ids: [] },
				}),
			);
			expect(result.systemPrompt).toEqual([]);
			expect(result.manifest?.sections).toEqual([]);
			expect(result.manifest?.filter).toEqual({ mode: "only", ids: [] });
			const excluded = result.manifest?.excluded.map(ref => ref.id) ?? [];
			expect(excluded).toContain("template:role");
			expect(excluded).toContain("tools");
			expect(excluded).toContain("eval-prelude:browser");
			expect(excluded).toContain("template:project/context");
		});
	});

	it("only with no ids empties a custom prompt and a template without sections too", async () => {
		await inEmptyHome(async cwd => {
			for (const overrides of [
				{ resolvedCustomPrompt: "You are custom." },
				{ systemPromptTemplate: "Hello {{model}}", model: "m" },
			]) {
				const result = await buildSystemPrompt(
					options(cwd, { ...overrides, promptFilter: { mode: "only", ids: [] } }),
				);
				expect(result.systemPrompt).toEqual([]);
			}
		});
	});

	describe("template text outside declared sections", () => {
		const template = 'loose\n{{#section "mine" title="Mine"}}\ninside\n{{/section}}\ntrailing';
		const filtered = (cwd: string, promptFilter: PromptFilter) =>
			buildSystemPrompt(options(cwd, { systemPromptTemplate: template, promptFilter }));
		/** What the filter removed from the custom template; the bundled project block is not what these tests are about. */
		const excludedTemplateIds = (result: BuildSystemPromptResult) =>
			(result.manifest?.excluded ?? []).map(ref => ref.id).filter(id => !id.startsWith("template:project/"));
		const templateSections = (result: BuildSystemPromptResult) =>
			expectSectionInvariants(result).filter(section => section.block === 0);

		it("only with no ids empties a template with declared sections and says what it removed", async () => {
			await inEmptyHome(async cwd => {
				const result = await filtered(cwd, { mode: "only", ids: [] });
				expect(result.systemPrompt).toEqual([]);
				expect(result.manifest?.sections).toEqual([]);
				expect(excludedTemplateIds(result)).toEqual(["template:text", "template:mine", "template:text/2"]);
			});
		});

		it("excluding the first stretch removes only that text", async () => {
			await inEmptyHome(async cwd => {
				const result = await filtered(cwd, { mode: "exclude", ids: ["template:text"] });
				expect(result.systemPrompt[0]).toBe("inside\ntrailing");
				expect(templateSections(result).map(section => [section.id, sectionText(result, section)])).toEqual([
					["template:mine", "inside"],
					["template:text/2", "trailing"],
				]);
				expect(excludedTemplateIds(result)).toEqual(["template:text"]);
			});
		});

		it("keeps the other stretches' ids when a section between them is excluded", async () => {
			await inEmptyHome(async cwd => {
				const result = await filtered(cwd, { mode: "exclude", ids: ["template:mine"] });
				expect(result.systemPrompt[0]).toBe("loose\ntrailing");
				expect(templateSections(result).map(section => section.id)).toEqual(["template:text", "template:text/2"]);
				const trailing = await filtered(cwd, { mode: "exclude", ids: ["template:mine", "template:text/2"] });
				expect(trailing.systemPrompt[0]).toBe("loose");
				expect(templateSections(trailing).map(section => section.id)).toEqual(["template:text"]);
			});
		});

		it("only a declared section drops the text around it", async () => {
			await inEmptyHome(async cwd => {
				const result = await filtered(cwd, { mode: "only", ids: ["template:mine"] });
				expect(result.systemPrompt).toEqual(["inside"]);
				expect(excludedTemplateIds(result)).toEqual(["template:text", "template:text/2"]);
			});
		});

		it("only a stretch of text keeps that text alone", async () => {
			await inEmptyHome(async cwd => {
				const result = await filtered(cwd, { mode: "only", ids: ["template:text/2"] });
				expect(result.systemPrompt).toEqual(["trailing"]);
				expectSectionInvariants(result);
			});
		});

		it("treats an input in loose text as part of the stretch holding it", async () => {
			await inEmptyHome(async cwd => {
				const withModel = {
					systemPromptTemplate: 'Model {{model}}\n{{#section "mine" title="Mine"}}\ninside\n{{/section}}',
					model: "m",
				};
				const plain = await buildSystemPrompt(options(cwd, withModel));
				const input = plain.manifest?.sections.find(section => section.id === "model" && section.block === 0);
				expect(input?.parent).toBe("template:text");
				const result = await buildSystemPrompt(
					options(cwd, { ...withModel, promptFilter: { mode: "exclude", ids: ["template:text"] } }),
				);
				expect(result.systemPrompt[0]).toBe("inside");
				expect(excludedTemplateIds(result)).toEqual(["template:text"]);
			});
		});
	});

	it("only the tools section lists the active tools and nothing else of substance", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				build(cwd, ALL_TOOLS, { skills: [SKILL], promptFilter: { mode: "only", ids: ["tools"] } }),
			);
			expect(result.systemPrompt).toHaveLength(1);
			expect(result.systemPrompt[0]).toBe(
				["# Tool Inventory", ...ALL_TOOLS.map(name => `- \`${name}\``)].join("\n"),
			);
			const sections = expectSectionInvariants(result);
			expect(sections.filter(section => section.parent === null).map(section => section.id)).toEqual(["tools"]);
			expect(sections.filter(section => section.kind === "tool").map(section => section.id)).toEqual(
				ALL_TOOLS.map(name => `tool:${name}`),
			);
		});
	});

	it("only a nested section renders the sections around it with their own text, and drops its siblings", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				build(cwd, ALL_TOOLS, { promptFilter: { mode: "only", ids: ["template:tool-policy/exploration"] } }),
			);
			expect(result.systemPrompt).toHaveLength(1);
			expect(result.systemPrompt[0]).toMatch(/^⁂ Tool Policy\n# Exploration\nNEVER open guessed files\./);
			expect(result.systemPrompt[0]).not.toContain("# General");
			expect(result.systemPrompt[0]).not.toContain("⁂ Workflow");
			const ids = expectSectionInvariants(result).map(section => section.id);
			expect(ids).toEqual(["template:tool-policy", "template:tool-policy/exploration"]);
			expect(result.manifest?.excluded.map(ref => ref.id)).toContain("template:tool-policy/general");
		});
	});

	it("only an input keeps the section around it and drops the other inputs of that section", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				build(cwd, ["read", "bash"], { promptFilter: { mode: "only", ids: ["tool:bash"] } }),
			);
			expect(result.systemPrompt).toEqual(["# Tool Inventory\n- `bash`"]);
		});
	});

	it("keeps the other blocks of an only filter that names them", async () => {
		await inEmptyHome(async cwd => {
			const result = await buildSystemPrompt(
				build(cwd, ["read"], {
					evalPreludes: [{ name: "browser", guidance: "Browser guidance." }],
					promptFilter: { mode: "only", ids: ["eval-prelude:browser", "template:project/critical"] },
				}),
			);
			expect(result.systemPrompt).toHaveLength(2);
			expect(result.systemPrompt[0]).toBe("Browser guidance.");
			expect(result.systemPrompt[1]).toMatch(/^<critical>\n- Each response/);
			expect(result.systemPrompt[1]).not.toContain("<workstation>");
			expectSectionInvariants(result);
		});
	});

	it("does not change an unfiltered prompt's bytes", async () => {
		await inEmptyHome(async cwd => {
			const plain = await buildSystemPrompt(build(cwd, ALL_TOOLS));
			const explicit = await buildSystemPrompt(
				build(cwd, ALL_TOOLS, { promptFilter: { mode: "exclude", ids: [] } }),
			);
			expect(explicit.systemPrompt).toEqual(plain.systemPrompt);
			expect(plain.manifest?.excluded).toEqual([]);
		});
	});
});

describe("SystemPromptManifestLog sections of later blocks", () => {
	const build = (blocks: string[]): BuildSystemPromptResult => ({
		systemPrompt: blocks,
		manifest: {
			template: { kind: "bundled" },
			tools: [],
			gates: [],
			sources: [],
			unlocated: [],
			sections: [
				{
					id: "template:x",
					parent: null,
					title: "X",
					kind: "template",
					block: 0,
					start: 0,
					end: 6,
					origin: null,
					gates: [],
				},
			],
			filter: { mode: "exclude", ids: [] },
			excluded: [],
		},
	});

	it("reports session sections, the memory recall and unknown blocks as top-level sections that tile their blocks", () => {
		const log = new SystemPromptManifestLog();
		log.record(build(["static"]));
		const live = ["static", "  Terse.\n", "<recall>\n", "added by something else"];
		const described = log.describe(live, [
			{ id: "session-section:1", kind: "session-section", title: "Style", text: "  Terse.\n" },
			{ id: "memory-recall", kind: "memory-recall", title: "Memory recall", text: "<recall>\n" },
		]);
		expect(described?.sections.slice(1)).toEqual([
			{
				id: "session-section:1",
				parent: null,
				title: "Style",
				kind: "session-section",
				block: 1,
				start: 2,
				end: 8,
				origin: null,
				gates: [],
			},
			{
				id: "memory-recall",
				parent: null,
				title: "Memory recall",
				kind: "memory-recall",
				block: 2,
				start: 0,
				end: 8,
				origin: null,
				gates: [],
			},
			{
				id: "appended-block:3",
				parent: null,
				title: "Appended block",
				kind: "append",
				block: 3,
				start: 0,
				end: 23,
				origin: null,
				gates: [],
			},
		]);
		expect(described?.builtBlocks).toBe(1);
	});

	it("lists the blocks the filter kept out after the build's own excluded sections, without sections of their own", () => {
		const log = new SystemPromptManifestLog();
		const base = build(["static"]);
		base.manifest!.excluded = [{ id: "template:role", parent: null, title: "Role", kind: "template", origin: null }];
		log.record(base);
		const described = log.describe(
			["static"],
			[],
			[
				{ id: "session-section:0", kind: "session-section", title: "Style" },
				{ id: "memory-recall", kind: "memory-recall", title: "Memory recall" },
			],
		);
		expect(described?.excluded).toEqual([
			{ id: "template:role", parent: null, title: "Role", kind: "template", origin: null },
			{ id: "session-section:0", parent: null, title: "Style", kind: "session-section", origin: null },
			{ id: "memory-recall", parent: null, title: "Memory recall", kind: "memory-recall", origin: null },
		]);
		expect(described?.sections.map(section => section.id)).toEqual(["template:x"]);
	});
});
