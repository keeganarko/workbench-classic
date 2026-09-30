/**
 * Cross-session relay: types and pure helpers.
 *
 * A relay is one session handing work to another and, optionally, blocking
 * until it answers. That is the difference between "I pasted the prompt into
 * the other pane" and two agents actually working in turn.
 */

/**
 * How a relay ended.
 *
 * `waiting` is not a failure and not a success. The target finished its turn by
 * asking for something — an approval, a decision — so there is no reply to hand
 * back, but the message did land and a human can unblock it. Collapsing that
 * into `failed` would send the caller off retrying a delivery that already
 * worked; collapsing it into `replied` would hand back a question as if it were
 * an answer.
 */
export type RelayPhase = 'delivered' | 'replied' | 'waiting' | 'timeout' | 'failed'

export interface RelayRequest {
  /** The session asking. Null when the relay came from the composer. */
  fromSessionId: string | null
  /** Resolved target. Callers that only have a name resolve it first. */
  toSessionId: string
  message: string
  /** Block until the target finishes its turn. */
  wait: boolean
  /** Ceiling on the whole operation, settle time included. */
  timeoutMs: number
}

export interface RelayResult {
  ok: boolean
  relayId: string
  toSessionId: string
  toTitle: string
  phase: RelayPhase
  /** The target's last assistant message. Null unless `phase` is `replied`. */
  reply: string | null
  /** Why the target stopped, when it stopped for a reason worth repeating. */
  reason: string | null
  error: string | null
  elapsedMs: number
}

/** Hard ceiling, so a typo in `--timeout` cannot park a session for a day. */
export const RELAY_MAX_TIMEOUT_MS = 30 * 60_000
export const RELAY_DEFAULT_TIMEOUT_MS = 10 * 60_000
/** How long to let a busy target finish what it is already doing before typing. */
export const RELAY_SETTLE_MS = 90_000
/** Replies are handed to another agent as a prompt, so they cannot be unbounded. */
export const RELAY_MAX_REPLY_CHARS = 24_000

export function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return RELAY_DEFAULT_TIMEOUT_MS
  return Math.min(Math.round(ms), RELAY_MAX_TIMEOUT_MS)
}

/**
 * The banner prepended to a relayed message.
 *
 * Without it the receiving agent reads the text as if its human typed it, and
 * replies into a void — it has no idea another agent is blocked on the answer,
 * or that the answer needs to be self-contained rather than a "yes".
 */
export function relayPreamble(fromTitle: string | null, wait: boolean): string {
  const who = fromTitle ? `the "${fromTitle}" session` : 'the Workbench composer'
  if (!wait) {
    return `[relay from ${who}] Handing this to you. No one is blocked on a reply.`
  }
  return [
    `[relay from ${who}] Another agent is blocked waiting on your answer.`,
    'Reply in this turn, and make the reply self-contained — the sender sees only',
    'your final message, not this conversation.'
  ].join('\n')
}

/** Wraps a message for delivery, banner included. */
export function relayEnvelope(
  fromTitle: string | null,
  message: string,
  wait: boolean
): string {
  return `${relayPreamble(fromTitle, wait)}\n\n${message}`
}

/** Trims a reply to something safe to feed back in as a prompt. */
export function trimReply(reply: string | null): string | null {
  if (!reply) return null
  const t = reply.trim()
  if (!t) return null
  if (t.length <= RELAY_MAX_REPLY_CHARS) return t
  // Keep the tail: an agent's conclusion is at the end of its message.
  return `…(reply truncated)…\n${t.slice(t.length - RELAY_MAX_REPLY_CHARS)}`
}

/** One-line summary for a toast or an agent's stdout. */
export function describeResult(r: RelayResult): string {
  const secs = Math.round(r.elapsedMs / 1000)
  switch (r.phase) {
    case 'replied':
      return `${r.toTitle} replied after ${secs}s`
    case 'delivered':
      return `Delivered to ${r.toTitle}`
    case 'waiting':
      return `${r.toTitle} needs a human: ${r.reason ?? 'waiting for input'}`
    case 'timeout':
      return `${r.toTitle} did not finish within ${secs}s`
    case 'failed':
      return `Relay to ${r.toTitle} failed: ${r.error ?? 'unknown error'}`
  }
}
