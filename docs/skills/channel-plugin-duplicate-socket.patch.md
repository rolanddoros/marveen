# Skill patch: `channel-plugin-duplicate-socket` (global, `/root/.claude/skills/channel-plugin-duplicate-socket/SKILL.md`)

Applied by the main agent when this PR merges. Why: steps 4-5 and the Telegram note tell the reader to edit an agent's
project-level `.claude/settings.json` by hand (`enabledPlugins.<plugin>: false`). After this PR that file is a
protected path for every agent: the dashboard's channel save writes `enabledPlugins` there, the scaffold rewrites its
hooks block at every start, and the verifier compares that block with the protected lock before the agent starts.

## Steps 4-5, replace with

4. A plugin kikapcsolása egy ágensnél: a dashboard csatorna-beállításán át, nem kézzel. A
   `POST /api/agents/<n>/channels/<provider>` mentés a dashboard folyamatából írja a `.claude/settings.json`
   `enabledPlugins` kulcsát (`setAgentEnabledPlugins`, `src/web/routes/agents.ts:426`): az ágens saját providere
   `true`, minden más csatorna-plugin `false`. A fájl kézi szerkesztését a db-write-gate tiltja. Ha az API nem tudja
   kifejezni a kívánt állapotot (pl. egy nem-csatorna plugin): a gazda saját termináljából, vagy javaslat kanban-
   kártyán a pontos kulccsal.
5. Az ágens izolált `.claude-config/settings.json`-ja (a közös fájl másolata) szintén védett: azt a provisioning írja.

## Telegram note, replace "bármely agent project-szintű `.claude/settings.json`-ben ... false-re kell tenni" with

   ... az érintett ágensnél a csatorna-beállítás mentése (4. lépés) teszi a telegram plugint `false`-ra, ha az ágens
   providere nem telegram; a `.claude/settings.json` kézi szerkesztése tilos.
