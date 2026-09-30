/**
 * The relay engine: deliver a prompt to another session and, optionally, block
 * until that session finishes its turn.
 *
 * Everything impure is injected. The interesting behaviour here is timing —
 * settle windows, stale turns, deadlock chains — and none of it is testable if
 * the engine reaches for tmux and a real clock itself.
 */

import crypto from 'node:crypto'
import type { SessionStatus } from '../shared/types.js'
import {
  RELAY_SETTLE_MS,
  clampTimeout,
  relayEnvelope,
  trimReply,
  type RelayPhase,
  type RelayRequest,
  type RelayResult
} from '../shared/relay.js'

/** What the relay needs to know about a session. */
export interface RelaySession {
  id: string
  title: string
  alive: boolean
  status: SessionStatus
}

export interface RelayDeps {
  /** Types the text into the target's TUI. Throws if it cannot be delivered. */
  send(sessionId: string, text: string): Promise<void>
  lookup(sessionId: string): RelaySession | null
  /** The target's last assistant message, read after its turn ends. */
  readReply(sessionId: string): Promise<string | null>
  now?: () => number
}

/**
 * A turn is over when the session lands on one of these.
 *
 * `waiting` counts. The target has stopped and will not move again without a
 * human, so continuing to block would burn the whole timeout for nothing.
 */
const TERMINAL: Partial<Record<SessionStatus, RelayPhase>> = {
  review: 'replied',
  waiting: 'waiting',
  failed: 'failed',
  exited: 'failed'
}

/**
 * How long after delivery a terminal status is assumed to belong to the
 * previous turn rather than ours.
 *
 * Hooks arrive over loopback HTTP and can land a few hundred milliseconds late.
 * Without this window, a `Stop` fired by the turn that was already finishing
 * resolves our relay instantly and we hand back the wrong agent's answer — the
 * failure is silent and the text looks plausible, which is the worst kind.
 */
const STALE_TURN_GRACE_MS = 1500

/** How often the settle phase re-reads the target's status. */
const SETTLE_POLL_MS = 250

interface Waiter {
  toSessionId: string
  sentAt: number
  /** When we first saw the target start working on *our* prompt. */
  armedAt: number | null
  settle: (status: SessionStatus, reason: string | null) => void
}

export class Relay {
  private deps: RelayDeps
  private now: () => number
  /** Live blocking waits, keyed by relay id. */
  private waiters = new Map<string, Waiter>()
  /**
   * Who is blocked on whom. This is what makes a cycle detectable: A waiting on
   * B waiting on A is two agents that will both sit there until their timeouts
   * expire, having accomplished nothing and looking, from the outside, busy.
   */
  private blockedOn = new Map<string, string>()

