// C1: the section registry. One ordered list of sections; each decides for
// itself whether it applies to the agent (appliesTo) and renders its own text.
// The registry joins the applicable sections into the body of the ONE v2
// region (render.ts wrapRegion).
//
// The target content (identity, rule index, evidence, helper index, roster /
// federation; design 2.3) is in sections.ts (PR 7b). Nothing outside
// src/web/claude-md and its tests imports this module yet; wiring is PR 10.

import type { AgentDocContext } from './context.js'
import { TemplateError, wrapRegion } from './render.js'
import { DEFAULT_SECTIONS } from './sections.js'

export interface Section {
  // Stable, kebab-case; unique within a registry.
  id: string
  appliesTo(ctx: AgentDocContext): boolean
  render(ctx: AgentDocContext): string
}

export const SECTIONS: readonly Section[] = DEFAULT_SECTIONS

const SECTION_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

// The applicable sections' text, in registry order, separated by one blank
// line. A section that renders to nothing (after trimming trailing newlines)
// is left out, so it cannot leave a stray blank line behind.
export function renderSections(ctx: AgentDocContext, sections: readonly Section[] = SECTIONS): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const s of sections) {
    if (!SECTION_ID_RE.test(s.id)) throw new TemplateError(`invalid section id: ${s.id}`)
    if (seen.has(s.id)) throw new TemplateError(`duplicate section id: ${s.id}`)
    seen.add(s.id)
    if (!s.appliesTo(ctx)) continue
    const text = s.render(ctx).replace(/\n+$/, '')
    if (text.length > 0) parts.push(text)
  }
  return parts.join('\n\n')
}

// The complete v2 region for one agent: BEGIN line, body, END line, LF endings.
export function renderRegion(ctx: AgentDocContext, sections: readonly Section[] = SECTIONS): string {
  return wrapRegion(renderSections(ctx, sections))
}
