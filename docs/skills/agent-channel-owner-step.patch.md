# Skill patch: the channel access routes are owner steps (fork A4, kanban 774c7ece)

Applied by the main agent when this PR merges. Skill: `uj-agens-felvetel` (project,
`/root/marveen/.claude/skills/uj-agens-felvetel/SKILL.md`). Why: once a dashboard login exists, every route that
decides who can write to an agent from outside takes the owner's session (`mayActAsOwner`,
`src/web/routes/agents.ts`), for sub-agents and the main agent alike, new and legacy (`/telegram/...`) URL forms:

- `POST /api/agents/<n>/channels/<p>` (bot setup) and `DELETE /api/agents/<n>/channels/<p>` (removal)
- `POST /api/agents/<n>/channels/<p>/approve` (pairing approve)
- `POST` and `GET /api/agents/<n>/channels/<p>/invites` (create, list: the list carries the live invite links),
  `DELETE /api/agents/<n>/channels/<p>/invites/<token>`
- `DELETE /api/agents/<n>/channels/<p>/allowed/<user|group>/<id>`
- `POST /api/agents/<n>/channel-requests/<id>/approve` and `.../deny` (Slack)

With the shared dashboard token they answer HTTP 403 with
`{"error":"This needs the dashboard login (an owner session). The access token can do it only before the first login exists; on the machine itself, npm run dashboard-user is the break-glass.","code":"owner_session_required"}`
and nothing is read or written. Before the first login (onboarding) the shared token still passes.

## Step 3 ("Bot bekötése"), replace the curl block with

3. **Bot bekötése: GAZDA-LÉPÉS**, csak ha már megvan a csevegő ember ID-ja (különben pairing módban bárki
   párosíthatna). A gazda az ágens **Csatornák** fülén menti a botot (bot token + a csevegő ember Telegram ID-ja az
   engedélylistába) a saját, belépett dashboard-sessionjéből; vagy a fő ágens egy olyan böngészőből, amelyben a gazda
   dashboard-sessionje él. A közös tokenes `POST /api/agents/<n>/channels/telegram` az első belépés után 403
   (`owner_session_required`), semmi nem íródik. Nem üres engedélylista -> `dmPolicy:"allowlist"`, nincs párosítás.
   Ellenőrzés tokennel (ezek olvasások, nem kapuzottak): `GET /api/agents/<n>/channel/health` (`healthy:true`) és
   `GET /api/agents/<n>/channels/telegram/allowed` (a felvett ID benne van).

## Unchanged (said explicitly)

- The pitfalls "Második ember utólagos felvétele" and "Közös Telegram-csoport" edit the agent's
  `.claude/channels/telegram/access.json` on disk, not through these routes; this PR does not touch file access.
- A bot-less agent skips step 3 as before; `POST /api/agents/<n>/start` and `GET .../status` are not gated by this PR.
