import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("session-local model roles", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
		tempDir = TempDir.createSync("@pi-session-model-roles-");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		delete process.env.OMP_SESSION_MODEL_ROLES;
	});

	function openDirectSession(
		settings: Settings,
		agentKind: "main" | "sub" = "main",
		initialModel: Model = model,
	): AgentSession {
		const agent = new Agent({
			initialState: { model: initialModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
			agentKind,
			advisorTools: [],
		});
		sessions.push(session);
		return session;
	}

	async function openSession(settings: Settings): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			authStorage,
			modelRegistry,
			settings,
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(session);
		return session;
	}

	it("keeps overrides local to one session and leaves the shared settings untouched", async () => {
		const settings = Settings.isolated({ "async.enabled": false });
		settings.setModelRole("judge", "anthropic/claude-sonnet-4-5");
		const first = await openSession(settings);
		const second = await openSession(settings);
		const modelBefore = first.model?.id;

		expect(first.modelRoleOverrides).toEqual({});
		expect(first.modelRoles).toEqual({ judge: "anthropic/claude-sonnet-4-5" });
		expect(second.modelRoles).toEqual({ judge: "anthropic/claude-sonnet-4-5" });

		first.setModelRoles({ task: "anthropic/claude-sonnet-4-5:high" });

		expect(first.modelRoleOverrides).toEqual({ task: "anthropic/claude-sonnet-4-5:high" });
		expect(first.modelRoles).toEqual({
			judge: "anthropic/claude-sonnet-4-5",
			task: "anthropic/claude-sonnet-4-5:high",
		});
		// The main model is not switched by a role assignment.
		expect(first.model?.id).toBe(modelBefore);
		// Shared settings and the sibling session never see the assignment.
		expect(settings.getModelRole("task")).toBeUndefined();
		expect(second.modelRoleOverrides).toEqual({});
		expect(second.modelRoles).toEqual({ judge: "anthropic/claude-sonnet-4-5" });
		expect(second.modelRoleSettings.getModelRole("task")).toBeUndefined();

		first.setModelRoles({});
		expect(first.modelRoleOverrides).toEqual({});
		expect(first.modelRoles).toEqual({ judge: "anthropic/claude-sonnet-4-5" });
	});

	it("hands the session role overlay to child subagent settings, live", () => {
		const settings = Settings.isolated({ "async.enabled": false });
		const session = openDirectSession(settings);
		session.setModelRoles({
			task: "anthropic/claude-sonnet-4-5:high",
			advisor: "openai/gpt-4o-mini",
		});

		// What the task tool builds for a child: inherited through the parent's
		// session overlay, not the shared settings.
		const child = createSubagentSettings(session.modelRoleSettings, {});
		expect(child.getModelRole("task")).toBe("anthropic/claude-sonnet-4-5:high");
		expect(child.getModelRole("advisor")).toBe("openai/gpt-4o-mini");
		expect(settings.getModelRole("task")).toBeUndefined();

		// A later assignment reaches the already-built child view: it reads
		// through to the live overlay, so spawns and revives see the edit.
		session.setModelRoles({ task: "anthropic/claude-sonnet-4-5:low" });
		expect(child.getModelRole("task")).toBe("anthropic/claude-sonnet-4-5:low");
		expect(child.getModelRole("advisor")).toBeUndefined();
	});

	it("reconciles the live advisor when set_model_roles changes the advisor role", async () => {
		const settings = Settings.isolated({ "advisor.enabled": true, "compaction.enabled": false });
		const replacement = getBundledModel("openai", "gpt-4o-mini");
		if (!replacement) throw new Error("Expected built-in OpenAI model to exist");
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const session = openDirectSession(settings);

		session.setModelRoles({ advisor: `${replacement.provider}/${replacement.id}` });
		expect(session.setAdvisorEnabled(true)).toBe(true);
		expect(session.getAdvisorAgent()?.state.model.provider).toBe(replacement.provider);
		expect(session.getAdvisorAgent()?.state.model.id).toBe(replacement.id);

		// A live role assignment reconciles the advisor before the call returns,
		// so consumers never observe the stale runtime.
		session.setModelRoles({ advisor: "anthropic/claude-sonnet-4-5" });
		expect(session.getAdvisorAgent()?.state.model.provider).toBe("anthropic");
		expect(session.getAdvisorAgent()?.state.model.id).toBe("claude-sonnet-4-5");
		// The coalesced settings listener must not undo the synchronous reconcile.
		await Promise.resolve();
		expect(session.getAdvisorAgent()?.state.model.provider).toBe("anthropic");
		expect(session.getAdvisorAgent()?.state.model.id).toBe("claude-sonnet-4-5");
	});

	it("does not seed OMP_SESSION_MODEL_ROLES into subagent sessions", () => {
		process.env.OMP_SESSION_MODEL_ROLES = JSON.stringify({ task: "anthropic/claude-sonnet-4-5:low" });
		const settings = Settings.isolated({ "async.enabled": false });
		const main = openDirectSession(settings, "main");
		const sub = openDirectSession(settings, "sub");

		expect(main.modelRoleOverrides).toEqual({ task: "anthropic/claude-sonnet-4-5:low" });
		// A child inherits live parent settings; it must not seed a stale launch
		// map that would shadow them and never see later edits.
		expect(sub.modelRoleOverrides).toEqual({});
		expect(sub.modelRoles.task).toBeUndefined();
	});

	it("seeds assignments from OMP_SESSION_MODEL_ROLES and lets an empty map clear them", async () => {
		process.env.OMP_SESSION_MODEL_ROLES = JSON.stringify({ task: "anthropic/claude-sonnet-4-5:low" });
		const settings = Settings.isolated({ "async.enabled": false });
		const session = await openSession(settings);

		expect(session.modelRoleOverrides).toEqual({ task: "anthropic/claude-sonnet-4-5:low" });
		expect(session.modelRoles).toEqual({ task: "anthropic/claude-sonnet-4-5:low" });
		expect(settings.getModelRole("task")).toBeUndefined();

		session.setModelRoles({});
		expect(session.modelRoleOverrides).toEqual({});
		expect(session.modelRoles).toEqual({});
	});
});
