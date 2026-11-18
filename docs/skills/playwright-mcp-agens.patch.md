# Skill patch: `playwright-mcp-agens` (project, `/root/marveen/.claude/skills/playwright-mcp-agens/SKILL.md`)

Applied by the main agent when this PR merges (plan v2 addendum 1: the hand steps that write an agent's
`.claude/settings.json`). Why: steps 3 and 4 tell the reader to edit the agent's `settings.json` by hand. After this
PR that file is a protected path, and both entries already come from code: the PostToolUse hook is the manifest entry
`browser-content-notice-playwright` (`src/web/hooks/manifest.ts:333`), rendered for an agent with the `browser`
capability, and the deny row is in the scaffold's floor list (`src/web/agent-scaffold.ts:1797`), written at every
start. A hand-added copy of the hook is a "kept hook" for the verifier (an error in enforce mode).

## Steps 3-4, replace with

3. Böngésző-képesség: `PUT /api/agents/<n>/capabilities` a `browser` képességgel (`src/web/routes/fleet-q.ts:25`).
   Ettől rendereli a generátor a `browser-content-notice-playwright` PostToolUse hookot (matcher
   `mcp__playwright__browser_.*`); kézzel NEM írod a `settings.json`-ba (a db-write-gate tiltja).
   A képesség a baseline kapcsoló-tuple része: utána a gazda jóváhagyásával
   `node /root/marveen/scripts/agent-settings/apply-local.mjs rebaseline --agent <n>`, különben az ágens report
   módban riaszt, enforce módban nem indul.
4. A `mcp__playwright__browser_run_code_unsafe` deny-sort a scaffold minden indításkor beírja (floor-lista); nincs
   kézi teendő.
