import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getEffectiveTokenCost, getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import { assertModelSupportsEffortCeiling } from "@oh-my-pi/pi-tui/thinking";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatModelStringWithRouting, getModelMatchPreferences, resolveModelOverride } from "../config/model-resolver";
import modelsDescription from "../prompts/tools/models.md" with { type: "text" };
import { assertPerCallModelApproved, parentModelGrantPattern, type PerCallModelGrants } from "../task/model-approval";
import { availableSubagentModelsEnabled, cfgTaskMaxEffort, perCallModelEnabled } from "../task/settings";
import { resolveEffectiveSubagentPolicy } from "../task/structured-subagent";
import type { ToolSession } from ".";
import { throwIfAborted } from "./tool-errors";

const schema = type({
	"query?": "string",
	"agent?": "string",
	"invocation?": "'task' | 'eval'",
	"includeUnavailable?": "boolean",
	"offset?": "number.integer >= 0",
	"limit?": "1 <= number.integer <= 100",
});
type Params = typeof schema.infer;

/** Reads the live catalog and uses the dispatch policy without starting a worker. */
export class ModelsTool implements AgentTool<typeof schema> {
	readonly name = "models";
	readonly label = "Models";
	readonly approval = "read" as const;
	readonly description = modelsDescription;
	readonly summary = "List live subagent models, defaults, reasoning levels, pricing, and selection restrictions";
	readonly parameters = schema;
	readonly strict = false;
	readonly loadMode = "essential" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: Params, signal?: AbortSignal): Promise<AgentToolResult> {
		throwIfAborted(signal);
		const registry = this.session.modelRegistry;
		if (!registry) throw new ToolError("Model discovery is unavailable in this session.");
		await registry.awaitBackgroundRefresh();
		const invocationKind = params.invocation ?? "task";
		const policy = await resolveEffectiveSubagentPolicy({
			session: this.session,
			invocationKind,
			agent: params.agent,
			assignment: "",
		});
		throwIfAborted(signal);
		const parentModel = this.session.getActiveModel?.();
		const grants: PerCallModelGrants = {
			settings: this.session.settings,
			agentName: policy.agentName,
			agentSource: policy.agent.source,
			agentModel: policy.agent.model,
			parentModelPattern: parentModel ? parentModelGrantPattern(parentModel) : this.session.getActiveModelString?.(),
			matchPreferences: getModelMatchPreferences(this.session.settings.grantAuthority()),
		};
		const enabled = perCallModelEnabled(this.session.settings, invocationKind);
		const maxEffort = cfgTaskMaxEffort.get(this.session.settings);
		const available = registry.getAvailable("chat");
		const availableIds = new Set(available.map(model => formatModelStringWithRouting(model)));
		const query = params.query?.trim().toLowerCase() ?? "";
		const candidates = (params.includeUnavailable ? registry.getAll() : available)
			.filter(model => !query || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query))
			.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
		const offset = params.offset ?? 0;
		const limit = params.limit ?? 50;
		const models = candidates.slice(offset, offset + limit).map(model => {
			const selector = formatModelStringWithRouting(model);
			let reason: string | null = null;
			try {
				if (!enabled) throw new Error(`Per-call model selection is disabled for ${invocationKind}.`);
				if (policy.userTaggedEffort)
					throw new Error(
						"The user's model:level tag fixes this agent's model and effort. Omit model when spawning it.",
					);
				assertPerCallModelApproved(model, grants, registry);
				assertModelSupportsEffortCeiling(model, maxEffort);
			} catch (error) {
				reason = error instanceof Error ? error.message : String(error);
			}
			return {
				selector,
				name: model.name,
				available: availableIds.has(selector),
				selectable: reason === null,
				reason,
				thinking: model.thinking ? getSupportedEfforts(model) : [],
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				input: model.input,
				cost: getEffectiveTokenCost(model.cost),
				pricingStatus: getModelPricingStatus(model),
			};
		});
		const resolved = resolveModelOverride(policy.modelOverride ?? [], registry, this.session.settings);
		const details = {
			agent: policy.agentName,
			invocation: invocationKind,
			modelAccess: availableSubagentModelsEnabled(this.session.settings) ? "available" : "approved",
			perCallModelEnabled: enabled,
			maxEffort,
			defaultModel: resolved.model
				? `${formatModelStringWithRouting(resolved.model)}${resolved.explicitThinkingLevel && resolved.thinkingLevel ? `:${resolved.thinkingLevel}` : ""}`
				: null,
			defaultPatterns: policy.modelOverride,
			models,
			total: candidates.length,
			nextOffset: offset + models.length < candidates.length ? offset + models.length : null,
		};
		return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
	}
}
