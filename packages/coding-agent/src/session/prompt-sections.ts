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
