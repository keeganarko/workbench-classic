/**
 * Session sharing — types and pure helpers.
 *
 * A share hands one session to up to five other people over a link. Guests get
 * a rendered picture of the terminal and, only if the host promotes them, the
 * ability to type into it.
 *
 * Two decisions are baked into the shapes here and are worth stating once.
 *
 * **Guests watch a snapshot, not the raw stream.** The obvious design is to
 * fan the pty's output to every guest and let them run a terminal emulator.
 * That fails for the thing Workbench actually runs: a full-screen TUI moves the
 * cursor constantly, so the byte stream is meaningless without an emulator, and
 * an emulator is a dependency this repo will not take. tmux already renders the
 * screen for us — `capture-pane` returns what a human would see — so a share
 * ships periodic snapshots of that. Cheap, correct for TUIs, and a guest needs
 * nothing but a browser.
 *
 * **Typing is denied by default and granted per guest.** A share link is a
 * remote-input surface into a terminal running coding agents on the host's
 * machine. Anyone holding the link who could type would have arbitrary code
 * execution as the host. So `canType` starts false for every guest and only the
 * host can flip it, one guest at a time, revocably.
 */

/** Nobody's screen and nobody's attention survives more than this. */
export const MAX_GUESTS = 5

/** Snapshot cadence. Fast enough to feel live, slow enough to stay cheap. */
export const SNAPSHOT_INTERVAL_MS = 400

/** How many lines of scrollback a guest receives. One screenful plus context. */
export const SNAPSHOT_LINES = 200

/** A guest that has not polled within this window is treated as gone. */
export const GUEST_TIMEOUT_MS = 30_000

/** Ceiling on one keystroke payload from a guest. */
export const MAX_INPUT_CHARS = 4096

export interface Guest {
  id: string
  /** What they typed when they joined. Display only — never trusted as identity. */
  name: string
  joinedAt: number
  lastSeenAt: number
  /** False until the host grants it. See the note at the top of this file. */
  canType: boolean
}

export interface Share {
  sessionId: string
  /** Secret path segment. Holding it is what "having the link" means. */
  token: string
  createdAt: number
  guests: Guest[]
  /** Public URL when a tunnel is up; the LAN URL otherwise. */
  url: string | null
  /** How the link currently reaches the outside world. */
  reach: ShareReach
}

/**
 * `local` is the link working on this machine only — the listener binds
 * loopback, so without a tunnel nobody else can open it at all.
 * `tunnel` is a public HTTPS URL via a `cloudflared` quick tunnel.
 * `pending` is a tunnel that has been asked for and has not reported a URL yet.
 */
export type ShareReach = 'local' | 'pending' | 'tunnel'

/**
 * Whether share links currently reach beyond this network.
 *
 * `unavailable` carries a reason because the common case — `cloudflared` is not
 * installed — is fixable by the host in one command, and a bare boolean would
 * leave the UI unable to say which command.
 */
export type TunnelState =
  | { status: 'off' }
  | { status: 'starting' }
  /**
   * `warning` carries the case that used to be invisible: the tunnel really is
   * registered and serving, but something between this machine and the link
   * cannot see it — most often a home router's DNS returning NXDOMAIN for the
   * quick tunnel's subdomain while resolving the apex fine. The link still
   * works for anyone off this network, so this is a note, not a failure.
   */
  | { status: 'up'; url: string; warning?: string }
  | { status: 'unavailable'; reason: string }

/**
 * Names arrive from strangers over the network and are rendered next to the
 * host's own. Strip anything that could be mistaken for chrome — control
 * characters, newlines, angle brackets — and cap the length so a chip cannot be
 * used to push the rest of the presence bar off screen.
 */
export function sanitizeGuestName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
  return cleaned || 'Guest'
}

/**
 * A stable colour per guest so the same person keeps the same chip across a
 * rejoin. Hashing the id rather than the name means two guests called "Sam" are
 * still visually distinct.
 */
export function guestColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 62% 58%)`
}

/** Two initials at most — chips are small and a full name does not fit. */
export function guestInitials(name: string): string {
  const parts = name.split(' ').filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function isGuestStale(guest: Guest, now = Date.now()): boolean {
  return now - guest.lastSeenAt > GUEST_TIMEOUT_MS
}

/**
 * The one place that decides whether a guest may write. Kept as a function
 * rather than an inline `guest.canType` so every caller goes through the same
 * check and a future rule (host is away, session is dead) lands in one place.
 */
export function mayType(guest: Guest | undefined): boolean {
  return Boolean(guest && guest.canType)
}
