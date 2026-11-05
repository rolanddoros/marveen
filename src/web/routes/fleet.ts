import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { exportFleet, importFleet, MIN_VAULT_PASSWORD_LEN, UserFacingError, type ExportedFleet } from '../fleet-transfer.js'
import { serializeSkillsDir } from '../skills-dir-queue.js'
import type { RouteContext } from './types.js'
import { mayIssueCredentials, OWNER_SESSION_REQUIRED } from './auth.js'

export async function tryHandleFleet(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path !== '/api/fleet/export' && path !== '/api/fleet/import') return false

  // Export can carry vault data and import rewrites every agent: both are the owner's, never the
  // shared token every agent holds (fork audit 2026-11-05, server-api-data #1). Same predicate as
  // issuing credentials (mayIssueCredentials, #2163).
  if (!mayIssueCredentials(ctx.auth, req)) {
    logger.warn({ path, method, auth: ctx.auth?.kind, agent: ctx.auth?.agent }, 'Fleet transfer refused: no owner session')
    json(res, OWNER_SESSION_REQUIRED, 403)
    return true
  }

  // H1: vault password via header, not query string (avoids access-log / proxy-log / browser-history leakage)
  const vaultPassword = req.headers['x-vault-password'] as string | undefined

  if (path === '/api/fleet/export' && method === 'GET') {
    if (vaultPassword !== undefined && vaultPassword.length < MIN_VAULT_PASSWORD_LEN) {
      json(res, { error: `X-Vault-Password must be at least ${MIN_VAULT_PASSWORD_LEN} characters.` }, 400)
      return true
    }
    try {
      // The export reads skill directories; it waits for an assign's copy still running.
      const exported: ExportedFleet = await serializeSkillsDir(() => exportFleet({ vaultPassword: vaultPassword || undefined }))
      const buf = Buffer.from(exported.data)
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="fleet-export-${exported.exportedAt.slice(0, 10)}.json"`,
        'Content-Length': buf.byteLength,
      })
      res.end(buf)
    } catch (err: any) {
      if (err instanceof UserFacingError) {
        json(res, { error: err.message }, 400)
      } else {
        logger.error({ err: err.message }, 'Fleet export failed')
        json(res, { error: `Export hiba: ${err.message}` }, 500)
      }
    }
    return true
  }

  if (path === '/api/fleet/import' && method === 'POST') {
    const apply = ctx.url.searchParams.get('apply') === 'true'

    // M1: check vault password length for import side too
    if (vaultPassword !== undefined && vaultPassword.length < MIN_VAULT_PASSWORD_LEN) {
      json(res, { error: `X-Vault-Password must be at least ${MIN_VAULT_PASSWORD_LEN} characters.` }, 400)
      return true
    }

    let rawBody: string
    try {
      const buf = await readBody(req)
      rawBody = buf.toString()
    } catch (err: any) {
      json(res, { error: `Kérés olvasási hiba: ${err.message}` }, 400)
      return true
    }

    // importFleet handles JSON parse (and encrypted blob detection) internally
    try {
      // The import writes skill directories; it waits for an export's zip or an assign's copy still running.
      const result = await serializeSkillsDir(() => importFleet(rawBody, { vaultPassword: vaultPassword || undefined, apply }))
      if ('dryRun' in result && result.errors.length > 0) {
        json(res, result, 400)
      } else {
        json(res, result, 200)
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Fleet import failed')
      json(res, { error: `Import hiba: ${err.message}` }, 500)
    }
    return true
  }

  return false
}
