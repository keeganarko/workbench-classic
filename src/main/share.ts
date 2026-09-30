/**
 * Session sharing — the server a guest's browser talks to.
 *
 * This is deliberately a *separate* listener from `HookBridge`, not another
 * route mounted on it. The hook bridge is loopback-only and holds one token
 * that grants an agent the right to phone home; this server is reachable from
 * outside the machine and hands its tokens to strangers. Sharing one port
 * between "trusted local agent" and "someone my friend forwarded the link to"
 * is exactly the mistake that turns a viewer into a hook-injection surface.
 *
 * The transport is Server-Sent Events plus ordinary POSTs, which is the widest
 * thing available without adding a WebSocket dependency: SSE is one long-lived
 * GET that any browser speaks natively, and it survives the proxies a tunnel
 * puts in the path.
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

import {
  MAX_GUESTS,
  MAX_INPUT_CHARS,
  SNAPSHOT_INTERVAL_MS,
  SNAPSHOT_LINES,
  isGuestStale,
  mayType,
  sanitizeGuestName,
  type Guest,
  type Share,
  type ShareReach
} from '../shared/share.js'
import { guestPage } from './shareClient.js'

/**
 * What the server needs from the rest of the app, and nothing more.
 *
 * Narrow on purpose: the whole point is that this file can be tested without
 * electron, without tmux, and without a real session — the test supplies three
 * functions and drives real HTTP against a real listener.
 */
export interface ShareHost {
  /** The rendered screen, as a human would see it. Null if the session is gone. */
  snapshot(sessionId: string, lines: number): Promise<string | null>
  /** Types into the session. Only ever called for a promoted guest. */
  write(sessionId: string, data: string): void
  /** Display name for the guest page's title bar. */
  title(sessionId: string): string | null
}

interface Live extends Share {
  /** Open SSE responses, one per watching guest. */
  streams: Map<string, http.ServerResponse>
  /** Last snapshot sent, so an unchanged screen costs nothing. */
  lastFrame: string
}

const TOKEN_BYTES = 24

