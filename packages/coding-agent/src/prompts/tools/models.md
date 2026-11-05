List models and selection policy from the live session registry without spawning a worker.

- Omit `query` to browse; otherwise search provider, model ID, or display name. Page with `offset` and `limit` (default 50, max 100).
- `agent` selects the subagent whose defaults and restrictions to inspect; omitted uses the default agent. `invocation` is `task` (default) or `eval` (agent/workpool).
- Returns exact selectors, supported reasoning levels, availability, selectability with refusal reasons, context limits, pricing per million tokens, the effective default and reasoning ceiling.
- `includeUnavailable` includes unavailable/non-chat catalog entries with reasons. Availability means catalog/credential eligibility, not a successful live inference probe.
- Use a returned exact selector plus a supported `:level` in a subagent call. Omit `model` to use its default. `maxEffort` still caps requested reasoning.
- Never invent a selector, confuse availability with authorization, or silently substitute an explicitly requested model.
