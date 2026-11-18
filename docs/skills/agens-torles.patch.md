# Skill patch: `agens-torles` (global, `/root/.claude/skills/agens-torles/SKILL.md`)

Applied by the main agent when this PR merges (the global skill is the main agent's; Fork C settings-protect plan v2
point 5). Why: after this PR the gate denies an ad hoc `tar czf ... -C agents <name>` backup, a `tar xzf ... -C agents`
restore and `rm -rf agents/<name>` for every agent, the main agent included (`agents/<name>/.claude`,
`.claude-config`, `.config` and `.config/gh` are protected directories, and `tar` / `rm` pointed at a directory that
contains them reach them). The `DELETE /api/agents/<name>` route makes the backup itself, before it removes anything.

## Step 2, replace with

2. Mentés: a törlés végpontja maga készíti (a következő lépésben), a `rmSync` ELŐTT,
   `store/agent-backups/<név>-<UTC>.tar.gz` útra, 0600 módban. Ha a mentés nem sikerül, a végpont 500-at ad, és
   SEMMIT nem töröl. Kézi `tar czf ... -C agents <név>` NEM kell, és a db-write-gate tiltja is.

## Step 4, add after the curl line

   A válasz `{"ok":true,"backup":"store/agent-backups/<név>-<UTC>.tar.gz"}`: a mentés útját innen olvasd, és ezt írd
   a 6. és 7. lépésbe.

## Step 7, replace the restore sentence with

7. Cold memória: mikor, ki kérte (TG id), a mentés útja (a DELETE válaszából). Visszaállítás a GAZDA saját
   termináljából: `tar xzf <mentés> -C /root/marveen/agents`, majd `POST /api/agents/<név>/start`. Ágens nem bontja
   ki (a gate tiltja: a mentés `.claude/settings*.json`-t és `.config/gh`-t ír vissza). Visszaállítás után a gazda
   jóváhagyásával `rebaseline --agent <név>` kell (`scripts/agent-settings/apply-local.mjs`), különben az ágens a
   baseline-bejegyzés nélkül nem indul (report módban csak riaszt).
