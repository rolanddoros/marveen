// C1: the marker pairs of the generated blocks that the v2 region replaces.
//
// Data only. agent-scaffold.ts is not imported (a large module with side
// effects at import); instead a parity test reads the marker constants out of
// src/web/agent-scaffold.ts and src/web/federation/onboarding.ts and asserts
// this list matches them exactly, so a block added upstream cannot slip past
// the legacy removal unnoticed.

export interface MarkerPair {
  id: string
  begin: string
  end: string
}

// The 14 `ensure*Section` blocks of agent-scaffold.ts share one marker shape.
export const LEGACY_GENERATED_IDS = [
  'fleet-roster',
  'autonomy-wiring',
  'mcp-list-channel',
  'evidence-rule',
  'message-close',
  'background-checkpoint',
  'skills-path-trap',
  'system-directive-auth',
  'agent-id-header',
  'thin-chief-handoff',
  'memory-search-label',
  'fleet-auth',
  'strict-api',
  'api-helper',
] as const

function generatedPair(id: string): MarkerPair {
  return {
    id,
    begin: `<!-- BEGIN GENERATED: ${id} (auto-generated, do not edit by hand) -->`,
    end: `<!-- END GENERATED: ${id} -->`,
  }
}

// src/web/federation/onboarding.ts FEDERATION_BLOCK_BEGIN / _END (the main agent's file and every sub's: the
// sub-agents get their own shorter block between the same markers).
export const FEDERATION_MARKERS: MarkerPair = {
  id: 'federation',
  begin: '<!-- MARVEEN-FEDERATION:BEGIN -- kezelt blokk / managed block, do not edit inside -->',
  end: '<!-- MARVEEN-FEDERATION:END -->',
}

export const LEGACY_MARKERS: readonly MarkerPair[] = [
  ...LEGACY_GENERATED_IDS.map(generatedPair),
  FEDERATION_MARKERS,
]