/** Constant-time compare that cannot throw on a length mismatch. */
function tokenMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export class ShareServer extends EventEmitter {
  private server: http.Server | null = null
  private shares = new Map<string, Live>()
  private timer: NodeJS.Timeout | null = null
  private host: ShareHost
  private _port = 0
  /** Origin the links are built from. A tunnel replaces this when it comes up. */
  private origin = ''

  constructor(host: ShareHost) {
    super()
    this.host = host
  }

  get port(): number {
    return this._port
  }

  async start(): Promise<void> {
    if (this.server) return
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500)
          res.end()
        })
      })
      server.on('error', reject)
      // Loopback only. Reach beyond this machine is the tunnel's job, so that
      // there is exactly one way in and it is one the host switched on — a LAN
      // bind would quietly expose every share to the coffee shop's wifi.
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        this._port = typeof addr === 'object' && addr ? addr.port : 0
        this.origin = `http://127.0.0.1:${this._port}`
        this.server = server
        resolve()
      })
    })
    this.timer = setInterval(() => void this.tick(), SNAPSHOT_INTERVAL_MS)
    // A snapshot loop must never be the reason the app will not quit.
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const share of this.shares.values()) {
      for (const res of share.streams.values()) res.end()
    }
    this.shares.clear()
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }

  /**
   * Replaces the origin every link is built from.
   *
   * Called when a tunnel reports its public hostname. Existing shares keep their
   * tokens — only the prefix changes — so a link already sent stays valid as
   * long as it was a tunnel link to begin with.
   */
  /** The address this server actually listens on, whatever links currently say. */
  get localOrigin(): string {
    return `http://127.0.0.1:${this._port}`
  }

  setOrigin(origin: string, reach: ShareReach): void {
    this.origin = origin.replace(/\/+$/, '')
    for (const share of this.shares.values()) {
      share.reach = reach
      share.url = `${this.origin}/s/${share.token}`
    }
    this.emitChange()
  }

  /** Starts sharing a session, or returns the share it already has. */
  create(sessionId: string): Share {
    const existing = this.shares.get(sessionId)
    if (existing) return publicView(existing)
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex')
    const live: Live = {
      sessionId,
      token,
      createdAt: Date.now(),
      guests: [],
      url: `${this.origin}/s/${token}`,
      reach: 'local',
      streams: new Map(),
      lastFrame: ''
    }
    this.shares.set(sessionId, live)
    this.emitChange()
    return publicView(live)
  }

  /**
   * Ends a share. Every guest's stream is closed rather than left to time out,
   * so "I stopped sharing" is immediate on their screen too.
   */
  destroy(sessionId: string): void {
    const share = this.shares.get(sessionId)
    if (!share) return
    for (const res of share.streams.values()) res.end()
    this.shares.delete(sessionId)
    this.emitChange()
  }

  /**
   * Ends shares whose session no longer exists.
   *
   * The snapshot loop already notices a dead session, but only for a share
   * somebody is watching — it does not poll tmux for an empty room. Without
   * this, closing a session nobody happened to be watching would leave a live
   * token behind pointing at nothing, which is a link that looks valid and is
   * not. Driven off the manager's own change event, so it costs nothing.
   */
  prune(isLive: (sessionId: string) => boolean): void {
    for (const share of [...this.shares.values()]) {
      if (isLive(share.sessionId)) continue
      for (const res of share.streams.values()) {
        sendEvent(res, 'ended', { reason: 'The session has closed.' })
        res.end()
      }
      this.shares.delete(share.sessionId)
      this.emitChange()
    }
  }

  list(): Share[] {
    return [...this.shares.values()].map(publicView)
  }

  get(sessionId: string): Share | null {
    const s = this.shares.get(sessionId)
    return s ? publicView(s) : null
  }

  /** Grants or revokes typing for one guest. Host-only; there is no guest path here. */
  setCanType(sessionId: string, guestId: string, canType: boolean): void {
    const share = this.shares.get(sessionId)
    const guest = share?.guests.find((g) => g.id === guestId)
    if (!share || !guest) return
    guest.canType = canType
    this.pushPresence(share)
    this.emitChange()
  }

  /** Removes a guest and closes their stream. They can rejoin with the link. */
  kick(sessionId: string, guestId: string): void {
    const share = this.shares.get(sessionId)
    if (!share) return
    share.guests = share.guests.filter((g) => g.id !== guestId)
    share.streams.get(guestId)?.end()
    share.streams.delete(guestId)
    this.pushPresence(share)
    this.emitChange()
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private byToken(token: string): Live | null {
    for (const share of this.shares.values()) {
      if (tokenMatches(share.token, token)) return share
    }
    return null
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    // Every route is /s/<token>[/action]; anything else does not exist.
    if (parts[0] !== 's' || parts.length < 2) {
      res.writeHead(404).end()
      return
    }
    const share = this.byToken(parts[1])
    if (!share) {
      // Same response for a wrong token and a share that has ended: a probe
      // should not be able to tell "never existed" from "stopped".
      res.writeHead(404, { 'content-type': 'text/plain' }).end('This link is not active.')
      return
    }
    const action = parts[2] ?? ''

    if (req.method === 'GET' && action === '') {
      const title = this.host.title(share.sessionId) ?? 'Workbench session'
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // The page is served to strangers; give it no reason to load anything
        // else and no way to be framed.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer'
      })
      res.end(guestPage(share.token, title))
      return
    }

    if (req.method === 'POST' && action === 'join') {
      const body = await readJson(req)
      this.join(share, body, res)
      return
    }

    if (req.method === 'GET' && action === 'stream') {
      this.stream(share, url.searchParams.get('g') ?? '', res)
      return
    }

    if (req.method === 'POST' && action === 'input') {
      const body = await readJson(req)
      this.input(share, body, res)
      return
    }

    if (req.method === 'POST' && action === 'leave') {
      const body = await readJson(req)
      const guestId = typeof body?.guestId === 'string' ? body.guestId : ''
      this.kick(share.sessionId, guestId)
      res.writeHead(204).end()
      return
    }

    res.writeHead(404).end()
  }

  private join(share: Live, body: Record<string, unknown> | null, res: http.ServerResponse): void {
    this.reap(share)
    if (share.guests.length >= MAX_GUESTS) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `This session is full (${MAX_GUESTS} people).` }))
      return
    }
    const guest: Guest = {
      id: crypto.randomBytes(12).toString('hex'),
      name: sanitizeGuestName(body?.name),
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
      canType: false
    }
    share.guests.push(guest)
    this.pushPresence(share)
    this.emitChange()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ guestId: guest.id, name: guest.name }))
  }

  private stream(share: Live, guestId: string, res: http.ServerResponse): void {
    const guest = share.guests.find((g) => g.id === guestId)
    if (!guest) {
      res.writeHead(403).end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tunnels and proxies buffer by default, which turns a live view into a
      // view that arrives in lumps. This is the header that stops that.
      'x-accel-buffering': 'no'
    })
    share.streams.get(guestId)?.end()
    share.streams.set(guestId, res)
    guest.lastSeenAt = Date.now()

    res.on('close', () => {
      if (share.streams.get(guestId) === res) share.streams.delete(guestId)
    })

    // Paint immediately rather than making the guest wait for the next tick.
    if (share.lastFrame) sendEvent(res, 'frame', { text: share.lastFrame })
    sendEvent(res, 'presence', presencePayload(share, guestId))
    this.emitChange()
  }

  private input(
    share: Live,
    body: Record<string, unknown> | null,
    res: http.ServerResponse
  ): void {
    const guestId = typeof body?.guestId === 'string' ? body.guestId : ''
    const guest = share.guests.find((g) => g.id === guestId)
    if (!guest) {
      res.writeHead(403).end()
      return
    }
    guest.lastSeenAt = Date.now()
    if (!mayType(guest)) {
      // 403 rather than a silent drop: the guest's UI needs to be able to say
      // "you are watching", not leave them typing into nothing.
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'You are watching. Ask the host for typing access.' }))
      return
    }
    const data = typeof body?.data === 'string' ? body.data.slice(0, MAX_INPUT_CHARS) : ''
    if (data) this.host.write(share.sessionId, data)
    res.writeHead(204).end()
  }

  // ── snapshot loop ─────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    for (const share of this.shares.values()) {
      this.reap(share)
      if (share.streams.size === 0) continue
      const text = await this.host.snapshot(share.sessionId, SNAPSHOT_LINES)
      if (text == null) {
        // The session is gone. Tell the guests rather than freezing the screen.
        for (const res of share.streams.values()) {
          sendEvent(res, 'ended', { reason: 'The session has closed.' })
          res.end()
        }
        this.destroy(share.sessionId)
        continue
      }
      if (text === share.lastFrame) continue
      share.lastFrame = text
      for (const res of share.streams.values()) sendEvent(res, 'frame', { text })
    }
  }

  /** Drops guests whose browser went away without saying so. */
  private reap(share: Live): void {
    const now = Date.now()
    const before = share.guests.length
    share.guests = share.guests.filter((g) => share.streams.has(g.id) || !isGuestStale(g, now))
    if (share.guests.length !== before) {
      this.pushPresence(share)
      this.emitChange()
    }
  }

  private pushPresence(share: Live): void {
    for (const [guestId, res] of share.streams) {
      sendEvent(res, 'presence', presencePayload(share, guestId))
    }
  }

  private emitChange(): void {
    this.emit('change', this.list())
  }
}

