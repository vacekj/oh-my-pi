/**
 * Approval for the per-call `model` selector on task items, eval `agent()` and
 * `workpool()`.
 *
 * Operator settings choose configured grants or all available chat models.
 * Settings.grantAuthority excludes project and subagent-injected layers,
 * which may narrow access but cannot grant it. The exact per-call allowlist
 * applies in both modes. Availability and credentials are checked separately.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelString,
	formatModelStringWithRouting,
	type ModelMatchPreferences,
	normalizeModelPatternList,
	resolveExplicitModelRole,
	resolveModelOverride,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { isKindRole } from "../config/model-roles";
import type { Settings } from "../config/settings";
import {
	availableSubagentModelsEnabled,
	cfgTaskDefaultModel,
	cfgTaskDisabledAgents,
	cfgTaskPerCallModelAllow,
} from "./settings";

/** A per-call model request could not be dispatched or restored. */
export class PerCallModelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PerCallModelError";
	}
}

/** The per-call model is not an available chat model, so no grant applies. */
export class PerCallModelUnavailableError extends PerCallModelError {
	constructor(message: string) {
		super(message);
		this.name = "PerCallModelUnavailableError";
	}
}

/**
 * Inputs that grant per-call models; nothing here is persisted as a grant. `settings` is read live,
 * so configuration changes apply to the next request: its grant authority grants, while its own
 * merged view (project and subagent-injected layers included) can only narrow. Spawn snapshots the
 * agent, parent model and match preferences; cold revival snapshots the agent and preferences but
 * reads the live parent on each request.
 */
export interface PerCallModelGrants {
	settings: Settings;
	agentName: string;
	agentSource?: AgentSource;
	/** The selected agent's frontmatter `model`. */
	agentModel?: string | string[];
	/** The selected agent is no longer discovered (cold revival): its frontmatter grants nothing. */
	agentRemoved?: boolean;
	/** The parent's model at spawn, or its live model on each cold-revival request, including any `@upstream` pin. */
	parentModelPattern?: string;
	/** Spawn-time selector preferences; unrelated later model usage cannot change a grant. */
	matchPreferences?: ModelMatchPreferences;
}

type ApprovalRegistry = Pick<ModelRegistry, "getAll" | "getAvailable">;

/**
 * The one model an exact entry names: a literal catalog id wins over a `:level`
 * split, and an `@upstream` pin stays part of the identity. Undefined when the
 * entry is not an exact selector in the full catalog, including unavailable models.
 */
function exactIdentity(entry: string, catalog: Model<Api>[]): string | undefined {
	const model = resolveModelOverride([entry], { getAvailable: () => catalog }, undefined, { exactOnly: true }).model;
	return model ? formatModelStringWithRouting(model) : undefined;
}

/** A parent only grants a route that an exact selector can represent without discarding routing policy. */
export function parentModelGrantPattern(model: Model<Api>): string | undefined {
	const selector = formatModelStringWithRouting(model);
	const compat = model.compat;
	if (!compat || typeof compat !== "object") return selector;
	for (const key of ["openRouterRouting", "vercelGatewayRouting"] as const) {
		const routing: unknown = (compat as Readonly<Record<string, unknown>>)[key];
		if (routing === undefined) continue;
		if (
			!routing ||
			typeof routing !== "object" ||
			Object.keys(routing).length !== 1 ||
			!("only" in routing) ||
			!Array.isArray(routing.only) ||
			routing.only.length !== 1 ||
			typeof routing.only[0] !== "string" ||
			!routing.only[0] ||
			selector !== `${formatModelString(model)}@${routing.only[0]}`
		) {
			return undefined;
		}
	}
	return selector;
}

/**
 * Operator-configured selectors that grant a per-call model. Role aliases are
 * skipped rather than expanded: a configured role's value is a grant of its
 * own, and an unconfigured role would only route through built-in defaults.
 */
function modelGrantPatterns(source: string | string[] | undefined, settings: Settings): string[] {
	const patterns = new Set<string>();
	for (const pattern of normalizeModelPatternList(source)) {
		const bare = pattern.toLowerCase();
		if (bare === "default" || bare === "inherit" || resolveExplicitModelRole(pattern, settings)) continue;
		patterns.add(pattern);
	}
	return [...patterns];
}

function configuredRoleGrantPatterns(settings: Settings): { role: string; patterns: string[] }[] {
	return Object.entries(settings.getModelRoles()).flatMap(([role, value]) => {
		if (isKindRole(role)) return [];
		const patterns = modelGrantPatterns(value, settings);
		return patterns.length > 0 ? [{ role, patterns }] : [];
	});
}

/** The allowlist compares canonical identities literally; it never resolves or case-folds entries. */
function allowlistAdmitsIdentity(allow: string[], identity: string): boolean {
	return allow.length === 0 || allow.some(entry => entry.trim() === identity);
}

/**
 * The operator's allowlist and the live one, which includes project and subagent-injected layers.
 * A model must satisfy both, so a project list can narrow the operator's but never replace it.
 */
function perCallAllowlists(settings: Settings): [operator: string[], live: string[]] {
	return [cfgTaskPerCallModelAllow.get(settings.grantAuthority()), cfgTaskPerCallModelAllow.get(settings)];
}

