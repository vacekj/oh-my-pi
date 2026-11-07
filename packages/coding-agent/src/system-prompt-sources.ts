/**
 * Source and section manifest for a built system prompt: which template
 * section or input produced which text.
 *
 * The prompt builder renders the templates twice: once plainly (the prompt the
 * model gets) and once tracking. The tracking render wraps every input value,
 * and every template section declared with `{{#section}}`, in private-use
 * marker characters. Formatting after the render only deletes whitespace, so
 * the non-whitespace characters of the marked render and of the final prompt
 * correspond one to one; counting them places each marker in the final text
 * exactly. Nothing is searched for in the prompt and nothing is parsed out of
 * it. A value or section a template conditional left out never emits markers.
 */
import { prompt } from "@oh-my-pi/pi-utils";

export type SystemPromptSourceKind =
	| "custom-prompt"
	| "system-md"
	| "personality"
	| "skill"
	| "always-apply-rule"
	| "rule"
	| "internal-url"
	| "tool"
	| "tool-inventory"
	| "xdev-docs"
	| "workstation"
	| "model"
	| "context-file"
	| "nested-context"
	| "workspace-tree"
	| "workspace-root"
	| "repo-context"
	| "append"
	| "user-append"
	| "eval-prelude";

/** What an input is and where it came from. */
export interface SystemPromptSourceInfo {
	/** Stable per input: the same input keeps its id across rebuilds (`context-file:<path>`, `skill:<name>`). */
	id: string;
	kind: SystemPromptSourceKind;
	label: string;
	/** File the text was read from. */
	path?: string;
	/** Discovery level of `path`. */
	level?: "user" | "project" | "native";
	/** Distance of a project context file from the cwd (0 = the cwd). */
	depth?: number;
	/** Discovery provider that loaded the file (e.g. "Claude Code", "OMP"). */
	provider?: string;
	/** Setting the input is controlled by. */
	setting?: string;
	/** That setting's value, when it selects between variants. */
	value?: string;
}

/** An input located in the prompt: `systemPrompt[block].slice(start, end)` is its text. */
export interface SystemPromptSource extends SystemPromptSourceInfo {
	block: number;
	start: number;
	end: number;
}

/** A template switch: a value the template's conditionals read. */
export interface SystemPromptGate {
	name: string;
	/** The value as text (`true`, `3`, `eager`). */
	value: string;
	/** Setting the value came from. */
	setting?: string;
}

/** Which sections a build keeps. Tool schemas sent to the provider are not affected. */
export type PromptFilter = { mode: "exclude"; ids: string[] } | { mode: "only"; ids: string[] };

export const NO_PROMPT_FILTER: PromptFilter = { mode: "exclude", ids: [] };

/** The well-known section that lists the active tools. */
export const TOOLS_SECTION_ID = "tools";

export type PromptSectionKind = "template" | SystemPromptSourceKind | "session-section" | "memory-recall";

/** Where a template section is declared. */
export interface PromptSectionOrigin {
	/** Path relative to the omp package for bundled templates; the template's own path otherwise. */
	file: string;
	/** 1-based, inclusive: the lines of the opening and closing `{{#section}}` tags and everything between. */
	startLine: number;
	endLine: number;
}

/** A template section or an input, located in `systemPrompt[block].slice(start, end)`. Children lie inside their parent. */
export interface PromptSection {
	/** Stable across rebuilds: `template:<path>`, `tools`, an input's source id, `session-section:<n>`, `memory-recall`. */
	id: string;
	parent: string | null;
	title: string;
	kind: PromptSectionKind;
	block: number;
	start: number;
	end: number;
	origin: PromptSectionOrigin | null;
	/** Inputs only: the same info as the matching `sources` entry. */
	source?: SystemPromptSourceInfo;
	/** The template conditionals directly around the section that held for it to render. */
	gates: SystemPromptGate[];
}

export type PromptSectionRef = Pick<PromptSection, "id" | "parent" | "title" | "kind" | "origin" | "source">;

