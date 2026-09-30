/**
 * Native notification policy.
 *
 * Two behaviours here are the whole point of the file:
 *
 *   **Suppression is per-pane, not per-app.** The old rule was "is the window
 *   focused?", which silenced a notification about session B while you were
 *   deep in session A — precisely the case where you most need telling. A
 *   notification is only dropped when the target session is the pane you are
 *   actually looking at.
 *
 *   **One live notification per session and category.** An agent that flaps
 *   between waiting and working used to produce a column of identical banners.
 *   A newer notification for the same (session, category) replaces the older
 *   one, and stale entries expire so the map cannot grow without bound.
 */

import { Notification } from 'electron'
import type { Session, SessionStatus } from '../shared/types.js'

export type NotifyCategory = 'waiting' | 'failed' | 'review' | 'trigger'

export interface NotifyInput {
  sessionId: string
  title: string
  body: string
  status: SessionStatus
  category?: NotifyCategory
}

export interface NotificationHost {
  /** True when this exact session is on screen *and* has keyboard focus. */
  isPaneFocused(sessionId: string): boolean
  /** Honours the user's "only notify when I'm not looking" preference. */
  suppressWhenFocused(): boolean
  silent(): boolean
  /** Bring the window forward and focus this exact session's tab and pane. */
  focusSession(sessionId: string): void
  onWaiting?(): void
}

interface Tracked {
  notification: Notification
  shownAt: number
  sessionId: string
  category: NotifyCategory
}

/** How long a delivered notification stays tracked for de-duplication. */
const EXPIRY_MS = 60_000

export class NotificationManager {
  private active = new Map<string, Tracked>()
  // Dismissing a banner must not invite the same banner back on the next
  // status sweep. This short memory is separate from the OS object's lifetime:
  // close/click removes the object, while an unchanged message stays quiet.
  private recent = new Map<string, { fingerprint: string; at: number; sessionId: string; category: NotifyCategory }>()
  private sweepTimer: NodeJS.Timeout | null = null
  private host: NotificationHost

  constructor(host: NotificationHost) {
    this.host = host
  }

  private key(sessionId: string, category: NotifyCategory): string {
    return `${sessionId}::${category}`
  }

  private static categoryOf(input: NotifyInput): NotifyCategory {
    if (input.category) return input.category
    if (input.status === 'waiting') return 'waiting'
    if (input.status === 'failed') return 'failed'
    return 'review'
  }

  show(input: NotifyInput): boolean {
    if (!Notification.isSupported()) return false
    // The one case where staying quiet is right: you are already looking at it.
    if (this.host.suppressWhenFocused() && this.host.isPaneFocused(input.sessionId)) return false

    const category = NotificationManager.categoryOf(input)
    const key = this.key(input.sessionId, category)
    this.expire()
    const fingerprint = `${input.title}\n${input.body}`
    if (this.recent.get(key)?.fingerprint === fingerprint) return false

    // Replace rather than stack — a second "needs you" for the same session is
    // the same fact restated, not new information.
    const existing = this.active.get(key)
    if (existing) {
      try {
        existing.notification.close()
      } catch {
        /* already dismissed by the user */
      }
      this.active.delete(key)
    }

    const n = new Notification({
      title: input.title,
      body: input.body,
      silent: this.host.silent(),
      urgency: category === 'waiting' || category === 'failed' ? 'critical' : 'normal'
    })
    // Clicking must land you on the exact session, not merely raise the window.
    n.on('click', () => {
      if (this.active.get(key)?.notification === n) this.active.delete(key)
      this.host.focusSession(input.sessionId)
    })
    n.on('close', () => {
      const cur = this.active.get(key)
      if (cur && cur.notification === n) this.active.delete(key)
    })
    n.show()

    this.active.set(key, { notification: n, shownAt: Date.now(), sessionId: input.sessionId, category })
    this.recent.set(key, { fingerprint, at: Date.now(), sessionId: input.sessionId, category })
    if (category === 'waiting') this.host.onWaiting?.()
    this.ensureSweep()
    return true
  }

  /**
   * A question that was answered is no longer a current notification. Status
   * updates already reach main; reconciling here retracts stale native banners
   * when work resumes, the user clears the Inbox item, or a terminal is removed.
   * It does not acknowledge or mutate any session and cannot approve a tool.
   */
  reconcile(sessions: readonly Pick<Session, 'id' | 'status'>[]): void {
    const states = new Map(sessions.map((session) => [session.id, session.status]))
    for (const [key, tracked] of this.active) {
      const status = states.get(tracked.sessionId)
      if (status && (tracked.category === 'trigger' || tracked.category === status)) continue
      this.active.delete(key)
      try { tracked.notification.close() } catch { /* the OS may already have closed it */ }
    }
    // The same wording can be a genuinely new approval after work resumes.
    // Only suppress repeats within the current status episode, including OS
    // dismissal; do not swallow a later request that happens to look the same.
    for (const [key, recent] of this.recent) {
      const status = states.get(recent.sessionId)
      if (!status || (recent.category !== 'trigger' && recent.category !== status)) this.recent.delete(key)
    }
    this.expire()
  }

  /** Drops tracking for anything older than the expiry window. */
  expire(now = Date.now()): void {
    for (const [key, t] of this.active) {
      if (now - t.shownAt > EXPIRY_MS) {
        this.active.delete(key)
        try { t.notification.close() } catch { /* already closed by the OS */ }
      }
    }
    for (const [key, recent] of this.recent) {
      if (now - recent.at > EXPIRY_MS) this.recent.delete(key)
    }
    if (this.active.size === 0 && this.recent.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.expire(), EXPIRY_MS)
    this.sweepTimer.unref?.()
  }

  /** Number of notifications currently tracked — exposed for tests. */
  get trackedCount(): number {
    return this.active.size
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    for (const { notification } of this.active.values()) {
      try {
        notification.close()
      } catch {
        /* ignore */
      }
    }
    this.active.clear()
    this.recent.clear()
  }
}
