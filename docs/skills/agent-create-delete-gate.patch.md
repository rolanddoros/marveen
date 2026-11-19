# Skill patch: who may create and delete an agent (fork D part (a), kanban f8bbd94c)

Applied by the main agent when this PR merges. Skills: `uj-agens-felvetel` (project,
`/root/marveen/.claude/skills/uj-agens-felvetel/SKILL.md`) and `agens-torles` (global,
`/root/.claude/skills/agens-torles/SKILL.md`). Why: `POST /api/agents` and `DELETE /api/agents/<n>` now take the same
predicate as A1's `PUT /api/agents/<n>` (`ownerOrSharedToken`, `src/web/routes/agents.ts`): the owner
(`mayActAsOwner`: the dashboard login, a full Bridge key WITH the owner's password session beside it, the shared token
before the first login) or the SHARED dashboard token pass. Everyone else gets 403 `owner_session_required` before
anything is read, checked or touched: a sub-agent's own token (`agents/<n>/.dashboard-token`, AGENT_TOKENS), a
federation peer, an operator key and a bare full Bridge key without the password session (decided, D2).

## Nothing changes for the main agent

`uj-agens-felvetel` step 1 (`curl ... -X POST http://localhost:3420/api/agents`) and `agens-torles` step 4
(`curl -X DELETE ... /api/agents/<név>`) send the shared token from `store/.dashboard-token`: both keep working, with
and without a dashboard login.

## Add one line to each of the two skills (after the curl of the step above)

> A létrehozás / törlés CSAK a fő ágens közös tokenjével vagy a gazda belépett dashboard-sessionjével megy. Al-ágens
> saját tokenje (AGENT_TOKENS), peer vagy jelszavas belépés nélküli Bridge-kulcs: 403 `owner_session_required`, semmi
> nem jön létre és semmi nem törlődik. Al-ágens ilyet ne kérjen a végponttól: a fő ágenst kérje.
