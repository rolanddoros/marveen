// LOCALHOST STUB BINDING (B2-1). A test that starts an HTTP stub and then runs a child (python, curl, a shipped
// script) that connects to "localhost" must listen where that child will connect. The child resolves "localhost"
// through getaddrinfo, and the answer is host-specific: one host gives ::1 first, another (this one: /etc/hosts maps
// localhost to 127.0.0.1 only) gives 127.0.0.1 alone, and an IPv4-only host cannot even bind ::1. Hard-coding either
// family makes the test pass on one kind of host and fail on the other.
//
// So: bind the stub on EVERY address localhost resolves to on this host, all on the same port. dns.lookup uses the
// same getaddrinfo as the child, so the child's address list is a subset of ours, whichever it tries first.
import { lookup as dnsLookup } from 'node:dns'
import type { Server } from 'node:http'

type LookupAll = (host: string, opts: { all: true }) => Promise<Array<{ address: string; family: number }>>

const defaultLookup: LookupAll = (host, opts) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, opts, (err, addrs) => (err ? reject(err) : resolve(addrs))),
  )

/** The distinct addresses "localhost" resolves to here, IPv4 first (deterministic order, the first one picks the port). */
export async function localhostAddresses(lookup: LookupAll = defaultLookup): Promise<string[]> {
  const addrs = await lookup('localhost', { all: true })
  const ordered = [...addrs.filter((a) => a.family === 4), ...addrs.filter((a) => a.family !== 4)]
  const out = [...new Set(ordered.map((a) => a.address))]
  if (out.length === 0) throw new Error('localhost resolves to no address on this host')
  return out
}

function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

/**
 * Starts one server per localhost address, all on the same (ephemeral) port; returns the port and the servers so
 * the caller can close every one of them. `makeServer` is called once per address and must return a fresh,
 * not-yet-listening server sharing the same handler.
 */
export async function listenOnLocalhost(
  makeServer: () => Server,
  lookup: LookupAll = defaultLookup,
): Promise<{ port: number; servers: Server[]; addresses: string[] }> {
  const addresses = await localhostAddresses(lookup)
  const servers: Server[] = []
  try {
    const first = makeServer()
    await listenOn(first, 0, addresses[0])
    servers.push(first)
    const port = (first.address() as { port: number }).port
    for (const host of addresses.slice(1)) {
      const s = makeServer()
      await listenOn(s, port, host)
      servers.push(s)
    }
    return { port, servers, addresses }
  } catch (err) {
    await closeAll(servers)
    throw err
  }
}

export async function closeAll(servers: Server[]): Promise<void> {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
}
