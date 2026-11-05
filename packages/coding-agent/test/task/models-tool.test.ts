import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	cfgTaskModelAccess,
	cfgTaskPerCallModel,
	cfgTaskPerCallModelAllow,
} from "@oh-my-pi/pi-coding-agent/task/settings";
import { resolveEffectiveSubagentPolicy } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ModelsTool } from "@oh-my-pi/pi-coding-agent/tools/models";
import { TempDir } from "@oh-my-pi/pi-utils";

let temp: TempDir;
let auth: AuthStorage;
let settings: Settings;
let session: ToolSession;
const first = createMockModel({ id: "alpha" });
const second = createMockModel({ id: "beta" });
const unavailable = createMockModel({ id: "missing" });

beforeEach(async () => {
	temp = TempDir.createSync("models-tool-");
	auth = await AuthStorage.create(":memory:");
	settings = Settings.isolated({
		"task.perCallModel": "on",
		"task.modelAccess": "available",
		"task.defaultModel": "mock/beta",
		"task.maxRecursionDepth": 2,
	});
	const registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
	vi.spyOn(registry, "getAll").mockReturnValue([first, second, unavailable]);
	vi.spyOn(registry, "getAvailable").mockReturnValue([first, second]);
	vi.spyOn(registry, "awaitBackgroundRefresh").mockResolvedValue();
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [{ name: "task", description: "Worker", systemPrompt: "Work", source: "bundled", model: ["@task"] }],
		projectAgentsDir: null,
	});
	session = {
		cwd: temp.path(),
		settings,
		modelRegistry: registry,
		hasUI: false,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
	} as unknown as ToolSession;
});

afterEach(() => {
	vi.restoreAllMocks();
	auth.close();
	temp.removeSync();
});

async function listing(params: Parameters<ModelsTool["execute"]>[1] = {}) {
	const result = await new ModelsTool(session).execute("models", params);
	const text = result.content.find(block => block.type === "text");
	if (!text || text.type !== "text") throw new Error("No model listing");
	return JSON.parse(text.text);
}

it("pages exact selectors and reports the same default and choices dispatch uses", async () => {
	const page = await listing({ query: "mock/", limit: 1 });
	expect(page.defaultModel).toBe("mock/beta");
	expect(page.models.map((model: { selector: string }) => model.selector)).toEqual(["mock/alpha"]);
	expect(page.nextOffset).toBe(1);
	const next = await listing({ offset: page.nextOffset, limit: 1 });
	expect(next.models.map((model: { selector: string }) => model.selector)).toEqual(["mock/beta"]);
	expect(next.nextOffset).toBeNull();
	const policy = await resolveEffectiveSubagentPolicy({
		session,
		invocationKind: "task",
		assignment: "Work",
		perCallModel: page.models[0].selector,
	});
	expect(policy.modelOverride).toEqual(["mock/alpha"]);
});

it("reflects policy changes and unavailable entries rather than advertising stale grants", async () => {
	expect((await listing({ query: "alpha" })).models[0].selectable).toBe(true);
	cfgTaskPerCallModelAllow.override(settings, ["mock/beta"]);
	const denied = (await listing({ query: "alpha" })).models[0];
	expect(denied.selectable).toBe(false);
	expect(denied.reason).toContain("task.perCallModelAllow");
	cfgTaskPerCallModelAllow.override(settings, []);
	cfgTaskModelAccess.override(settings, "approved");
	expect((await listing({ query: "alpha" })).models[0].selectable).toBe(false);
	const missing = (await listing({ query: "missing", includeUnavailable: true })).models[0];
	expect(missing.available).toBe(false);
	expect(missing.selectable).toBe(false);
	expect(missing.reason).toContain("not an available chat model");
});

it("distinguishes task from eval permission", async () => {
	cfgTaskPerCallModel.override(settings, "eval");
	expect((await listing({ query: "alpha" })).models[0].selectable).toBe(false);
	expect((await listing({ query: "alpha", invocation: "eval" })).models[0].selectable).toBe(true);
});

it("does not offer overrides for a user-tagged model and effort", async () => {
	session.getSessionAgents = () => [
		{
			name: "m1",
			description: "Tagged worker",
			systemPrompt: "Work",
			source: "bundled",
			model: ["mock/beta:high"],
			thinkingLevel: Effort.High,
		},
	];
	const result = await listing({ agent: "m1", query: "alpha" });
	expect(result.models[0].selectable).toBe(false);
	expect(result.models[0].reason).toContain("tag fixes");
	await expect(
		resolveEffectiveSubagentPolicy({
			session,
			agent: "m1",
			invocationKind: "task",
			assignment: "Work",
			perCallModel: "mock/alpha",
		}),
	).rejects.toThrow("tag");
});
