# Skill patch: `uj-agens-felvetel` (project, `/root/marveen/.claude/skills/uj-agens-felvetel/SKILL.md`)

Applied by the main agent when this PR merges (plan addendum 1 K4, Ron 17451 enrolment). Why: two hand steps write a
sub-agent's `.claude/settings.local.json` (the `GH_CONFIG_DIR` env in the GitHub note, the isolated agent's deny rows
in the "Elkülönített ágens" note). After this PR that file is written only through the owner-approved helper, and an
agent with no baseline entry does not start in enforce mode (report mode: an alert at every start).

## New step, after the agent is created and before the first start ("Baseline")

**Baseline (Fork C settings-protect).** Az új ágens settings.local.json-ját és a meglévők elkülönítési sorait EGY
batch-ben, a gazda jóváhagyásával:
1. Írd meg a batch-et: `store/agent-settings-staging/<id>.json` (Write), alak:
   `{"format":"marveen-agent-settings-batch/v1","isolated":["sally"],"files":[{"agent":"<új>","content":"<a TELJES új settings.local.json szövege>"}, ...]}`.
   Benne: az új ágens fájlja (a `GH_CONFIG_DIR` env, ha kell, csak a saját `agents/<új>/` mappáján belül; a deny-sorok
   minden elkülönített ágens mappájára: `Read/Edit/Write(//root/marveen/agents/<elk>/**)`, `Bash(*agents/<elk>*)`),
   és MINDEN elkülönített ágens fájlja kiegészítve az új ágens négy sorával.
2. `node /root/marveen/scripts/agent-settings/apply-local.mjs request --batch <id>` (pontosan így, egyetlen parancsként).
   Kimenet: approval id, `owner notified: yes|NO|unknown`. A leírásban `SÉRÜL:` sor = hiányzó elkülönítési sor:
   javítsd a batch-et, és kérj újat, mielőtt a gazda jóváhagyná.
3. A gazda jóváhagyása után: `node /root/marveen/scripts/agent-settings/apply-local.mjs apply --approval <id>`.
   Megszakadt apply (exit 4): `... resume`; ha az nem zár: `... rebaseline --agent <n>`, új jóváhagyással.
4. Csak ezután `POST /api/agents/<új>/start`.

## GitHub note ("Minden GitHubot használó agentnek: ... `"env": {"GH_CONFIG_DIR": ...}` a `.claude/settings.local.json`-ban"), replace the write with

   ... a `GH_CONFIG_DIR` env a fenti Baseline-lépés batch-ében kerül a `.claude/settings.local.json`-ba (kézzel nem
   írható). A `hosts.yml` a `agents/<n>/.config/gh/` mappában továbbra is kézzel készül (a mappa tartalma írható, a
   mappa maga nem nevezhető át / törölhető).

## "Elkülönített ágens" note, replace "plusz `agents/<n>/.claude/settings.local.json` `permissions.deny` ..." with

   ... plusz a deny-sorok a Baseline-lépés batch-ében (az új elkülönített ágens neve a batch `isolated` listájába is
   kerül). A helper a leírásban `SÉRÜL:` sorral jelzi, ha valamelyik ágens fájljából hiányzik egy elkülönítési sor, és
   a verifier induláskor is ellenőrzi (enforce módban nem indul). A sorok a deny-szabályok JELENLÉTÉT bizonyítják, nem
   a fizikai izolációt (közös root user): ezt mondd meg a gazdának.