export interface SystemPromptManifest {
	/** The template block 0 was rendered from. Text no source covers is that template's own. */
	template: {
		kind: "bundled" | "custom-prompt" | "template";
		/** Template or prompt file; absent for the bundled template and for literal text. */
		path?: string;
	};
	/** Active tool names, the inputs of the template's `{{#has tools …}}` sections. */
	tools: string[];
	gates: SystemPromptGate[];
	sources: SystemPromptSource[];
	/** Inputs that reached the prompt but could not be located. Locating is exact, so this stays empty. */
	unlocated: SystemPromptSourceInfo[];
	/** Template sections and inputs as a tree in prompt order, parents before children. */
	sections: PromptSection[];
	/** The filter this build applied. */
	filter: PromptFilter;
	/** Sections the filter removed (roots only). */
	excluded: PromptSectionRef[];
}

/** A generated block of the appended prompt (memory, MCP routes, …) and where it came from. */
export type AppendPromptPart = SystemPromptSourceInfo & { text: string };

/** A block added to a built prompt later, with the section it makes up. */
export interface AppendedPromptBlock {
	id: string;
	kind: "session-section" | "memory-recall";
	title: string;
	text: string;
}

/** A block the session filter kept out of the prompt: what would have been appended. */
export type RemovedPromptBlock = Pick<AppendedPromptBlock, "id" | "kind" | "title">;

/** A manifest matched to a live prompt. Blocks from `builtBlocks` on were added after the build. */
export interface SystemPromptDescription extends SystemPromptManifest {
	builtBlocks: number;
}

const MANIFEST_LOG_SIZE = 8;

/** Extent of a block's non-whitespace text, or null when the block is blank. */
function trimmedExtent(text: string): { start: number; end: number } | null {
	const start = text.search(/\S/);
	return start < 0 ? null : { start, end: text.trimEnd().length };
}

/** A section covering the non-whitespace text of one whole block. */
export function wholeBlockSection(
	block: number,
	text: string,
	section: Pick<PromptSection, "id" | "title" | "kind" | "source">,
): PromptSection | null {
	const extent = trimmedExtent(text);
	return (
		extent && {
			id: section.id,
			parent: null,
			title: section.title,
			kind: section.kind,
			block,
			...extent,
			origin: null,
			...(section.source ? { source: section.source } : {}),
			gates: [],
		}
	);
}

/**
 * Recent builds of one session. The agent's live prompt can be a build's
 * blocks plus blocks added later (a memory recall, session sections), an
 * extension's per-turn replacement, or an older build a newer one was
 * abandoned for, so the live prompt is matched against each recorded build
 * instead of assuming the last.
 */
export class SystemPromptManifestLog {
	readonly #builds: Array<{ blocks: readonly string[]; manifest: SystemPromptManifest }> = [];

	record(result: { systemPrompt: string[]; manifest?: SystemPromptManifest }): void {
		if (!result.manifest) return;
		this.#builds.push({ blocks: result.systemPrompt, manifest: result.manifest });
		if (this.#builds.length > MANIFEST_LOG_SIZE) this.#builds.shift();
	}

