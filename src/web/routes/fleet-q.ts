import { listAgentNames, readAgentCapabilities, writeAgentCapabilities, isKnownAgent } from '../agent-config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { mayActAsOwner, OWNER_SESSION_REQUIRED } from './auth.js'
import type { RouteContext } from './types.js'

// GET /.well-known/fleetq
// Machine-readable fleet capability manifest. Requires Bearer auth (enforced
// by the auth gate in web.ts before this handler is reached) so the agent
// roster is not visible to unauthenticated callers on LAN-exposed instances.
//
// PUT /api/agents/:name/capabilities
// Update a specific agent's capability tags at runtime. Body: { "capabilities": string[] }
// The owner only once a dashboard login exists (mayActAsOwner, kanban 8f51c983): the tags land in every peer
// agent's CLAUDE.md, and the shared Bearer token is held by every agent while AGENT_TOKENS is off.
export async function tryHandleFleetQ(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/.well-known/fleetq' && method === 'GET') {
    const manifest: Record<string, string[]> = {}
    for (const name of listAgentNames()) {
      manifest[name] = readAgentCapabilities(name)
    }
    json(res, manifest)
    return true
  }

  const capMatch = path.match(/^\/api\/agents\/([^/]+)\/capabilities$/)
  if (capMatch && method === 'PUT') {
    // Before the agent-exists check and the body: a non-owner learns nothing about which names exist.
    if (!mayActAsOwner(ctx.auth, req)) {
      logger.warn({ path, method, auth: ctx.auth?.kind, agent: ctx.auth?.agent }, 'Capabilities update refused: no owner session')
      json(res, OWNER_SESSION_REQUIRED, 403)
      return true
    }
    const name = decodeURIComponent(capMatch[1])
    if (!isKnownAgent(name)) { json(res, { error: 'Agent nem található' }, 404); return true }
    const body = await readBody(req)
    const parsed = JSON.parse(body.toString()) as { capabilities?: unknown }
    if (!Array.isArray(parsed.capabilities) || !parsed.capabilities.every((c: unknown) => typeof c === 'string')) {
      json(res, { error: 'capabilities: string[] required' }, 400)
      return true
    }
    writeAgentCapabilities(name, parsed.capabilities)
    json(res, { ok: true, capabilities: parsed.capabilities })
    return true
  }

  return false
}
