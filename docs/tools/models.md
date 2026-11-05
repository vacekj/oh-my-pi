# models

Lists models from the live session registry without launching a worker or making an inference request. Uses the same approval and reasoning-ceiling checks as `task`, eval `agent()` and `workpool()`.

## Inputs

- `query`: optional case-insensitive substring of provider, model ID or name.
- `agent`: optional agent definition; omitted uses the session's default spawn agent.
- `invocation`: `task` (default) or `eval`, selecting the relevant per-call permission gate.
- `includeUnavailable`: include the full catalog, including unavailable and non-chat models with refusal reasons. Default false.
- `offset`: zero-based page offset. Default 0.
- `limit`: page size, 1–100. Default 50.

## Output

JSON with the selected agent, invocation, effective `modelAccess`, per-call permission, reasoning ceiling, resolved default selector and configured default patterns. Each row includes its exact selector, availability, selectability/refusal reason, supported reasoning levels, context/output limits, modalities and effective token prices per million. `total` and nullable `nextOffset` support pagination.

Availability means current catalog and credential eligibility, not that a live request succeeded. Credentials, quota and upstream availability can change between discovery and spawning; an explicitly selected model fails rather than falling back. The reported reasoning ceiling still caps a requested level.

## Configuration

Operator configuration can enable any available chat model while retaining a preferred default:

```yaml
task:
   perCallModel: on
   modelAccess: available
   defaultModel: "@default:high"
   maxEffort: max
```

`modelAccess` defaults to `approved`, which requires configured model grants. A project or derived layer can narrow `available` to `approved`, never grant catalog-wide access. Non-empty `task.perCallModelAllow` lists restrict exact identities in either mode; operator and live lists both apply. Disabled providers and account pools remain enforced.

`defaultModel` applies to general-purpose `@task`, model-inheriting agents, and definitions without a model. Explicit specialist defaults and per-agent `task.agentModelOverrides` take precedence. An admitted per-call `model` wins over all defaults; it must be an exact returned `provider/id[@upstream]` plus an optional supported `:level`.

The tool is essential and available in the default toolset. Non-restricted explicit tool lists containing `task` or `eval` automatically include it. Restricted tool lists must request it explicitly.
