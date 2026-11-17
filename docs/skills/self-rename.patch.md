# Skill patch: `self-rename` (global, `/root/.claude/skills/self-rename/SKILL.md`)

Applied by the main agent when this PR merges (Ron 17505 1a, Johnny 17508 via Kevin 17509). Why: step 4 writes
`BRAND_NAME` into the install's root `.env` with a python one-liner. After this PR the root `.env` is a protected path
for every agent (it holds `GATE_WIRING_ENFORCE`, the switch between report and enforce), so step 4 is denied. The
onboarding API is not a way around it: it writes `BOT_NAME` as well, which this skill must never touch.

## Step 4, replace with

4. **BRAND_NAME az .env-ben: a GAZDA lépése.** Az install gyökér `.env`-je védett út (db-write-gate, Fork C
   settings-protect), ágens nem írja. Küldd el a gazdának a pontos parancsot a saját termináljába:
   `python3 - /root/marveen/.env "UJ_NEV"` + a lenti szkript (változatlanul), és várd meg, hogy jelezze: kész.
   Az onboarding API-t NE használd erre: az a `BOT_NAME`-et is írja.

## "Buktatók", add

- 2026-11-17 óta (Fork C settings-protect) az install `.env` írása minden ágensnek tiltott, a fő ágensnek is: a 4.
  lépés a gazda terminálja.
