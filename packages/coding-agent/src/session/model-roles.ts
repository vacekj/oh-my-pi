/**
 * Session-local model role assignments (`modelRoles`): role id -> omp selector
 * string, including an optional reasoning suffix (`provider/model:high`).
 *
 * The map an RPC client sends replaces the session's previous assignments
 * outright. It is applied to a session-local `Settings.overlay`, so an empty
 * map clears the local assignments and resolution falls back to the shared
 * configuration without writing it.
 */

const MAX_ROLES = 100;
const MAX_ROLE_ID = 100;
const MAX_SELECTOR = 500;
/** Whitespace and control characters never belong to a role name or selector. */
const FORBIDDEN_TOKEN = /[\s\u0000-\u001f\u007f]/;

/** A role name or selector: bounded, non-empty, no whitespace/control characters, no leading dash. */
function validToken(value: string, max: number): boolean {
	return value.length > 0 && value.length <= max && !value.startsWith("-") && !FORBIDDEN_TOKEN.test(value);
}

/** Parse and validate a role assignment map; an empty map is valid (it clears local assignments). */
export function parseSessionModelRoles(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model roles");
	const entries = Object.entries(value);
	if (entries.length > MAX_ROLES) throw new Error(`Use at most ${MAX_ROLES} model roles`);
	const result: Record<string, string> = {};
	for (const [role, selector] of entries) {
		if (!validToken(role, MAX_ROLE_ID)) throw new Error("Invalid model role name");
		if (typeof selector !== "string" || !validToken(selector, MAX_SELECTOR))
			throw new Error(`Invalid model selector for role "${role}"`);
		result[role] = selector;
	}
	return result;
}

/** The role assignments a spawned or resumed session starts with, from `OMP_SESSION_MODEL_ROLES`. */
export function sessionModelRolesFromEnv(
	env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
	const raw = env.OMP_SESSION_MODEL_ROLES;
	if (!raw) return {};
	return parseSessionModelRoles(JSON.parse(raw));
}
