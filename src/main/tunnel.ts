/**
 * Public reach for a share link.
 *
 * A share link has to work for someone who is not on this network, and this app
 * cannot be the thing that solves NAT traversal. `cloudflared` already does it,
 * ships as a single binary, and its quick-tunnel mode needs no account: it
 * prints an `https://<random>.trycloudflare.com` hostname that proxies to a
 * local port until the process exits.
 *
 * So this module is deliberately thin — spawn it, read the hostname off its
 * output, hand it back, and kill it when sharing stops. Everything about
 * certificates, NAT and DNS is the tunnel's problem, not ours.
 *
 * **If `cloudflared` is not installed there is no public link.** That is
 * reported as a state, not thrown: the link still opens on this machine, and
 * the UI tells the host the one command that upgrades it.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { Resolver } from 'node:dns/promises'
import https from 'node:https'

import type { TunnelState } from '../shared/share.js'
import { EventEmitter } from 'node:events'

/** Where the hostname appears in cloudflared's banner. */
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

/** The line cloudflared prints once an edge connection actually exists. */
const CONNECTED_PATTERN = /Registered tunnel connection/i

/** Long enough for a cold binary on a slow link, short enough to fail visibly. */
const START_TIMEOUT_MS = 45_000

/**
 * How long to keep asking the edge before handing the link over anyway.
 *
 * A quick tunnel is routable a second or two after it registers, but not
 * instantly, and the window in between is exactly when a host copies the link.
 */
const VERIFY_BUDGET_MS = 20_000
const VERIFY_INTERVAL_MS = 1_500
const VERIFY_TIMEOUT_MS = 6_000

/**
 * Cloudflare's status for "this hostname is routed, but no tunnel is connected
 * behind it" — error 1033, served as HTTP 530. It is the single most likely
 * thing a guest sees, because it is what every link from a previous run of the
 * app becomes the moment that run ends.
 */
const NO_TUNNEL_STATUS = 530

/** Resolvers used for the check, so a filtering router cannot fake a failure. */
const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8']

export type { TunnelState } from '../shared/share.js'

export class Tunnel extends EventEmitter {
  private proc: ChildProcess | null = null
  private _state: TunnelState = { status: 'off' }
  private timer: NodeJS.Timeout | null = null
  /** Set once cloudflared reports an edge connection, not merely a hostname. */
  private connected = false
  /**
   * Resolves the binary at start time, not construction time.
   *
   * A GUI app on macOS starts with a bare PATH, so `cloudflared` installed by
   * Homebrew is invisible to a bare `spawn('cloudflared')` — the exact case
   * this feature is for. The caller supplies the lookup, and it runs late
   * because the login PATH is probed after this object is built. Tests inject
   * a name that will not resolve, so the real binary is never spawned there.
   */
  private locate: () => string | null

  constructor(locate: string | (() => string | null) = 'cloudflared') {
    super()
    this.locate = typeof locate === 'function' ? locate : () => locate
  }

  get state(): TunnelState {
    return this._state
  }

  private set(state: TunnelState): void {
    this._state = state
    this.emit('state', state)
  }

  /**
   * Brings up a quick tunnel to `port`. Resolves as soon as a hostname appears,
   * or with an `unavailable` state — never rejects, because a missing optional
   * binary is a normal condition and not an error the caller should catch.
   */
  async start(port: number): Promise<TunnelState> {
    if (this._state.status === 'up') return this._state
    this.stop()
    this.connected = false
    this.set({ status: 'starting' })

    return new Promise<TunnelState>((resolve) => {
      let settled = false
      const finish = (state: TunnelState): void => {
        if (settled) return
        settled = true
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        this.set(state)
        resolve(state)
      }

      const binary = this.locate()
      if (!binary) {
        finish({ status: 'unavailable', reason: notInstalled() })
        return
      }

      let proc: ChildProcess
      try {
        proc = spawn(
          binary,
          ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        )
      } catch {
        finish({ status: 'unavailable', reason: notInstalled() })
        return
      }
      this.proc = proc

      // cloudflared prints its banner to stderr, but has moved it before.
      let url: string | null = null
      const onChunk = (chunk: Buffer): void => {
        const text = chunk.toString()
        if (CONNECTED_PATTERN.test(text)) this.connected = true
        const match = URL_PATTERN.exec(text)
        if (match && !url) {
          url = match[0]
          // Deliberately not resolved here. cloudflared prints the hostname
          // when it *claims* the name, which is before an edge connection
          // exists behind it — and a link copied in that window serves the
          // guest a Cloudflare 1033 page. So the URL is withheld until it has
          // answered a real request.
          void this.verify(url).then(finish)
        }
      }
      proc.stdout?.on('data', onChunk)
      proc.stderr?.on('data', onChunk)

      proc.on('error', () => finish({ status: 'unavailable', reason: notInstalled() }))
      proc.on('exit', (code) => {
        if (this.proc === proc) this.proc = null
        finish({
          status: 'unavailable',
          reason: `cloudflared exited (${code ?? 'signal'}) before publishing a URL.`
        })
        // An established tunnel that dies later must not leave the UI claiming
        // a public link that no longer resolves.
        if (this._state.status === 'up') this.set({ status: 'off' })
      })

      this.timer = setTimeout(() => {
        finish({
          status: 'unavailable',
          reason: 'cloudflared did not publish a URL in time.'
        })
      }, START_TIMEOUT_MS)
      this.timer.unref?.()
    })
  }

