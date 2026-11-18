# Skill patch: the shared token on `PUT /api/agents/<n>` (fork A1, kanban 23e0c5c7)

Applied by the main agent when this PR merges. Skills: `uj-agens-felvetel`, `kvota-befagyasztas-feloldas`,
`kvota-agentenkent` (project, `/root/marveen/.claude/skills/<name>/SKILL.md`). Why: once a dashboard login exists,
`PUT /api/agents/<n>` takes the owner's session (`mayActAsOwner`, `src/web/routes/agents.ts`), with ONE exception
for the shared dashboard token (Ron 17697, option 2b): a body that is exactly `{"model": "<Claude model>"}`.
A model id alone can route an agent's whole session to a third party with the fleet's keys, so only a model the
launcher classifies as Claude passes (`resolveProviderEnv`: `claude-*`, or an alias that resolves to one).

## The three model steps stay as they are

`uj-agens-felvetel` (Modell: utólag `PUT /api/agents/<n>` `{"model":"..."}`), `kvota-befagyasztas-feloldas`
(the original model back after a fallback switch) and `kvota-agentenkent` (a model that differs from the decision)
keep working with the shared token as long as the body carries `model` alone and the model is Claude.

## Add one line to each of the three skills

> Tokennel a `PUT /api/agents/<n>` CSAK `{"model":"..."}` lehet, és csak Claude-modell (`claude-*`, vagy alias, ami
> arra old fel, pl. `opus`). Minden más mező (claudeMd, soulMd, mcpJson, authMode, apiKey, claudePlan,
> memoryIsolation, modelProfile, customProvider), más kulcs a modell mellett, vagy nem-Claude modell: 403
> `owner_session_required`, semmi nem íródik. Ez GAZDA-LÉPÉS: Roland a saját, belépett dashboard-sessionjéből
> csinálja; ügynök kéri tőle (Kevinen vagy Johnnyn át).

## `uj-agens-felvetel`, the non-Claude (OpenRouter) note

A non-Claude model set AFTER creation (`PUT /api/agents/<n>` `{"model":"deepseek/..."}` or any other non-Claude id)
is an owner step now (the line above). The model given at creation (`POST /api/agents` with `"model"`) is not
affected by this PR.