  constructor(deps: RelayDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  /** Sessions currently blocked waiting on another session. For the UI. */
  activeWaits(): { fromSessionId: string; toSessionId: string }[] {
    return [...this.blockedOn.entries()].map(([fromSessionId, toSessionId]) => ({
      fromSessionId,
      toSessionId
    }))
  }

  /**
   * Called by SessionManager on every real status transition.
   *
   * Deliberately not an EventEmitter subscription: the relay must see the
   * transition *after* the session object has been updated, and an ordinary
   * method call makes that ordering explicit at the call site.
   */
  onStatus(sessionId: string, status: SessionStatus, reason: string | null): void {
    for (const w of this.waiters.values()) {
      if (w.toSessionId !== sessionId) continue
      if (status === 'working') {
        // Our prompt was picked up. Everything after this belongs to us.
        if (w.armedAt === null) w.armedAt = this.now()
        continue
      }
      if (!(status in TERMINAL)) continue
      // Either we watched this turn start, or enough time has passed that a
      // straggling hook from the previous turn is no longer a plausible source.
      if (w.armedAt === null && this.now() - w.sentAt < STALE_TURN_GRACE_MS) continue
      w.settle(status, reason)
    }
  }

  /**
   * Would a blocking relay from `from` to `to` close a cycle?
   *
   * Walks the existing chain rather than checking the single hop, because the
   * three-agent version (A→B→C→A) deadlocks exactly as thoroughly as the
   * two-agent one and is far easier to build by accident.
   */
  private cycleThrough(from: string, to: string): string[] | null {
    const path = [from]
    let cur: string | undefined = to
    const seen = new Set<string>()
    while (cur && !seen.has(cur)) {
      path.push(cur)
      if (cur === from) return path
      seen.add(cur)
      cur = this.blockedOn.get(cur)
    }
    return null
  }

  async run(req: RelayRequest, authorize?: () => void): Promise<RelayResult> {
    authorize?.()
    const startedAt = this.now()
    const relayId = crypto.randomUUID()
    const timeoutMs = clampTimeout(req.timeoutMs)

    const target = this.deps.lookup(req.toSessionId)
    const fail = (error: string, toTitle = target?.title ?? req.toSessionId): RelayResult => ({
      ok: false,
      relayId,
      toSessionId: req.toSessionId,
      toTitle,
      phase: 'failed',
      reply: null,
      reason: null,
      error,
      elapsedMs: this.now() - startedAt
    })

    if (!target) return fail('No such session')
    if (!target.alive) return fail(`"${target.title}" has exited`)

    const message = req.message.trim()
    if (!message) return fail('Nothing to send')

    const from = req.fromSessionId ? this.deps.lookup(req.fromSessionId) : null
    const fromTitle = from?.title ?? null

    if (req.wait && req.fromSessionId) {
      if (req.fromSessionId === req.toSessionId) {
        return fail('A session cannot wait on itself')
      }
      if (this.blockedOn.has(req.fromSessionId)) {
        const other = this.deps.lookup(this.blockedOn.get(req.fromSessionId)!)
        return fail(
          `Already waiting on "${other?.title ?? 'another session'}" — one blocking relay at a time`
        )
      }
      const cycle = this.cycleThrough(req.fromSessionId, req.toSessionId)
      if (cycle) {
        const names = cycle.map((id) => this.deps.lookup(id)?.title ?? id).join(' → ')
        return fail(`That would deadlock (${names}). Send without waiting instead.`)
      }
    }

    // Wait for a busy target to finish what it is already doing. Typing into a
    // mid-turn TUI does not queue the way it looks like it does: the characters
    // land in the input box and get submitted with whatever the agent's own
    // next turn produces, which silently merges two unrelated prompts.
    const settleDeadline = startedAt + Math.min(RELAY_SETTLE_MS, timeoutMs)
    while (this.now() < settleDeadline) {
      authorize?.()
      const cur = this.deps.lookup(req.toSessionId)
      if (!cur || !cur.alive) return fail('Target exited before the message was sent')
      if (cur.status !== 'working') break
      await this.sleep(SETTLE_POLL_MS)
    }
    authorize?.()
    const beforeSend = this.deps.lookup(req.toSessionId)
    if (!beforeSend || !beforeSend.alive) {
      return fail('Target exited before the message was sent')
    }
    if (beforeSend.status === 'working') {
      return fail(`"${target.title}" is still mid-turn — try again once it settles`)
    }

    const body = relayEnvelope(fromTitle, message, req.wait)

    // Fire-and-forget: deliver, report, done.
    if (!req.wait) {
      try {
        await this.deps.send(req.toSessionId, body)
      } catch (err) {
        return fail((err as Error).message)
      }
      return {
        ok: true,
        relayId,
        toSessionId: req.toSessionId,
        toTitle: target.title,
        phase: 'delivered',
        reply: null,
        reason: null,
        error: null,
        elapsedMs: this.now() - startedAt
      }
    }

    // Blocking: register the waiter *before* delivering, so a target that
    // answers the instant it is prompted cannot finish before we are listening.
    let cancelTimeout = (): void => {}
    const settled = new Promise<{ status: SessionStatus; reason: string | null } | null>(
      (resolve) => {
        const waiter: Waiter = {
          toSessionId: req.toSessionId,
          sentAt: this.now(),
          armedAt: null,
          settle: (status, reason) => resolve({ status, reason })
        }
        this.waiters.set(relayId, waiter)
        cancelTimeout = this.deadline(timeoutMs, () => resolve(null))
      }
    )
    if (req.fromSessionId) this.blockedOn.set(req.fromSessionId, req.toSessionId)

    try {
      await this.deps.send(req.toSessionId, body)
    } catch (err) {
      cancelTimeout()
      this.release(relayId, req.fromSessionId)
      return fail((err as Error).message)
    }
    // `sentAt` is set at registration; correct it to the real delivery moment so
    // the stale-turn window measures from when the agent could first have seen it.
    const w = this.waiters.get(relayId)
    if (w) w.sentAt = this.now()

    // A bus wait must not hold a grant open after the user revokes it. The
    // same guard also runs while a busy recipient settles, before any text is
    // sent. Already-submitted work cannot be recalled, but no later reply is
    // disclosed and the deadlock bookkeeping is released on every path.
    let guard: ReturnType<typeof setInterval> | undefined
    let outcome: { status: SessionStatus; reason: string | null } | null
    try {
      outcome = authorize ? await Promise.race([settled, new Promise<never>((_, reject) => {
        guard = setInterval(() => { try { authorize() } catch (error) { reject(error) } }, 100)
      })]) : await settled
      authorize?.()
    } finally {
      clearInterval(guard)
      cancelTimeout()
      this.release(relayId, req.fromSessionId)
    }

    if (!outcome) {
      return {
        ok: false,
        relayId,
        toSessionId: req.toSessionId,
        toTitle: target.title,
        phase: 'timeout',
        reply: null,
        reason: null,
        error: `No reply within ${Math.round(timeoutMs / 1000)}s`,
        elapsedMs: this.now() - startedAt
      }
    }

    const phase = TERMINAL[outcome.status] ?? 'failed'
    let reply: string | null = null
    if (phase === 'replied') {
      try {
        reply = trimReply(await this.deps.readReply(req.toSessionId))
      } catch {
        // A turn that completed but whose transcript we cannot read is still a
        // completed turn; say so rather than reporting a failure that did not
        // happen.
        reply = null
      }
    }

    authorize?.()
    return {
      ok: phase === 'replied',
      relayId,
      toSessionId: req.toSessionId,
      toTitle: target.title,
      phase,
      reply,
      reason: outcome.reason,
      error:
        phase === 'failed'
          ? `"${target.title}" ended in ${outcome.status}`
          : phase === 'replied' && !reply
            ? 'Turn finished but no reply text could be read'
            : null,
      elapsedMs: this.now() - startedAt
    }
  }

  private release(relayId: string, fromSessionId: string | null): void {
    this.waiters.delete(relayId)
    if (fromSessionId) this.blockedOn.delete(fromSessionId)
  }

  /** Overridable seam for tests; the real one is just a timer. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
  }

  /**
   * Runs `fire` after `ms` and returns a canceller.
   *
   * Separate from `sleep` because a relay that is answered in two seconds must
   * not leave a thirty-minute timer holding its closure alive; tests override
   * this to drive the timeout without waiting for one.
   */
  protected deadline(ms: number, fire: () => void): () => void {
    const t = setTimeout(fire, ms)
    t.unref?.()
    return () => clearTimeout(t)
  }
}
