// C1: the whitelist template renderer and the v2 region frame.
//
// Templates are plain English Markdown under templates/claude-md/ at the repo
// root (not under src/: the build is a bare `tsc`, which copies no .md into
// dist, and every other runtime template already lives in templates/).
//
// The renderer has no logic on purpose: `{{key}}` is the only syntax, there is
// no {{#if}}. Whether a section or a line appears is decided in TypeScript (the
// registry), so the template text stays reviewable as text.
//
// TAB (U+0009) is banned with the C0 class, in values AND in every rendered
// line, so a template indents with spaces, inside code blocks too.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REGION_BEGIN = '<!-- BEGIN MARVEEN GENERATED v2 (do not edit; source: src/web/claude-md) -->'
export const REGION_END = '<!-- END MARVEEN GENERATED v2 -->'

export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateError'
  }
}

// src/web/claude-md/render.ts and dist/web/claude-md/render.js both sit three
// levels below the repo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const TEMPLATES_DIR = join(REPO_ROOT, 'templates', 'claude-md')

const KEY_RE = /^[A-Za-z0-9_]+$/
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g

// Classes of characters a context VALUE may not carry. Values come from
// editable config (agent names, roster roles, the owner name), and the region
// is a trusted block every turn reads: a line break would let a value start a
// new "rule" line, a marker string would let it forge or end the region, and
// the invisible classes would let it hide or reorder what a reviewer sees
// (U+2028/U+202E were flagged on the fork before). One test per class.
const VALUE_CHECKS: readonly { label: string; re: RegExp }[] = [
  { label: 'a line break (LF/CR)', re: /[\n\r]/ },
  { label: 'a C0 control character or DEL', re: /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/ },
  { label: 'a C1 control character (U+0080-U+009F)', re: /[\u0080-\u009F]/ },
  { label: 'a Unicode line or paragraph separator (U+2028/U+2029)', re: /[\u2028\u2029]/ },
  // Unicode Cf (format) is the whole invisible family: the bidi controls (U+202A-U+202E, U+2066-U+2069,
  // U+200E/U+200F, U+061C), the zero-width ones (U+200B-U+200D, U+2060), U+FEFF and U+00AD (Ron, 7a J5).
  // U+034F (combining grapheme joiner) is invisible too but Mn, not Cf, so it is named on its own.
  {
    label: 'an invisible format character (Unicode Cf: bidi, zero-width, U+FEFF, U+00AD) or U+034F',
    re: /[\p{Cf}\u034F]/u,
  },
  { label: 'an HTML comment marker ("<!--" or "-->")', re: /<!--|-->/ },
]

// Throws when `value` may not be rendered into the region; returns it otherwise.
export function checkValue(key: string, value: string): string {
  for (const { label, re } of VALUE_CHECKS) {
    if (re.test(value)) {
      throw new TemplateError(`value of {{${key}}} contains ${label}`)
    }
  }
  return value
}

// Every {{key}} name a template uses, in first-use order, without duplicates.
export function templateKeys(template: string): string[] {
  const keys: string[] = []
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    const key = m[1]
    if (!KEY_RE.test(key)) throw new TemplateError(`invalid placeholder {{${key}}}`)
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

// Fills every {{key}} from `vars` in ONE pass with a function replacer, so a
// value that itself contains "{{x}}" or "$&" stays literal. Strict both ways:
// a placeholder without a value throws, and a value no placeholder uses throws
// (a renamed key must not silently drop text).
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>, name = 'template'): string {
  const used = templateKeys(template)
  for (const key of Object.keys(vars)) {
    if (!used.includes(key)) throw new TemplateError(`${name}: value {{${key}}} is not used by the template`)
  }
  for (const key of used) {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw new TemplateError(`${name}: no value for {{${key}}}`)
    }
    checkValue(key, vars[key])
  }
  return template.replace(PLACEHOLDER_RE, (_m, key: string) => vars[key])
}

// Reads templates/claude-md/<name>.md. A name is a bare file stem: no path
// separators, no dots, so it cannot leave the templates directory.
export function loadTemplate(name: string, dir: string = TEMPLATES_DIR): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new TemplateError(`invalid template name: ${name}`)
  const text = readFileSync(join(dir, `${name}.md`), 'utf-8')
  // One trailing newline is a file convention, not content.
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

// The rendered body may hold line feeds, but nothing else the value check
// forbids, and no comment marker at all: this is the last gate before the
// region frame, so a section that concatenated an unchecked value in
// TypeScript is caught here too.
export function checkBody(body: string): void {
  for (const line of body.split('\n')) {
    for (const { label, re } of VALUE_CHECKS) {
      if (re.test(line)) throw new TemplateError(`rendered body contains ${label}`)
    }
  }
}

// The region always uses LF line endings and ends with exactly one LF,
// whatever the surrounding file uses (compose.ts keeps the owner zone's own
// endings byte for byte).
export function wrapRegion(body: string): string {
  checkBody(body)
  const inner = body.replace(/\n+$/, '')
  return inner.length > 0
    ? `${REGION_BEGIN}\n${inner}\n${REGION_END}\n`
    : `${REGION_BEGIN}\n${REGION_END}\n`
}
