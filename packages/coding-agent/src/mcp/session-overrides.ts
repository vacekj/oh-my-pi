/** Process-local server switches supplied by an embedding host. They never
 * rewrite user or project configuration. One RPC child owns one session. */
export type McpSessionOverrides = Record<string, boolean>;

export function parseMcpSessionOverrides(value: unknown): McpSessionOverrides {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP overrides must be an object");
	const entries = Object.entries(value);
	if (entries.length > 256) throw new Error("Too many MCP overrides");
	const result: McpSessionOverrides = {};
	for (const [name, enabled] of entries) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || typeof enabled !== "boolean") {
			throw new Error("Invalid MCP override");
		}
		Object.defineProperty(result, name, { value: enabled, enumerable: true, configurable: true, writable: true });
	}
	return result;
}

let overrides = parseMcpSessionOverrides(JSON.parse(process.env.OMP_MCP_SESSION_OVERRIDES ?? "{}"));

export function getMcpSessionOverrides(): McpSessionOverrides {
	return { ...overrides };
}

export function setMcpSessionOverrides(value: unknown): void {
	overrides = parseMcpSessionOverrides(value);
}
