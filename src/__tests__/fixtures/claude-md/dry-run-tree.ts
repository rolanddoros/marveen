// C1 PR 8a: a synthetic install tree for the dry-run tests, shaped like the live
// one (main CLAUDE.md at the root, sub-agents under agents/, .env, templates/).
// Written into a fresh mkdtemp by the tests: .env, store/ and agents/ are
// gitignored at the repo root, and a CRLF/BOM file must reach the test byte
// for byte. Not a copy of any live file. @ROOT@ is replaced with the tree's
// own path, so the same text has paths under the root and foreign ones.
// Every owner zone carries OZSENTINEL-* sentences: the default report must
// never print one (Kevin 12995).

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DRY_RUN_TREE: Readonly<Record<string, string>> = {
  ".env": "# synthetic .env for the dry-run tests; no real value\nMAIN_AGENT_ID=chief\nBOT_NAME=Fixturebot\nOWNER_NAME=Fixture Owner\nALLOWED_CHAT_ID=1234567890\nFAKE_SECRET=envsentinel-not-a-real-value\n",
  "CLAUDE.md": "# Chief\n\nOZSENTINEL-chief-1: the amber kettle sings at noon.\n\n## Inter-agent kommunikáció\n\n```bash\ncurl -s -H \"Authorization: Bearer $(cat @ROOT@/store/.dashboard-token)\" \"http://localhost:3420/api/memories?q=árvíz\" # OZSENTINEL-chief-2\ncurl -s -X POST http://localhost:3420/api/messages -d \"{\\\"from\\\":\\\"chief\\\"}\"\ncurl -s -G --data-urlencode \"q=ok\" -H @<(printf 'Authorization: Bearer '; cat @ROOT@/store/.dashboard-token) http://localhost:3420/api/memories\n```\n\nOld recipe: `curl -s -H \"Authorization: Bearer $(cat /home/olduser/fleet/store/.dashboard-token)\" http://localhost:3420/api/kanban`\nHook path: /home/olduser/fleet/scripts/hooks/guard.py and @ROOT@/scripts/hooks/guard.py\nRead the X-Memory-Search header. OZSENTINEL-chief-3 call 0612345678 or mail fixture@example.com\nNot a recipe: use curl to fetch /api/ docs.\n\n## Öntanulás és Skill rendszer\n\nRetired stock skill section text, kept verbatim for the retired-section sniff.\n\n<!-- BEGIN GENERATED: evidence-rule (auto-generated, do not edit by hand) -->\nGenerated evidence text.\n## Flotta-szintű AUTH-szabály inside a block is not owner text.\n<!-- END GENERATED: evidence-rule -->\n\n<!-- MARVEEN-FEDERATION:BEGIN -- kezelt blokk / managed block, do not edit inside -->\nfederation body\n<!-- MARVEEN-FEDERATION:END -->\n",
  "agents/alpha/CLAUDE.md": "\ufeff# Alpha\r\n\r\nOZSENTINEL-alpha-1: the amber kettle sings at noon.\r\n\r\n```markdown\r\n<!-- BEGIN GENERATED: fleet-roster (auto-generated, do not edit by hand) -->\r\ndecoy inside a fence\r\n<!-- END GENERATED: fleet-roster -->\r\n```\r\n\r\ncurl -s -X PUT http://localhost:3420/api/messages/1 \\\r\n  -H \"Authorization: Bearer $TOKEN\" \\\r\n  --data-binary '{}'\r\n\r\n## Öntanulás és Skill rendszer\r\n\r\nRetired stock skill section text, kept verbatim for the retired-section sniff.\r\n\r\n<!-- BEGIN GENERATED: fleet-roster (auto-generated, do not edit by hand) -->\r\n- chief\r\n- beta\r\n<!-- END GENERATED: fleet-roster -->\r\n\r\n<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->\r\nGenerated autonomy text with curl -s http://localhost:3420/api/approvals inside a block.\r\n<!-- END GENERATED: autonomy-wiring -->\r\n\r\nLast owner line, AUTH-szabály mention. OZSENTINEL-alpha-2\r\n",
  "agents/beta/CLAUDE.md": "# Beta\n\nOZSENTINEL-beta-1: the amber kettle sings at noon.\n\n<!-- BEGIN GENERATED: message-close (auto-generated, do not edit by hand) -->\nGenerated close text.\n<!-- END GENERATED: message-close -->\n\nAn unclosed fence follows.\n\n```bash\ncurl -s -H \"Authorization: Bearer $(cat @ROOT@/store/.dashboard-token)\" http://localhost:3420/api/kanban # OZSENTINEL-beta-2\n",
  "agents/chief/CLAUDE.md": "# Old draft in agents/<main id>, not an agent\n",
  "agents/gamma/agent-config.json": "{\"team\":{\"reportsTo\":\"chief\"}}\n",
  "agents/hidden-one/.hidden-from-dashboard": "",
  "agents/hidden-one/CLAUDE.md": "# Hidden\n\nOZSENTINEL-hidden-1\n",
  "store/autonomy-config.json": "{\"version\":1,\"categories\":[]}\n",
  "templates/retired-claude-md-sections.json": "{\n  \"_comment\": \"synthetic fixture\",\n  \"## Öntanulás és Skill rendszer\": [\n    \"## Öntanulás és Skill rendszer\\n\\nRetired stock skill section text, kept verbatim for the retired-section sniff.\\n\"\n  ]\n}",
}
// The tree on disk under `root`, plus what git cannot carry well: an agent
// whose CLAUDE.md is not UTF-8 (delta) and an alias symlink into agents/
// (ROSTERALIAS1026: not an agent). Test-only writer.
export function writeDryRunTree(root: string): void {
  for (const [rel, text] of Object.entries(DRY_RUN_TREE)) {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text.replaceAll('@ROOT@', root))
  }
  mkdirSync(join(root, 'agents', 'delta'), { recursive: true })
  // "# Delta\n" then a lone continuation byte on line 3.
  writeFileSync(join(root, 'agents', 'delta', 'CLAUDE.md'), Buffer.from([0x23, 0x20, 0x44, 0x0a, 0x0a, 0x61, 0x80, 0x0a]))
  symlinkSync(join(root, 'agents', 'alpha'), join(root, 'agents', 'alias'))
}