	/**
	 * `appended` names the blocks omp adds after a build; any other later block is reported as an unknown appended
	 * block. `removed` names the blocks the session filter kept out, listed as excluded after the build's own.
	 */
	describe(
		prompt: readonly string[],
		appended: readonly AppendedPromptBlock[] = [],
		removed: readonly RemovedPromptBlock[] = [],
	): SystemPromptDescription | null {
		for (let i = this.#builds.length - 1; i >= 0; i--) {
			const { blocks, manifest } = this.#builds[i];
			if (blocks.length <= prompt.length && blocks.every((block, index) => block === prompt[index])) {
				const unclaimed = [...appended];
				const sections = [...manifest.sections];
				for (let index = blocks.length; index < prompt.length; index++) {
					const claimed = unclaimed.findIndex(block => block.text === prompt[index]);
					const block = claimed >= 0 ? unclaimed.splice(claimed, 1)[0] : undefined;
					const section = wholeBlockSection(
						index,
						prompt[index],
						block ?? { id: `appended-block:${index}`, kind: "append", title: "Appended block" },
					);
					if (section) sections.push(section);
				}
				const excluded = [
					...manifest.excluded,
					...removed.map(({ id, kind, title }): PromptSectionRef => ({
						id,
						parent: null,
						title,
						kind,
						origin: null,
					})),
				];
				return { ...manifest, sections, excluded, builtBlocks: blocks.length };
			}
		}
		return null;
	}
}

// Unicode noncharacters: never part of interchanged text, so no input contains them.
const OPEN = "\uFDD0";
const CLOSE = "\uFDD1";
const SECTION_OPEN = "\uFDD2";
const SECTION_CLOSE = "\uFDD3";
/** Marker index characters: one private-use code unit per tracked value or section. */
const INDEX_BASE = 0xe100;
const INDEX_LIMIT = 0xf8ff - INDEX_BASE;
/** Index of a section marker that names no declaration: a section that rendered nothing or was removed, or whose declaration went unrecorded. */
const UNNAMED = String.fromCharCode(0xf8ff);

/** Template data key the `section` helper finds the marker under. */
export const SECTION_MARKER_KEY = "__sectionMarker";

/** A template section as declared, with everything the helper knew when it rendered. */
interface SectionDecl {
	id: string;
	title: string;
	origin: PromptSectionOrigin;
	gates: SystemPromptGate[];
}

export interface SourceMarkerOptions {
	/**
	 * Ids the filter removes: their sections render nothing, their input values
	 * are blank, and so is the template text outside every section when its id
	 * (see {@link SourceMarker.filterLooseText}) is removed. Given, the marker
	 * keeps a boundary marker for every section it renders so that text can be found.
	 */
	dropped?: (id: string) => boolean;
	/** Setting id by template data name, for the gates of sections. */
	gateSettings?: Readonly<Record<string, string>>;
}

/**
 * Produces the marked or plain variant of every tracked value, and wraps
 * template sections. `plain` returns values unchanged, so a template rendered
 * with it is the real prompt.
 */
export class SourceMarker {
	readonly #entries: SystemPromptSourceInfo[] | undefined;
	readonly #sections: SectionDecl[] | undefined;
	readonly #options: SourceMarkerOptions;
	/** Conditionals around each open section, to tell its own gates from its parent's. */
	readonly #open: number[] = [];
	#file = "";
	#declared = 0;

	private constructor(tracking: boolean, options: SourceMarkerOptions) {
		this.#entries = tracking ? [] : undefined;
		this.#sections = tracking ? [] : undefined;
		this.#options = options;
	}

	static plain(options: SourceMarkerOptions = {}): SourceMarker {
		return new SourceMarker(false, options);
	}

	static tracking(options: SourceMarkerOptions = {}): SourceMarker {
		return new SourceMarker(true, options);
	}

	get entries(): readonly SystemPromptSourceInfo[] {
		return this.#entries ?? [];
	}

	/** Whether the filter removes this section or input. */
	dropped(id: string): boolean {
		return this.#options.dropped?.(id) ?? false;
	}

	/** Starts rendering the template read from `file`: its sections report that origin. */
	beginTemplate(file: string): void {
		this.#file = file;
		this.#declared = 0;
	}

	/** Sections the template being rendered declared, kept or not. Zero means it has none. */
	get declaredSections(): number {
		return this.#declared;
	}

	/**
	 * Open and close markers for a value spanning several template fields (a
	 * skill's name through its description). Empty when not tracking, or when the
	 * marker budget is used up (the value then goes unreported).
	 */
	around(info: SystemPromptSourceInfo): [open: string, close: string] {
		const entries = this.#entries;
		if (!entries || entries.length >= INDEX_LIMIT) return ["", ""];
		const index = String.fromCharCode(INDEX_BASE + entries.length);
		entries.push(info);
		return [OPEN + index, CLOSE + index];
	}

	/**
	 * Wraps a whole value. Blank values stay as they are: templates and callers
	 * test them for content. A value the filter removes is blank.
	 */
	wrap(info: SystemPromptSourceInfo, text: string): string;
	wrap(info: SystemPromptSourceInfo, text: string | undefined): string | undefined;
	wrap(info: SystemPromptSourceInfo, text: string | undefined): string | undefined {
		if (this.dropped(info.id)) return "";
		if (!text?.trim()) return text;
		const [open, close] = this.around(info);
		return open + text + close;
	}