  /**
   * Waits for the published hostname to actually serve, and only then hands it
   * over.
   *
   * Three things can be true at once here, and they used to be indistinguishable:
   * the tunnel is registered but not yet routable (Cloudflare answers 1033);
   * the tunnel is fine but *this* machine cannot resolve the name, because a
   * home router's DNS proxy NXDOMAINs `trycloudflare.com` subdomains while
   * resolving the apex; or the tunnel is genuinely serving.
   *
   * The check is therefore made against public resolvers with the address
   * pinned, so the host's own DNS cannot produce a false failure, and a 1033 is
   * read as "not yet" rather than as an answer. Only a real response from the
   * share server ends the wait.
   *
   * If the budget runs out the link is still handed over — a tunnel that has
   * not answered yet is not proof of a broken one — but it carries a warning
   * saying what was seen, and the dialog stops promising it works.
   */
  private async verify(url: string): Promise<TunnelState> {
    const deadline = Date.now() + VERIFY_BUDGET_MS
    let last = 'The public link did not answer before we gave up waiting.'

    while (Date.now() < deadline) {
      // No edge connection yet means every request is a guaranteed 1033, so
      // there is nothing to learn from asking.
      if (!this.connected) {
        await delay(VERIFY_INTERVAL_MS)
        continue
      }
      const result = await reachable(url)
      if (result.ok) return { status: 'up', url }
      last = result.reason
      await delay(VERIFY_INTERVAL_MS)
    }
    return { status: 'up', url, warning: last }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const proc = this.proc
    this.proc = null
    if (proc) {
      try {
        // Windows has no signals; Node emulates `kill()` with `TerminateProcess`
        // on the direct child alone. cloudflared is spawned directly, so that
        // would usually be enough — but a quick tunnel that re-execs itself on
        // update would be left running, holding the port and the hostname. The
        // process tree is the thing being stopped, so ask for the tree.
        if (process.platform === 'win32' && proc.pid) {
          spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)], {
            stdio: 'ignore',
            windowsHide: true
          }).on('error', () => proc.kill())
        } else {
          proc.kill()
        }
      } catch {
        /* already gone */
      }
    }
    if (this._state.status !== 'off') this.set({ status: 'off' })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

/**
 * Asks the edge whether the hostname is actually serving yet.
 *
 * Resolution goes to public resolvers with the answer pinned onto the request,
 * because the host's own DNS is not trustworthy for this question: a router
 * that NXDOMAINs the subdomain would otherwise make a perfectly good tunnel
 * look dead, and the host would stop sharing something their friend could see
 * fine. TLS still validates against the real hostname via SNI, so pinning the
 * address costs nothing in safety.
 */
export async function reachable(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { hostname, port } = new URL(url)

  let addresses: string[]
  try {
    addresses = await resolvePublicly(hostname)
  } catch {
    return {
      ok: false,
      reason:
        'The tunnel hostname does not resolve anywhere yet. It is usually a second behind — if this persists, stop and start the share to get a new one.'
    }
  }

  return interpretStatus(await statusOf(url, hostname, addresses[0], port || '443'))
}

/**
 * What a status code from the edge means for the host.
 *
 * Any answer at all proves the whole path works — the share server's own 404
 * for `/` is as good a proof as a 200 — with the one exception that proves the
 * opposite.
 */
export function interpretStatus(
  status: number | null
): { ok: true } | { ok: false; reason: string } {
  if (status === null) {
    return { ok: false, reason: 'The public link did not answer a test request.' }
  }
  if (status === NO_TUNNEL_STATUS) return { ok: false, reason: describeNoTunnel() }
  return { ok: true }
}

/** The 1033 page, in words a host can act on. */
export function describeNoTunnel(): string {
  return 'Cloudflare is serving error 1033 for this link — the address exists but no tunnel is connected behind it. Links from an earlier run of Workbench always end up here, because the hostname changes every time. Stop and start the share to get a live one.'
}

/**
 * Resolves against public DNS, never the system resolver.
 *
 * Measured on this machine: the gateway returns NXDOMAIN for quick-tunnel
 * subdomains while resolving `trycloudflare.com` itself, so the system resolver
 * cannot answer the only question this check asks.
 */
async function resolvePublicly(hostname: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 3_000, tries: 2 })
  resolver.setServers(PUBLIC_RESOLVERS)
  const addresses = await resolver.resolve4(hostname)
  if (addresses.length === 0) throw new Error('no addresses')
  return addresses
}

/**
 * One HTTPS GET at a pinned address, returning the status or null if nothing
 * answered. Any status at all proves the path works — the share server's own
 * 404 for `/` is as good a proof as a 200 — except 1033, which proves the
 * opposite.
 */
function statusOf(
  url: string,
  hostname: string,
  address: string,
  port: string
): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: number | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = https.request(
      {
        host: address,
        port: Number(port),
        servername: hostname,
        path: new URL(url).pathname || '/',
        method: 'GET',
        headers: { Host: hostname, 'user-agent': 'Workbench-share-check' },
        timeout: VERIFY_TIMEOUT_MS
      },
      (res) => {
        res.resume()
        done(res.statusCode ?? null)
      }
    )
    req.on('timeout', () => {
      req.destroy()
      done(null)
    })
    req.on('error', () => done(null))
    req.end()
  })
}

function notInstalled(): string {
  // Deliberately not `installHint()`: that one answers for the *host*, and
  // cloudflared is the one binary that has to live on this side of the WSL
  // boundary. Telling a Windows user to `sudo apt install cloudflared` inside
  // the distro would produce a tunnel that cannot see the server it is for.
  const how =
    process.platform === 'win32'
      ? 'Install it with `winget install --id Cloudflare.cloudflared`'
      : process.platform === 'darwin'
        ? 'Install it with `brew install cloudflared`'
        : 'Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
  return `cloudflared is not installed, so this link only opens on this machine. ${how}, then share again.`
}
