export interface SessionPromptSection {
	title: string;
	text: string;
	enabled: boolean;
}

export function parseSessionPromptSections(value: unknown): SessionPromptSection[] {
	if (!Array.isArray(value) || value.length > 16) throw new Error("Use at most 16 prompt sections");
	let length = 0;
	const result = value.map(section => {
		if (
			!section ||
			typeof section !== "object" ||
			typeof section.title !== "string" ||
			section.title.length > 100 ||
			typeof section.text !== "string" ||
			typeof section.enabled !== "boolean"
		)
			throw new Error("Invalid prompt section");
		length += section.text.length;
		return { title: section.title, text: section.text, enabled: section.enabled };
	});
	if (length > 50_000) throw new Error("Prompt sections are too large");
	return result;
}

let sections = parseSessionPromptSections(JSON.parse(process.env.OMP_SESSION_PROMPT_SECTIONS ?? "[]"));
export function setSessionPromptSections(value: unknown): void {
	sections = parseSessionPromptSections(value);
}
export function getSessionPromptParts(): string[] {
	return sections.filter(section => section.enabled && section.text.trim()).map(section => section.text);
}
