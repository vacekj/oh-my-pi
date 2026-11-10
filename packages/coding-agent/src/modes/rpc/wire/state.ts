/**
 * Wire definitions for session state snapshots and command results.
 *
 * Fields wrapped in `absentAs` were added after the first protocol release (or
 * are informational); decoders substitute the default when an older server
 * omits them.
 */
import { absentAs, doc, type WireDefs } from "./dsl";

const JSON_OBJECT = "Record<string, unknown>";

export const stateDefs = {
	QueueMode: "'all' | 'one-at-a-time'",
	InterruptMode: "'immediate' | 'wait'",
	StreamingBehavior: "'steer' | 'followUp'",
	QueuedMessageQueue: "'steering' | 'followUp'",
	CacheWarmingMode: "'off' | 'streaming' | 'idle'",
	MessageUpdates: doc(
		"'full' | 'delta'",
		"`set_event_filter` projection: `delta` replaces the accumulated snapshots with the block a start/end event touches.",
	),
	TodoStatus: "'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked'",
	GoalOp: "'get' | 'create' | 'resume' | 'pause' | 'drop'",
	GoalStatus: "'active' | 'paused' | 'budget-limited' | 'complete' | 'dropped'",
	SlashCommandSource: "'builtin' | 'skill' | 'extension' | 'custom' | 'mcp_prompt' | 'file'",
	SubagentSubscriptionLevel: doc(
		"'off' | 'progress' | 'events'",
		"Forwarded subagent frames: none, lifecycle and progress, or also raw session events.",
	),
	AgentSource: "'bundled' | 'user' | 'project'",
	SubagentStatus: "'pending' | 'running' | 'completed' | 'failed' | 'aborted'",

	TodoItem: {
		content: "string",
		status: "TodoStatus",
		"blocker?": doc("string", "What a `blocked` task is waiting on."),
		"details?": "string",
		"notes?": "string[]",
	},
	TodoPhase: { name: "string", tasks: "TodoItem[]" },
	ContextUsage: { tokens: "number.integer", contextWindow: "number.integer", percent: "number" },
	SystemPromptSourceKind:
		"'custom-prompt' | 'system-md' | 'personality' | 'skill' | 'always-apply-rule' | 'rule' | 'internal-url' | 'tool' | 'tool-inventory' | 'xdev-docs' | 'workstation' | 'model' | 'context-file' | 'nested-context' | 'workspace-tree' | 'workspace-root' | 'repo-context' | 'append' | 'user-append' | 'eval-prelude'",
	SystemPromptSourceInfo: doc(
		{
			id: doc("string", "Stable per input across rebuilds (`context-file:<path>`, `skill:<name>`)."),
			kind: "SystemPromptSourceKind",
			label: "string",
			"path?": doc("string", "File the text was read from."),
			"level?": "'user' | 'project' | 'native'",
			"depth?": doc("number.integer", "Distance of a project context file from the cwd (0 = the cwd)."),
			"provider?": doc("string", "Discovery provider that loaded the file."),
			"setting?": doc("string", "Setting id that controls the input."),
			"value?": doc("string", "That setting's value, when it selects between variants."),
		},
		"An input of the system prompt and where it came from.",
	),
	SystemPromptSource: doc(
		{
			id: "string",
			kind: "SystemPromptSourceKind",
			label: "string",
			"path?": "string",
			"level?": "'user' | 'project' | 'native'",
			"depth?": "number.integer",
			"provider?": "string",
			"setting?": "string",
			"value?": "string",
			block: "number.integer",
			start: "number.integer",
			end: "number.integer",
		},
		"An input located in the prompt: `systemPrompt[block].slice(start, end)` is its text.",
	),
	SystemPromptTemplate: {
		kind: "'bundled' | 'custom-prompt' | 'template'",
		"path?": doc("string", "Template or prompt file; absent for the bundled template and literal text."),
	},
	SystemPromptGate: doc(
		{ name: "string", value: doc("string", "The value as text (`true`, `3`, `eager`)."), "setting?": "string" },
		"A value the template's conditionals read, or a condition a section needed to render, and the setting it came from.",
	),
	PromptFilter: doc(
		{
			mode: doc(
				"'exclude' | 'only'",
				"`exclude` removes the listed sections and everything inside them; `only` keeps the listed sections (with everything inside) and renders the sections around them with their own text only.",
			),
			ids: doc("string[]", "Section ids (`template:role`, `tools`, `skill:deploy`, `session-section:0`, …)."),
		},
		"Which sections of the system prompt a build keeps. `only` with no ids gives an empty prompt. Tool schemas are not affected.",
	),
	PromptSectionInput: doc(
		{ title: "string", text: "string" },
		"A titled session prompt section; it is reported as `session-section:<n>` under that title.",
	),
	PromptSectionKind:
		"'template' | 'session-section' | 'memory-recall' | 'custom-prompt' | 'system-md' | 'personality' | 'skill' | 'always-apply-rule' | 'rule' | 'internal-url' | 'tool' | 'tool-inventory' | 'xdev-docs' | 'workstation' | 'model' | 'context-file' | 'nested-context' | 'workspace-tree' | 'workspace-root' | 'repo-context' | 'append' | 'user-append' | 'eval-prelude'",
	PromptSectionOrigin: doc(
		{
			file: doc(
				"string",
				"Template file: relative to the omp package for bundled templates, the template's own path otherwise.",
			),
			startLine: doc("number.integer", "1-based line of the section's opening tag."),
			endLine: doc("number.integer", "1-based line of its closing tag."),
		},
		"Where a template section is declared.",
	),
	PromptSectionReplacement: doc(
		{ kind: "'session'", setting: "'promptOverrides'" },
		"Why a section's emitted text is not the declaration's: a session text replacement (`promptOverrides`).",
	),
	PromptSectionRef: doc(
		{
			id: "string",
			parent: "string | null",
			title: "string",
			kind: "PromptSectionKind",
			origin: "PromptSectionOrigin | null",
			"source?": "SystemPromptSourceInfo",
			"replacement?": doc(
				"PromptSectionReplacement",
				"The emitted text is a session replacement; `origin`/`source` still describe the declaration.",
			),
		},
		"A section without its place in the prompt.",
	),
	PromptSection: doc(
		{
			id: doc(
				"string",
				"Stable across rebuilds: `template:<path>`, `tools`, an input's source id (`skill:<name>`, …), `session-section:<n>`, `memory-recall`.",
			),
			parent: doc("string | null", "Enclosing section id."),
			title: doc("string", "Declared in the template next to the section, or the input's label."),
			kind: "PromptSectionKind",
			block: "number.integer",
			start: "number.integer",
			end: doc(
				"number.integer",
				"`systemPrompt[block].slice(start, end)` is the section's full text, children included.",
			),
			origin: doc("PromptSectionOrigin | null", "Template sections only: where the template declares it."),
			"source?": doc("SystemPromptSourceInfo", "Inputs only: the same info as the matching `sources` entry."),
			gates: doc(
				"SystemPromptGate[]",
				"The template conditionals directly around the section that held for it to render, with the setting id when one exists.",
			),
			"replacement?": doc(
				"PromptSectionReplacement",
				"The emitted text is a session replacement; `origin`/`source` still describe the declaration.",
			),
		},
		"A template section or an input, located in the prompt. Children lie inside their parent; top-level sections tile every block.",
	),
	SystemPromptSources: doc(
		{
			template: "SystemPromptTemplate",
			tools: doc("string[]", "Active tool names, the inputs of the template's tool sections."),
			gates: "SystemPromptGate[]",
			sources: "SystemPromptSource[]",
			unlocated: doc(
				"SystemPromptSourceInfo[]",
				"Inputs that reached the prompt but whose text could not be located exactly.",
			),
			builtBlocks: doc("number.integer", "Blocks from this index on were added after the build (memory recall)."),
			sections: doc(
				"PromptSection[]",
				"Template sections and inputs as a tree in prompt order, parents before children.",
			),
			filter: doc("PromptFilter", "The filter the build applied."),
			excluded: doc("PromptSectionRef[]", "Sections the filter removed (roots only)."),
			"overrides?": doc(
				"Record<string, string>",
				"Session text replacements this build applied (section id -> replacement text); absent when none.",
			),
		},
		"Which section or input produced which text of `systemPrompt`.",
	),
	QueuedMessagesState: doc(
		{
			steering: "string[]",
			followUp: "string[]",
			liveSteered: absentAs(
				doc(
					"number.integer",
					"Leading `steering` entries are live steering already sent into the streaming response; `remove_queued_message` cannot reach them.",
				),
				0,
			),
		},
		"Displayable queue-chip text for pending user-authored messages; accepted verbatim by `remove_queued_message`.",
	),
	ToolDescriptor: { name: "string", description: "string", "parameters?": "unknown", "examples?": "unknown[]" },
	Goal: doc(
		{
			id: "string",
			objective: "string",
			status: "GoalStatus",
			"tokenBudget?": "number.integer",
			tokensUsed: "number.integer",
			timeUsedSeconds: "number",
			createdAt: "number.integer",
			updatedAt: "number.integer",
		},
		"A tracked goal: its objective, lifecycle status, and resource accounting.",
	),
	GoalModeState: doc(
		{ enabled: "boolean", mode: "'active' | 'exiting'", "reason?": "'completed'", goal: "Goal" },
		'Session goal mode; `mode` is `"exiting"` while a completed goal unwinds.',
	),
	GoalResult: doc(
		{ goal: "Goal | null", state: "GoalModeState | null" },
		"Outcome of every `goal` op; both fields are null when the session has no goal.",
	),
	SlowModeScope: doc(
		"'session' | 'global'",
		"Where `/slow` lives: persisted config shared by every session, or this session's flex tier.",
	),
	UsageLimitLowPriority: doc(
		{
			stage: "'low_priority'",
			resetsAtSec: doc("number", "Epoch seconds when the limit that was hit resets."),
			"allowanceLeftPercent?": doc(
				"number.integer",
				"Percent of the low-priority allowance still available, when reported.",
			),
		},
		"Requests are served on the provider's low-priority (slow) lane.",
	),
	UsageLimitWrapUp: doc(
		{
			stage: "'wrap_up'",
			"resetsAtSec?": doc("number", "Epoch seconds when the limit that was hit resets, if reported."),
			extraUsage: doc("boolean", "Whether paid extra usage serves requests once the allowance is spent."),
		},
		"Requests run on a short wrap-up allowance past the limit.",
	),
	UsageLimitState: doc(
		"UsageLimitLowPriority | UsageLimitWrapUp",
		"Provider-neutral state of an account past its usage limit, discriminated by `stage`.",
	),
	SessionState: {
		"model?": "ModelInfo",
		"modelRoles?": doc(
			"Record<string, string>",
			"Effective role selectors: session-local assignments over configuration.",
		),
		"modelRoleOverrides?": doc(
			"Record<string, string>",
			"This session's local role assignments (empty when none).",
		),
		"thinkingLevel?": "ThinkingLevel",
		isStreaming: absentAs("boolean", false),
		isCompacting: absentAs("boolean", false),
		steeringMode: absentAs("QueueMode", "one-at-a-time"),
		followUpMode: absentAs("QueueMode", "one-at-a-time"),
		interruptMode: absentAs("InterruptMode", "immediate"),
		"sessionFile?": "string",
		sessionId: "string",
		"sessionName?": "string",
		autoCompactionEnabled: absentAs("boolean", false),
		fastModeEnabled: absentAs("boolean", false),
		fastModeActive: absentAs("boolean", false),
		slowModeSupported: absentAs(doc("boolean", "`/slow` applies to the active model."), false),
		slowModeEnabled: absentAs(
			doc("boolean", "`/slow` is on for the active model; always `false` when `slowModeSupported` is `false`."),
			false,
		),
		"slowModeScope?": doc("SlowModeScope", "Where the active model's `/slow` lives; absent when unsupported."),
		"usageLimit?": doc(
			"UsageLimitState",
			"Usage-limit stage of the active model's account; absent outside wrap-up and low priority.",
		),
		tokensPerSecond: absentAs("number | null", null),
		messageCount: absentAs("number.integer", 0),
		queuedMessageCount: absentAs("number.integer", 0),
		hasPendingAsyncWork: absentAs(
			doc("boolean", "Background jobs or deliveries can still inject a follow-up and wake the session."),
			false,
		),
		isSettled: absentAs(
			doc("boolean", "Idle with nothing queued or pending; same predicate as `session_settled`."),
			false,
		),
		queuedMessages: absentAs("QueuedMessagesState", { steering: [], followUp: [], liveSteered: 0 }),
		todoPhases: absentAs("TodoPhase[]", []),
		systemPrompt: absentAs(doc("string[]", "System prompt sections, for session dumps."), []),
		"systemPromptSources?": doc(
			"SystemPromptSources | null",
			"Source manifest of `systemPrompt`; null when the live prompt is not one the session built (an extension replaced it).",
		),
		dumpTools: absentAs("ToolDescriptor[]", []),
		"contextUsage?": "ContextUsage",
		goal: absentAs(doc("GoalModeState | null", "Current goal mode; null when the session has no goal."), null),
	},

	BashResult: {
		output: "string",
		"exitCode?": "number.integer",
		cancelled: "boolean",
		"timedOut?": "boolean",
		truncated: "boolean",
		totalLines: "number.integer",
		totalBytes: "number.integer",
		outputLines: "number.integer",
		outputBytes: "number.integer",
		"artifactId?": "string",
		"artifactElidedBytes?": "number.integer",
		"artifactError?": JSON_OBJECT,
		"minimized?": JSON_OBJECT,
		"workingDir?": "string",
		"images?": "ImageContent[]",
	},
	FastModeResult: { enabled: "boolean", active: "boolean" },
	CompactionResult: {
		summary: "string",
		"shortSummary?": "string",
		firstKeptEntryId: "string",
		tokensBefore: "number.integer",
		"details?": "unknown",
		"preserveData?": JSON_OBJECT,
		"providerReplayThroughEntryId?": "string",
	},
	ModelCycleResult: { model: "ModelInfo", "thinkingLevel?": "ThinkingLevel", isScoped: "boolean" },
	ThinkingLevelCycleResult: { level: "Effort" },
	CancellationResult: { cancelled: "boolean" },
	OpenSessionResult: doc(
		{ cancelled: "boolean", resumed: "boolean", sessionId: "string", "sessionFile?": "string" },
		"`open_session` outcome; `resumed` is false when a fresh session was started.",
	),
	RemoveQueuedMessageResult: {
		removed: "boolean",
		"images?": doc("ImageContent[]", "The removed message's images, so the client can restore them with its text."),
		"imagesDropped?": doc(
			"boolean",
			"Only ever `true`: the images exceeded the transport limit and were omitted; the removal still happened.",
		),
	},
	PromoteQueuedMessageResult: { promoted: "boolean" },
	RestoredQueuedMessage: doc(
		{ text: "string", "images?": "ImageContent[]" },
		"Queued user content withdrawn from the queue, as the editor would restore it.",
	),
	AbortAndRestoreQueueResult: doc(
		{
			steering: "RestoredQueuedMessage[]",
			followUp: "RestoredQueuedMessage[]",
			"imagesDropped?": doc(
				"boolean",
				"Only ever `true`: the full result exceeded the transport limit and every `images` was omitted.",
			),
			"truncated?": doc(
				"boolean",
				"Only ever `true`: even the text-only result exceeded the limit, so only an oldest-first prefix is listed.",
			),
		},
		"User-authored queued input withdrawn before the abort, oldest first.",
	),
	BranchMessage: { entryId: "string", text: "string" },
	BranchResult: { text: "string", cancelled: "boolean" },
	NavigateTreeResult: {
		cancelled: "boolean",
		"aborted?": doc("boolean", "Only ever `true`: `abort_branch_summary` stopped the summary; nothing moved."),
		"editorText?": doc(
			"string",
			"The target was a user message: its text, for the editor; the leaf moved to its parent.",
		),
	},
	TokenUsage: {
		input: "number.integer",
		output: "number.integer",
		reasoning: absentAs("number.integer", 0),
		cacheRead: "number.integer",
		cacheWrite: "number.integer",
		total: "number.integer",
	},
	SessionCredits: { cost: "number", committedCost: "number", acuCost: "number" },
	SessionStats: {
		"sessionFile?": "string",
		sessionId: "string",
		userMessages: "number.integer",
		assistantMessages: "number.integer",
		toolCalls: "number.integer",
		toolResults: "number.integer",
		totalMessages: "number.integer",
		tokens: "TokenUsage",
		premiumRequests: "number",
		cost: "number",
		"credits?": "SessionCredits",
		"routedModels?": "Record<string, number>",
		"editRejections?": doc("Record<string, number>", "Failed edits by the engine's `errorKind`."),
		"contextUsage?": "ContextUsage",
	},
	MessagesPage: {
		messages: "AgentMessage[]",
		totalMessages: "number.integer",
		"nextCursor?": doc("string", "Opaque cursor for the next page; absent on the last page."),
	},
	SlashCommandInput: { "hint?": "string" },
	SlashSubcommand: { name: "string", "description?": "string", "usage?": "string" },
	AvailableSlashCommand: {
		name: "string",
		"aliases?": "string[]",
		"description?": "string",
		"input?": "SlashCommandInput",
		"subcommands?": "SlashSubcommand[]",
		source: "SlashCommandSource",
	},
	SessionEntries: doc(
		{ entries: `${JSON_OBJECT}[]`, leafId: "string | null" },
		"OMP-native session entries in append order.",
	),
	SessionTree: doc({ tree: `${JSON_OBJECT}[]`, leafId: "string | null" }, "Raw session tree roots."),
	SubagentSnapshot: {
		id: "string",
		index: "number.integer",
		agent: "string",
		agentSource: "AgentSource",
		"description?": "string",
		status: "SubagentStatus",
		"task?": "string",
		"assignment?": "string",
		"sessionFile?": "string",
		lastUpdate: "number.integer",
		"progress?": doc(JSON_OBJECT, "Raw `AgentProgress` record."),
		"parentToolCallId?": "string",
	},
	SubagentMessages: doc(
		{
			sessionFile: "string",
			fromByte: "number.integer",
			nextByte: doc("number.integer", "Pass as the next `fromByte` to read incrementally."),
			reset: doc("boolean", "`fromByte` exceeded the file size and reading restarted at zero."),
			entries: `${JSON_OBJECT}[]`,
			messages: "AgentMessage[]",
		},
		"Incremental subagent transcript read.",
	),
	BtwStatus: doc(
		"'running' | 'complete' | 'cancelled' | 'error' | 'interrupted'",
		"Side-question turn lifecycle; `interrupted` marks a turn whose process died while it ran.",
	),
	BtwHistoryTurn: doc(
		{
			question: "string",
			"images?": doc("ImageContent[]", "Images attached to the question."),
			answer: "string",
			status: "BtwStatus",
			createdAt: "number.integer",
			updatedAt: "number.integer",
			"error?": "string",
		},
		"One question and its answer within a side-question topic.",
	),
	BtwHistoryRecord: doc(
		{
			question: "string",
			"images?": doc("ImageContent[]", "Images attached to the question."),
			answer: "string",
			status: "BtwStatus",
			createdAt: "number.integer",
			updatedAt: "number.integer",
			"error?": "string",
			id: "string",
			leafId: "string | null",
			"followUps?": "BtwHistoryTurn[]",
		},
		"A side-question topic: its first turn's fields plus follow-ups; the latest turn is the last follow-up, else the record.",
	),
	LoginProvider: { id: "string", name: "string", available: "boolean", authenticated: "boolean" },
	LogoutAccount: doc(
		{
			credentialId: "number.integer",
			provider: "string",
			label: "string",
			detail: "string",
			type: "'api_key' | 'oauth'",
			active: "boolean",
		},
		"A stored credential `logout` can remove; `active` marks credentials the session may be using.",
	),
	HandoffResult: { "savedPath?": "string" },
	PromptAck: doc(
		{ "agentInvoked?": "boolean" },
		"`agentInvoked: false` means the prompt completed locally and no `prompt_result` follows.",
	),
} satisfies WireDefs;
