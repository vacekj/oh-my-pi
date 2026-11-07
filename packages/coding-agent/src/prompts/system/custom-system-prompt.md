{{#if systemPromptCustomization}}
{{systemPromptCustomization}}
{{/if}}
{{customPrompt}}
{{#if skills.length}}
{{#section "custom/skills" title="Skills"}}
Skills are specialized knowledge. Scan descriptions for your task domain.
If a skill applies, you MUST read `skill://<name>` before proceeding.
<skills>
{{#list skills join="\n"}}
<skill name="{{name}}">
{{description}}
</skill>
{{/list}}
</skills>
{{/section}}
{{/if}}
{{#if hasSkillUriAccess}}
{{#section "custom/skill-uri-access" title="Skill URI access"}}
{{#unless skills.length}}
Loaded skills remain addressable as `skill://<name>`.
{{/unless}}
{{/section}}
{{/if}}
{{#if alwaysApplyRules.length}}
{{#section "custom/always-apply-rules" title="Always-apply rules"}}
{{#each alwaysApplyRules}}
{{content}}
{{/each}}
{{/section}}
{{/if}}
{{#if rules.length}}
{{#section "custom/rules" title="Rules"}}
Rules are local constraints. You MUST read `rule://<name>` when working in that domain.
<rules>
{{#list rules join="\n"}}
<rule name="{{name}}">
{{description}}
{{#if globs.length}}
{{#list globs join="\n"}}<glob>{{this}}</glob>{{/list}}
{{/if}}
</rule>
{{/list}}
</rules>
{{/section}}
{{/if}}
{{#if secretsEnabled}}
{{#section "custom/redacted-content" title="Redacted content"}}
<redacted-content>
Some values in tool output are redacted for security. They appear as placeholder tokens such as `$$HASH$$`, `$$HASH:CASE$$`, or `$$NAME_HASH:CASE$$` (uppercase-alphanumeric digest, optional case hint, optional friendly-name prefix). These are **not errors** — they are intentional placeholders for sensitive values (API keys, passwords, tokens). Treat them as opaque strings. NEVER attempt to decode, fix, or report them as problems.
</redacted-content>
{{/section}}
{{/if}}
