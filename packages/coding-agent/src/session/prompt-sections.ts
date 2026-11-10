import {
	type AppendedPromptBlock,
	NO_PROMPT_FILTER,
	type PromptFilter,
	promptFilterDrops,
	type RemovedPromptBlock,
} from "../system-prompt-sources";

export interface SessionPromptSection {
	title: string;
	text: string;
	enabled: boolean;
}

const MAX_SECTIONS = 16;
const MAX_TITLE = 100;
const MAX_TEXT = 50_000;
const MAX_FILTER_IDS = 1000;
const MAX_ID = 2000;
const MAX_OVERRIDES = 256;
/** One replacement text, the bound prompt sections already use. */
const MAX_OVERRIDE_ENTRY_TEXT = 50_000;
/** Total size of every replacement text of one session. */
const MAX_OVERRIDE_TEXT = 200_000;

/** Accepts plain text, or `{ title, text }` with an optional `enabled` (default on). */
export function parseSessionPromptSections(value: unknown): SessionPromptSection[] {
	if (!Array.isArray(value) || value.length > MAX_SECTIONS) throw new Error("Use at most 16 prompt sections");
	let length = 0;
	const result = value.map((section): SessionPromptSection => {
		if (typeof section === "string") {
			length += section.length;
			return { title: "", text: section, enabled: true };
		}
		if (
			!section ||
			typeof section !== "object" ||
			typeof section.title !== "string" ||
			section.title.length > MAX_TITLE ||
			typeof section.text !== "string" ||
			(section.enabled !== undefined && typeof section.enabled !== "boolean")
		)
			throw new Error("Invalid prompt section");
		length += section.text.length;
		return { title: section.title, text: section.text, enabled: section.enabled ?? true };
	});
	if (length > MAX_TEXT) throw new Error("Prompt sections are too large");
	return result;
}

export function parsePromptFilter(value: unknown): PromptFilter {
	if (
		!value ||
		typeof value !== "object" ||
		!("mode" in value) ||
		(value.mode !== "exclude" && value.mode !== "only") ||
		!("ids" in value) ||
		!Array.isArray(value.ids) ||
		value.ids.length > MAX_FILTER_IDS ||
		value.ids.some(id => typeof id !== "string" || id.length > MAX_ID)
	)
		throw new Error("Invalid prompt filter");
	return { mode: value.mode, ids: [...new Set<string>(value.ids)] };
}

let sections = parseSessionPromptSections(JSON.parse(process.env.OMP_SESSION_PROMPT_SECTIONS ?? "[]"));
export function setSessionPromptSections(value: unknown): void {
	sections = parseSessionPromptSections(value);
}

/**
 * Session text replacements by section id. An empty string is a deliberate
 * replacement (the section renders empty); removing the entry restores the
 * declared text. Each replacement is bounded like a prompt section.
 */
export function parsePromptOverrides(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid prompt overrides");
	const entries = Object.entries(value);
	if (entries.length > MAX_OVERRIDES) throw new Error(`Use at most ${MAX_OVERRIDES} prompt overrides`);
	let length = 0;
	const result: Record<string, string> = {};
	for (const [id, text] of entries) {
		if (typeof text !== "string") throw new Error("Invalid prompt override");
		if (!id || id.length > MAX_ID) throw new Error("Invalid prompt override id");
		if (text.length > MAX_OVERRIDE_ENTRY_TEXT) throw new Error("Prompt override is too large");
		length += text.length;
		result[id] = text;
	}
	if (length > MAX_OVERRIDE_TEXT) throw new Error("Prompt overrides are too large");
	return result;
}

let overrides = parsePromptOverrides(JSON.parse(process.env.OMP_SESSION_PROMPT_OVERRIDES ?? "{}"));
export function getSessionPromptOverrides(): Readonly<Record<string, string>> {
	return { ...overrides };
}
export function setSessionPromptOverrides(value: unknown): Record<string, string> {
	overrides = parsePromptOverrides(value);
	return { ...overrides };
}

let filter: PromptFilter = process.env.OMP_SESSION_PROMPT_FILTER
	? parsePromptFilter(JSON.parse(process.env.OMP_SESSION_PROMPT_FILTER))
	: NO_PROMPT_FILTER;
export function getSessionPromptFilter(): PromptFilter {
	return filter;
}
export function setSessionPromptFilter(value: unknown): PromptFilter {
	filter = parsePromptFilter(value);
	return filter;
}

/** Whether the session's filter removes a section that is not part of a build (session sections, the memory recall). */
export function isSessionPromptSectionDropped(id: string): boolean {
	return promptFilterDrops(filter, [])(id);
}

/** The enabled session sections, filtered or not, in the order they are appended to the prompt. */
function enabledSessionPromptBlocks(): AppendedPromptBlock[] {
	return sections.flatMap((section, index): AppendedPromptBlock[] => {
		if (!section.enabled || !section.text.trim()) return [];
		return [
			{
				id: `session-section:${index}`,
				kind: "session-section",
				title: section.title || `Session section ${index + 1}`,
				text: section.text,
			},
		];
	});
}

/** The enabled session sections the filter keeps, in the order they are appended to the prompt. */
export function getSessionPromptBlocks(): AppendedPromptBlock[] {
	return enabledSessionPromptBlocks().filter(block => !isSessionPromptSectionDropped(block.id));
}

/** The enabled session sections the filter removes. */
export function getRemovedSessionPromptBlocks(): RemovedPromptBlock[] {
	return enabledSessionPromptBlocks()
		.filter(block => isSessionPromptSectionDropped(block.id))
		.map(({ id, kind, title }) => ({ id, kind, title }));
}