	/**
	 * The `{{#section}}` helper: renders a template section unless the filter
	 * removes it. A marker that tracks, or filters, wraps every section it is
	 * asked for in boundary markers, empty or removed ones included, so the text
	 * between sections stays the same whatever the filter removes.
	 */
	section(
		id: string,
		title: string,
		loc: { startLine: number; endLine: number } | undefined,
		enclosing: readonly prompt.EnclosingBlock[],
		render: () => string,
	): string {
		this.#declared++;
		const sections = this.#sections;
		const bounded = sections !== undefined || this.#options.dropped !== undefined;
		if (this.dropped(id)) return bounded ? SECTION_OPEN + UNNAMED + SECTION_CLOSE + UNNAMED : "";
		if (!sections) return bounded ? SECTION_OPEN + UNNAMED + render() + SECTION_CLOSE + UNNAMED : render();
		const ownGates = enclosing.slice(this.#open.at(-1) ?? 0);
		this.#open.push(enclosing.length);
		let body: string;
		try {
			body = render();
		} finally {
			this.#open.pop();
		}
		if (!stripMarkers(body).trim() || sections.length >= INDEX_LIMIT) {
			return SECTION_OPEN + UNNAMED + body + SECTION_CLOSE + UNNAMED;
		}
		const index = String.fromCharCode(INDEX_BASE + sections.length);
		sections.push({
			id,
			title,
			origin: { file: this.#file, startLine: loc?.startLine ?? 1, endLine: loc?.endLine ?? 1 },
			gates: ownGates.flatMap(block => gateOf(block, this.#options.gateSettings ?? {})),
		});
		return SECTION_OPEN + index + body + SECTION_CLOSE + index;
	}

	/**
	 * Removes the template text outside every top-level section that the filter
	 * removes. That text is split by the sections around it: the n-th stretch
	 * (counting the empty ones) is `textId` for the first and `<textId>/<n+1>`
	 * after it, so an id means the same text whatever else the filter removes.
	 * Needs the markers of a marker that tracks or filters. Text inside an
	 * input value belongs to the stretch holding the input.
	 */
	filterLooseText(marked: string, textId: string): string {
		if (this.#options.dropped === undefined) return marked;
		const kept: string[] = [];
		let depth = 0;
		let stretch = 0;
		let from = 0;
		const keepStretch = (to: number) => {
			const text = marked.slice(from, to);
			kept.push(stripMarkers(text).trim() === "" || !this.dropped(looseTextId(textId, stretch)) ? text : "");
		};
		for (let i = 0; i < marked.length; i++) {
			const code = marked.charCodeAt(i);
			if (code === 0xfdd2) {
				if (depth++ === 0) {
					keepStretch(i);
					from = i;
				}
				i++;
			} else if (code === 0xfdd3 && depth > 0) {
				i++;
				if (--depth === 0) {
					kept.push(marked.slice(from, i + 1));
					from = i + 1;
					stretch++;
				}
			} else if (code >= 0xfdd0 && code <= 0xfdd3) {
				i++;
			}
		}
		keepStretch(marked.length);
		return kept.join("");
	}

	/**
	 * A template that declares no sections is one section as a whole, so no text
	 * of it goes unattributed and a filter can remove it. `text` is the render
	 * before formatting, marked when tracking.
	 */
	wholeTemplate(id: string, title: string, lines: number, text: string): string {
		if (this.dropped(id)) return "";
		const sections = this.#sections;
		if (!sections || !stripMarkers(text).trim() || sections.length >= INDEX_LIMIT) return text;
		const index = String.fromCharCode(INDEX_BASE + sections.length);
		sections.push({ id, title, origin: { file: this.#file, startLine: 1, endLine: lines }, gates: [] });
		return SECTION_OPEN + index + text + SECTION_CLOSE + index;
	}

	/** Declaration of the section whose marker carries `index`. */
	sectionAt(index: number): SectionDecl | undefined {
		return this.#sections?.[index];
	}
}

/** Text of a gate's value: a scalar as it is, `true` for anything the conditional merely found present. */
function gateValue(value: unknown): string {
	return typeof value === "boolean" || typeof value === "number" ? String(value) : "true";
}

/** The gate an enclosing conditional puts on a section, or nothing for a block that is not one. */
function gateOf(block: prompt.EnclosingBlock, settings: Readonly<Record<string, string>>): SystemPromptGate[] {
	const texts = block.args.map(arg => arg.text);
	let name: string;
	let negated = block.branch === "inverse";
	let value = "true";
	switch (block.helper) {
		case "if":
		case "unless": {
			name = texts[0] ?? "";
			if (block.helper === "unless") negated = !negated;
			if (!negated && block.args.length === 1) value = gateValue(block.args[0].value);
			break;
		}
		case "has":
			name = `${texts[0]} has ${texts[1]}`;
			break;
		case "ifAny":
			name = texts.join(" or ");
			break;
		case "ifAll":
			name = texts.join(" and ");
			break;
		case "when":
			name = `${texts[0]} ${String(block.args[1]?.value)} ${texts[2]}`;
			break;
		default:
			return [];
	}
	const root = block.args.flatMap(arg => arg.roots).find(candidate => settings[candidate] !== undefined);
	return [
		{
			name: negated ? `not ${name}` : name,
			value: negated ? "true" : value,
			...(root !== undefined ? { setting: settings[root] } : {}),
		},
	];
}

prompt.registerHelper("section", function (this: unknown, ...args: unknown[]): string {
	const options = args.pop() as prompt.HelperOptions;
	const marker = (options.data.root as Record<string, unknown> | undefined)?.[SECTION_MARKER_KEY];
	if (!(marker instanceof SourceMarker)) return options.fn(this);
	const path = String(args[0] ?? "");
	return marker.section(
		typeof options.hash.id === "string" ? options.hash.id : `template:${path}`,
		typeof options.hash.title === "string" ? options.hash.title : path,
		options.loc,
		options.enclosing,
		() => options.fn(this),
	);
});

function stripMarkers(text: string): string {
	return text.replace(/[\uFDD0-\uFDD3][\uE100-\uF8FF]/g, "");
}

interface MarkedSpan {
	section: boolean;
	index: number;
	/** Index in the span list of the span this one is nested in, or -1. */
	parent: number;
	/** Count of non-whitespace characters before the opening and the closing marker. */
	nonWhitespaceStart: number;
	nonWhitespaceEnd: number;
}

const WHITESPACE = /\s/;

function isWhitespace(code: number): boolean {
	return code === 32 || (code >= 9 && code <= 13) || (code >= 128 && WHITESPACE.test(String.fromCharCode(code)));
}

/** A line with text in it: the count of non-whitespace characters before it, and how many it has. */
interface TextLine {
	start: number;
	count: number;
	/** A markdown table separator row, which formatting rewrites (`|----|` becomes `|---|`). */
	separator: boolean;
}

const TABLE_SEPARATOR = /^\|[-:\s|]+\|$/;

/** Markers of a render in order of their opening marker, nested as the render nested them. */
function scanMarked(marked: string): { spans: MarkedSpan[]; lines: TextLine[]; nonWhitespace: number } {
	const spans: MarkedSpan[] = [];
	const lines: TextLine[] = [];
	const open: number[] = [];
	let count = 0;
	let lineStart = 0;
	let lineCount = 0;
	const endLine = (end: number) => {
		if (lineCount === 0) return;
		const text = stripMarkers(marked.slice(lineStart, end)).trim();
		lines.push({ start: count - lineCount, count: lineCount, separator: TABLE_SEPARATOR.test(text) });
	};
	for (let i = 0; i < marked.length; i++) {
		const code = marked.charCodeAt(i);
		if (code >= 0xfdd0 && code <= 0xfdd3) {
			const section = code >= 0xfdd2;
			const index = marked.charCodeAt(++i) - INDEX_BASE;
			if (code === 0xfdd0 || code === 0xfdd2) {
				spans.push({
					section,
					index,
					parent: open.at(-1) ?? -1,
					nonWhitespaceStart: count,
					nonWhitespaceEnd: count,
				});
				open.push(spans.length - 1);
				continue;
			}
			const depth = open.findLastIndex(at => spans[at].section === section && spans[at].index === index);
			if (depth < 0) continue;
			for (let j = open.length - 1; j >= depth; j--) spans[open[j]].nonWhitespaceEnd = count;
			open.length = depth;
			continue;
		}
		if (code === 10) {
			endLine(i);
			lineStart = i + 1;
			lineCount = 0;
		} else if (!isWhitespace(code)) {
			count++;
			lineCount++;
		}
	}
	endLine(marked.length);
	return { spans, lines, nonWhitespace: count };
}

/** Describes the section or input a span marks, or nothing for a span that names none. */
function describeSpan(
	span: MarkedSpan,
	marker: SourceMarker,
): (PromptSectionRef & { gates: SystemPromptGate[] }) | undefined {
	if (span.section) {
		if (span.index === INDEX_LIMIT) return undefined;
		const decl = marker.sectionAt(span.index);
		if (!decl) throw new Error("Unknown section marker");
		return {
			id: decl.id,
			parent: null,
			title: decl.title,
			kind: "template",
			origin: decl.origin,
			gates: decl.gates,
		};
	}
	const info = marker.entries[span.index];
	if (!info) throw new Error("Unknown input marker");
	return { id: info.id, parent: null, title: info.label, kind: info.kind, origin: null, source: info, gates: [] };
}

/**
 * Id of the n-th stretch of template text outside every top-level section
 * (counting stretches between sections even when empty), the first being
 * `textId` itself. Matches {@link SourceMarker.filterLooseText}.
 */
function looseTextId(textId: string, stretch: number): string {
	return stretch === 0 ? textId : `${textId}/${stretch + 1}`;
}

/** The template a block was rendered from. */
export interface LocatedTemplate {
	file: string;
	lines: number;
	/** Id of the first stretch of the template's text outside its sections: `template:text`. */
	textId: string;
}

/**
 * Renders one block's template. A template that declares no sections is one
 * section as a whole (`whole`), and one that declares some has the text
 * outside them filtered like a section. Tracking returns the marked render
 * before formatting; otherwise the block the model gets.
 */
export function renderTemplate(
	marker: SourceMarker,
	template: string,
	data: prompt.TemplateContext,
	tracking: boolean,
	located: LocatedTemplate,
	whole?: { id: string; title: string },
): string {
	marker.beginTemplate(located.file);
	const text = prompt.compile(template)(data);
	const sectioned =
		marker.declaredSections === 0 && whole
			? marker.wholeTemplate(whole.id, whole.title, located.lines, text)
			: marker.filterLooseText(text, located.textId);
	return tracking ? sectioned : prompt.format(stripMarkers(sectioned), { renderPhase: "post-render" });
}

/** A section or input of a marked render, with its extent in counts of non-whitespace characters. */
interface PlacedSection {
	ref: PromptSectionRef;
	gates: SystemPromptGate[];
	parent: string | null;
	start: number;
	end: number;
}

/**
 * The sections and inputs a marked render contains, parents before children
 * and in prompt order. The template text outside every top-level section is a
 * section of its own, holding the inputs it contains.
 */
function placeSections(marked: string, marker: SourceMarker, template: LocatedTemplate): PlacedSection[] {
	const { spans, nonWhitespace } = scanMarked(marked);
	const loose: PlacedSection[] = [];
	const origin = { file: template.file, startLine: 1, endLine: template.lines };
	let from = 0;
	let stretch = 0;
	const addLoose = (to: number) => {
		if (to <= from) return;
		loose.push({
			ref: {
				id: looseTextId(template.textId, stretch),
				parent: null,
				title: "Template text",
				kind: "template",
				origin,
			},
			gates: [],
			parent: null,
			start: from,
			end: to,
		});
	};
	for (const span of spans) {
		if (!span.section || span.parent >= 0) continue;
		addLoose(span.nonWhitespaceStart);
		from = span.nonWhitespaceEnd;
		stretch++;
	}
	addLoose(nonWhitespace);

	const placed: PlacedSection[] = [...loose];
	const placedAt = new Map<number, PlacedSection>();
	spans.forEach((span, at) => {
		if (span.nonWhitespaceEnd <= span.nonWhitespaceStart) return;
		const described = describeSpan(span, marker);
		if (!described) return;
		let parent = span.parent;
		while (parent >= 0 && !placedAt.has(parent)) parent = spans[parent].parent;
		const { gates, ...ref } = described;
		const enclosing =
			parent >= 0
				? placedAt.get(parent)
				: span.section
					? undefined
					: loose.find(text => text.start <= span.nonWhitespaceStart && span.nonWhitespaceEnd <= text.end);
		const section: PlacedSection = {
			ref,
			gates,
			parent: enclosing?.ref.id ?? null,
			start: span.nonWhitespaceStart,
			end: span.nonWhitespaceEnd,
		};
		placed.push(section);
		placedAt.set(at, section);
	});
	// Stable: a section opened first stays before what it contains when both span the same text.
	return placed.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** The sections and inputs a marked render contains, as a tree: what a filter is resolved against. */
export function markedSections(marked: string, marker: SourceMarker, template: LocatedTemplate): PromptSectionRef[] {
	return placeSections(marked, marker, template).map(({ ref, parent }) => ({ ...ref, parent }));
}

/**
 * Which ids a filter removes, given the sections a build would render
 * unfiltered. `exclude` removes the listed ones and everything inside them.
 * `only` keeps the listed ones with everything inside them, and the ancestors
 * of those so they render their own text; it removes the rest.
 */
export function promptFilterDrops(
	filter: PromptFilter,
	tree: ReadonlyArray<Pick<PromptSectionRef, "id" | "parent">>,
): (id: string) => boolean {
	const listed = new Set(filter.ids);
	const parents = new Map(tree.map(node => [node.id, node.parent]));
	const within = (id: string, wanted: ReadonlySet<string>): boolean => {
		for (let at: string | null | undefined = id; at != null; at = parents.get(at)) {
			if (wanted.has(at)) return true;
		}
		return false;
	};
	if (filter.mode === "exclude") {
		if (listed.size === 0) return () => false;
		return id => within(id, listed);
	}
	const shown = new Set<string>();
	for (const { id } of tree) {
		if (!within(id, listed)) continue;
		for (let at: string | null | undefined = id; at != null && !shown.has(at); at = parents.get(at)) shown.add(at);
	}
	return id => !shown.has(id) && !listed.has(id);
}

/** The sections of `tree` the filter removed whose parent stays. */
export function droppedRoots(tree: readonly PromptSectionRef[], dropped: (id: string) => boolean): PromptSectionRef[] {
	return tree.filter(node => dropped(node.id) && (node.parent === null || !dropped(node.parent)));
}

export interface LocateResult {
	sources: SystemPromptSource[];
	unlocated: SystemPromptSourceInfo[];
	/** Sections and inputs of the located blocks in prompt order. */
	sections: PromptSection[];
}

/**
 * Where each non-whitespace character of the render stands in the final text.
 * Formatting only deletes whitespace, drops blank lines, and rewrites table
 * separator rows, so the lines with text in them correspond one to one, and
 * the characters of a line do too, except in a separator row (where a position
 * maps to the nearest end of the row).
 */
function finalPositions(final: string, lines: readonly TextLine[], nonWhitespace: number): number[] {
	const positions: number[] = [];
	const finalLines: Array<{ start: number; count: number }> = [];
	let offset = 0;
	for (const text of final.split("\n")) {
		const first = positions.length;
		for (let i = 0; i < text.length; i++) {
			if (!isWhitespace(text.charCodeAt(i))) positions.push(offset + i);
		}
		if (positions.length > first) finalLines.push({ start: first, count: positions.length - first });
		offset += text.length + 1;
	}
	if (finalLines.length !== lines.length) throw new Error("Formatting changed the lines of the prompt");
	const mapped: number[] = [];
	lines.forEach((line, index) => {
		const target = finalLines[index];
		if (line.count !== target.count && !line.separator) {
			throw new Error("Formatting changed the non-whitespace text of the prompt");
		}
		for (let column = 0; column < line.count; column++) {
			mapped.push(positions[target.start + Math.min(column, target.count - 1)]);
		}
	});
	if (mapped.length !== nonWhitespace) throw new Error("Formatting changed the non-whitespace text of the prompt");
	return mapped;
}

/**
 * Locates the sections and inputs of one block in its final text. `marked` is
 * the unformatted tracking render; `final` is the block the model gets.
 * Formatting keeps the non-whitespace characters, so the n-th one of `marked` is
 * the n-th one of `final` (see {@link finalPositions}), and a marker's place in
 * `final` is the place of the non-whitespace character that follows (or
 * precedes) it.
 *
 * Top-level sections tile the block: the text outside every top-level section
 * is a section of its own (see {@link looseTextId}).
 */
export function locateSources(
	block: number,
	marked: string,
	final: string,
	marker: SourceMarker,
	into: LocateResult,
	template: LocatedTemplate,
): void {
	const { lines, nonWhitespace } = scanMarked(marked);
	const positions = finalPositions(final, lines, nonWhitespace);
	for (const { ref, gates, parent, start, end } of placeSections(marked, marker, template)) {
		const section: PromptSection = {
			...ref,
			parent,
			block,
			start: positions[start],
			end: positions[end - 1] + 1,
			gates,
		};
		if (ref.source) {
			into.sources.push({ ...ref.source, block, start: section.start, end: section.end });
		}
		into.sections.push(section);
	}
}