/** Strips the server-only fields before anything leaves this module. */
function publicView(share: Live): Share {
  return {
    sessionId: share.sessionId,
    token: share.token,
    createdAt: share.createdAt,
    guests: share.guests.map((g) => ({ ...g })),
    url: share.url,
    reach: share.reach
  }
}

/**
 * What one guest is told about the room. Each guest learns their own typing
 * state and everyone's names — but never another guest's id, which is the only
 * thing that would let them impersonate someone.
 */
function presencePayload(share: Live, guestId: string): unknown {
  const me = share.guests.find((g) => g.id === guestId)
  return {
    you: me ? { name: me.name, canType: me.canType } : null,
    people: share.guests.map((g) => ({ name: g.name, canType: g.canType })),
    max: MAX_GUESTS
  }
}

function sendEvent(res: http.ServerResponse, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  } catch {
    /* the guest's connection went away mid-write; the close handler cleans up */
  }
}

/** Reads a small JSON body. Anything oversized or malformed becomes null. */
async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let raw = ''
    let over = false
    req.on('data', (chunk) => {
      if (over) return
      raw += chunk
      if (raw.length > 64_000) {
        over = true
        resolve(null)
      }
    })
    req.on('end', () => {
      if (over) return
      try {
        const parsed = JSON.parse(raw || '{}')
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}
