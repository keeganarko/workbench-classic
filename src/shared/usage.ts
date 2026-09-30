/**
 * The parts of the usage meter both sides need.
 *
 * Main produces the report and the renderer draws it, so the empty states and
 * the wording of a window live here rather than being written twice and
 * drifting apart.
 */

import type { AgentUsage, UsageReport, UsageWindow } from './types.js'

/** An agent with nothing to report yet, which is the state at launch. */
export function emptyUsage(agent: AgentUsage['agent'], error: string | null = null): AgentUsage {
  return { agent, windows: [], plan: null, observedAt: null, error }
}

export function emptyReport(): UsageReport {
  return { claude: emptyUsage('claude'), codex: emptyUsage('codex'), checkedAt: null }
}

/** The window a one-line meter should show: the weekly one, by construction. */
export function primaryWindow(usage: AgentUsage): UsageWindow | null {
  return usage.windows.find((w) => w.primary) ?? usage.windows[0] ?? null
}

/** Never substitute a weekly limit for an unreported five-hour window. Some
 * plans expose only one, and a second copy would look like independent capacity.
 */
export function quotaWindow(usage: AgentUsage, period: 'session' | 'week'): UsageWindow | null {
  return usage.windows.find((w) => period === 'week' ? w.label === 'Weekly' : w.label === 'Session' || w.label === '5h') ?? null
}

/** A passed reset does not prove the allowance is full again. */
export function quotaExpired(window: UsageWindow | null, now: number): boolean {
  return window?.resetsAt != null && window.resetsAt <= now
}

/** Put freshness in the always-visible bar, not only in the details dialog.
 * A failed refresh must never make the previous percentage look like live data.
 */
export function usageFreshness(usage: AgentUsage, now: number): { label: string; detail: string; stale: boolean } {
  const age = usage.observedAt === null ? null : Math.max(0, now - usage.observedAt)
  const when = age === null ? 'No reading yet' : age < 60_000 ? 'Updated just now' : `Updated ${Math.floor(age / 60_000)}m ago`
  if (usage.error) {
    const retry = usage.retryAt && usage.retryAt > now ? ` Next attempt in ${untilReset(usage.retryAt, now)}.` : ''
    return { label: usage.windows.length ? 'Cached' : 'Unavailable', detail: `${usage.error}${retry} ${when}.`, stale: true }
  }
  if (age === null) return { label: 'Checking', detail: 'Waiting for the first provider reading.', stale: false }
  if (usage.source === 'history') return { label: 'Last turn', detail: `From local turn history. ${when}.`, stale: true }
  if (age >= 3 * 60_000) return { label: 'Stale', detail: `${when}. Waiting for a new account reading.`, stale: true }
  return { label: 'Live', detail: `${when} from the provider account.`, stale: false }
}

/** Percentage still available, floored at zero — an over-quota bar reads 0%. */
export function percentLeft(w: UsageWindow): number {
  return Math.max(0, Math.min(100, 100 - w.percentUsed))
}

/**
 * "2d 4h", "3h", "12m" — how long until a window rolls over.
 *
 * Deliberately coarse. The exact minute a weekly limit resets is never the
 * question being asked; "can I keep working today" is.
 */
export function untilReset(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null
  const ms = resetsAt - now
  if (ms <= 0) return 'due now'
  const mins = Math.floor(ms / 60_000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h`
  return `${Math.max(1, mins)}m`
}

/**
 * How old a reading is, or null when it is fresh enough not to mention.
 *
 * Only Codex can go stale — its numbers come from its last recorded turn — so
 * saying nothing under the threshold keeps the meter quiet in the normal case.
 */
export function staleness(observedAt: number | null, now: number, thresholdMs = 15 * 60_000): string | null {
  if (observedAt === null) return null
  const ms = now - observedAt
  if (ms < thresholdMs) return null
  const mins = Math.floor(ms / 60_000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  return `${mins}m ago`
}
