/**
 * Source manifest for a built system prompt: which input produced which text.
 *
 * The prompt builder renders every input value twice: once plainly (the prompt
 * the model gets) and once with each value wrapped in private-use marker
 * characters. The marked render, taken before the post-render `format` pass,
 * tells which inputs reached the output (a value gated off by a template
 * conditional never appears) and in what order. Each marked value is then
 * formatted on its own and found in the real prompt, scanning forward in render
 * order. A value that `format` changed differently in context than alone is
 * reported as rendered but not located; nothing is guessed.
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
	/** Inputs that reached the prompt but whose formatted text could not be located exactly. */
	unlocated: SystemPromptSourceInfo[];
}

/** A generated block of the appended prompt (memory, MCP routes, …) and where it came from. */
export type AppendPromptPart = SystemPromptSourceInfo & { text: string };

/** A manifest matched to a live prompt. Blocks from `builtBlocks` on were added after the build. */
export interface SystemPromptDescription extends SystemPromptManifest {
	builtBlocks: number;
}

const MANIFEST_LOG_SIZE = 8;

/**
 * Recent builds of one session. The agent's live prompt can be a build's
 * blocks plus blocks added later (a memory recall), an extension's per-turn
 * replacement, or an older build a newer one was abandoned for, so the live
 * prompt is matched against each recorded build instead of assuming the last.
 */
export class SystemPromptManifestLog {
	readonly #builds: Array<{ blocks: readonly string[]; manifest: SystemPromptManifest }> = [];

	record(result: { systemPrompt: string[]; manifest?: SystemPromptManifest }): void {
		if (!result.manifest) return;
		this.#builds.push({ blocks: result.systemPrompt, manifest: result.manifest });
		if (this.#builds.length > MANIFEST_LOG_SIZE) this.#builds.shift();
	}

	describe(prompt: readonly string[]): SystemPromptDescription | null {
		for (let i = this.#builds.length - 1; i >= 0; i--) {
			const { blocks, manifest } = this.#builds[i];
			if (blocks.length <= prompt.length && blocks.every((block, index) => block === prompt[index])) {
				return { ...manifest, builtBlocks: blocks.length };
			}
		}
		return null;
	}
}

// Unicode noncharacters: never part of interchanged text, so no input contains them.
const OPEN = "\uFDD0";
const CLOSE = "\uFDD1";
/** Marker index characters: one private-use code unit per tracked value. */
const INDEX_BASE = 0xe100;
const INDEX_LIMIT = 0xf8ff - INDEX_BASE;

/**
 * Produces the marked or plain variant of every tracked value. `plain` returns
 * values unchanged, so a template rendered with it is the real prompt.
 */
export class SourceMarker {
	readonly #entries: SystemPromptSourceInfo[] | undefined;

	private constructor(tracking: boolean) {
		this.#entries = tracking ? [] : undefined;
	}

	static plain(): SourceMarker {
		return new SourceMarker(false);
	}

	static tracking(): SourceMarker {
		return new SourceMarker(true);
	}

	get entries(): readonly SystemPromptSourceInfo[] {
		return this.#entries ?? [];
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

	/** Wraps a whole value. Blank values stay as they are: templates and callers test them for content. */
	wrap(info: SystemPromptSourceInfo, text: string): string;
	wrap(info: SystemPromptSourceInfo, text: string | undefined): string | undefined;
	wrap(info: SystemPromptSourceInfo, text: string | undefined): string | undefined {
		if (!text?.trim()) return text;
		const [open, close] = this.around(info);
		return open + text + close;
	}
}

interface MarkedSlice {
	info: SystemPromptSourceInfo;
	text: string;
}

/** Marked values in order of their opening marker, marker characters removed. */
function extractMarkedSlices(marked: string, entries: readonly SystemPromptSourceInfo[]): MarkedSlice[] {
	const opened = new Map<number, { order: number; start: number }>();
	const slices: Array<MarkedSlice & { order: number }> = [];
	let order = 0;
	for (let i = 0; i < marked.length; i++) {
		const ch = marked.charCodeAt(i);
		if (ch !== 0xfdd0 && ch !== 0xfdd1) continue;
		const index = marked.charCodeAt(i + 1) - INDEX_BASE;
		if (ch === 0xfdd0) {
			opened.set(index, { order: order++, start: i + 2 });
		} else {
			const open = opened.get(index);
			const info = entries[index];
			if (open && info) {
				slices.push({ info, order: open.order, text: stripMarkers(marked.slice(open.start, i)) });
				opened.delete(index);
			}
		}
		i++;
	}
	return slices.sort((a, b) => a.order - b.order);
}

function stripMarkers(text: string): string {
	return text.replace(/[\uFDD0\uFDD1][\uE100-\uF8FF]/g, "");
}

export interface LocateResult {
	sources: SystemPromptSource[];
	unlocated: SystemPromptSourceInfo[];
}

/**
 * Locates the marked values of one block in its final text. `marked` is the
 * unformatted render with markers; `final` is the block the model gets.
 */
export function locateSources(
	block: number,
	marked: string,
	final: string,
	entries: readonly SystemPromptSourceInfo[],
	into: LocateResult,
): void {
	let cursor = 0;
	for (const slice of extractMarkedSlices(marked, entries)) {
		const target = prompt.format(slice.text, { renderPhase: "post-render" }).trim();
		if (!target) continue;
		const start = final.indexOf(target, cursor);
		if (start < 0) {
			into.unlocated.push(slice.info);
			continue;
		}
		into.sources.push({ ...slice.info, block, start, end: start + target.length });
		// Next value starts at or after this one's start: nested values (a part
		// inside the appended prompt) begin inside their parent.
		cursor = start;
	}
}