function allowlistsAdmitIdentity(allowlists: string[][], identity: string): boolean {
	return allowlists.every(allow => allowlistAdmitsIdentity(allow, identity));
}

/** Resolve a non-exact grant using the captured selection preferences. */
function resolveGrantPattern(
	pattern: string,
	chat: Model<Api>[],
	catalog: Model<Api>[],
	matchPreferences?: ModelMatchPreferences,
) {
	const knownLiteralId = catalog.some(candidate => candidate.id === pattern);
	const candidates = knownLiteralId ? chat.filter(candidate => candidate.id === pattern) : chat;
	return resolveModelRoleValue(pattern, candidates, { matchPreferences });
}

/**
 * Inputs a cached approval result was computed from: the operator view, the live settings
 * revision, and the catalog snapshot (absent when the computation never read the catalog).
 */
interface ApprovalCacheKey {
	authority: Settings;
	revision: number;
	catalog?: Model<Api>[];
}

function isCurrent(cached: ApprovalCacheKey | undefined, settings: Settings, registry?: ApprovalRegistry): boolean {
	return (
		cached !== undefined &&
		cached.authority === settings.grantAuthority() &&
		cached.revision === settings.revision &&
		(cached.catalog === undefined || cached.catalog === registry?.getAll())
	);
}

function perCallModelGrantPatterns(grants: PerCallModelGrants): string[] {
	const settings = grants.settings.grantAuthority();
	const { agentName } = grants;
	// Live settings can disable an agent the operator left enabled, never the reverse.
	const trustedAgent =
		(grants.agentSource === "bundled" || grants.agentSource === "user") &&
		!grants.agentRemoved &&
		!cfgTaskDisabledAgents.get(settings).includes(agentName) &&
		!cfgTaskDisabledAgents.get(grants.settings).includes(agentName);
	return [
		...new Set([
			...configuredRoleGrantPatterns(settings).flatMap(({ patterns }) => patterns),
			...modelGrantPatterns(cfgTaskDefaultModel.get(settings), settings),
			...modelGrantPatterns(trustedAgent ? grants.agentModel : undefined, settings),
			...modelGrantPatterns(grants.parentModelPattern, settings),
		]),
	];
}

/** Whether the configuration grants this model; the caller has already checked chat availability. */
function computeGranted(
	model: Model<Api>,
	target: string,
	grants: PerCallModelGrants,
	chat: Model<Api>[],
	catalog: Model<Api>[],
): boolean {
	if (!allowlistsAdmitIdentity(perCallAllowlists(grants.settings), target)) return false;
	if (availableSubagentModelsEnabled(grants.settings)) return true;
	return perCallModelGrantPatterns(grants).some(pattern => {
		// Full-catalog literals win even when unavailable, so :low and [1m] never broaden a grant.
		const exact = exactIdentity(pattern, catalog);
		if (exact !== undefined) return exact === target;
		// A glob routes the role but never grants: the operator must name each per-call model.
		if (/[*?]/.test(pattern)) return false;
		const resolved = resolveGrantPattern(pattern, chat, catalog, grants.matchPreferences).model;
		return resolved !== undefined && formatModelStringWithRouting(resolved) === target;
	});
}

/**
 * Decisions per grants object for models found available, reused until the settings (including
 * disabled providers) or the catalog change. Like the spawn-time match preferences, a fuzzy role
 * value keeps its resolution meanwhile; a credential removed later fails the request itself.
 */
const decisionCache = new WeakMap<
	PerCallModelGrants,
	ApprovalCacheKey & { catalog: Model<Api>[]; decisions: Map<string, boolean> }
>();

/** Throw {@link PerCallModelError} unless `model` is an available chat model the configuration approves. */
export function assertPerCallModelApproved(
	model: Model<Api>,
	grants: PerCallModelGrants,
	registry: ApprovalRegistry,
): void {
	const target = formatModelStringWithRouting(model);
	const chat = registry.getAvailable("chat");
	if (!chat.some(candidate => candidate.provider === model.provider && candidate.id === model.id)) {
		throw new PerCallModelUnavailableError(`Per-call model ${target} is not an available chat model.`);
	}
	let cache = decisionCache.get(grants);
	if (!cache || !isCurrent(cache, grants.settings, registry)) {
		cache = {
			authority: grants.settings.grantAuthority(),
			revision: grants.settings.revision,
			catalog: registry.getAll(),
			decisions: new Map(),
		};
		decisionCache.set(grants, cache);
	}
	let granted = cache.decisions.get(target);
	if (granted === undefined) {
		granted = computeGranted(model, target, grants, chat, cache.catalog);
		cache.decisions.set(target, granted);
	}
	if (granted) return;
	const allowGuidance = perCallAllowlists(grants.settings).some(allow => allow.length > 0)
		? " It must also be listed in task.perCallModelAllow."
		: "";
	throw new PerCallModelError(
		`Per-call model ${target} is not approved for agent "${grants.agentName}" under task.modelAccess.${allowGuidance} Use the models tool to list selectable models and policy restrictions.`,
	);
}
