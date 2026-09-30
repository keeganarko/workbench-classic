/**
 * Usage meters — how much of this week's allowance each agent has spent.
 *
 * Neither vendor reports "tokens remaining". Both subscription plans meter an
 * opaque allowance and report a percentage against it, so a percentage is what
 * this module produces; a token count would have to be invented.
 *
 * The two sources are not alike, and the difference is visible in the UI:
 *
 *   - Claude answers a live request. `GET /api/oauth/usage` with the OAuth
 *     token Claude Code already stores returns every active limit window. It
 *     is the same data `/usage` draws, and it is undocumented, so every field
 *     is read defensively and a shape change degrades to "unavailable" rather
 *     than to a wrong number.
 *   - Codex's account API reads current limits without starting a turn. Its
 *     rollout snapshots are a fallback when that API is unavailable; history
 *     is explicitly labeled so it cannot masquerade as a successful live check.
 *
 * No Electron import, and both the HTTP call and the token lookup arrive as
 * injected functions, so the whole module runs under plain `node --test`.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { AgentUsage, UsageReport, UsageWindow } from '../shared/types.js'
import { emptyReport, emptyUsage } from '../shared/usage.js'
import { createTokenReader } from './usageTokens.js'

/** The endpoint `/usage` reads. Undocumented; treated as best-effort. */
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** How often the monitor refreshes while the app is open. */
export const USAGE_POLL_MS = 90_000
/** Token totals can move during a turn without making another network call. */
export const TOKEN_POLL_MS = 15_000

/** Codex rollouts to look back through for a snapshot, newest first. */
const CODEX_ROLLOUTS_TO_SCAN = 5

/** How much of a rollout's tail to read before falling back to the whole file. */
const CODEX_TAIL_BYTES = 256 * 1024

/** Percentages at which a bar stops being reassuring. */
const WARNING_AT = 80
const CRITICAL_AT = 95

/** The vendor's own severity where it gives one, else derived from the number. */
function severityFor(percent: number, given?: unknown): UsageWindow['severity'] {
  if (given === 'critical' || given === 'warning' || given === 'normal') return given
  if (percent >= CRITICAL_AT) return 'critical'
  if (percent >= WARNING_AT) return 'warning'
  return 'normal'
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** ISO-8601 → epoch ms, tolerating the null the API uses for "no reset". */
function isoToMs(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Names a Claude limit window for a one-line meter.
 *
 * The API's `kind` is stable enough to switch on, but new kinds appear without
 * warning, so an unknown one is titled from its own name rather than dropped —
 * a limit you cannot see is worse than one that is awkwardly labelled.
 */
function claudeLabel(kind: unknown, scope: unknown): string {
  const model = isObj(scope) && isObj(scope.model) ? scope.model.display_name : null
  const suffix = typeof model === 'string' && model !== '' ? ` · ${model}` : ''
  if (kind === 'session') return `Session${suffix}`
  if (kind === 'weekly_all') return `Weekly${suffix}`
  if (kind === 'weekly_scoped') return `Weekly${suffix || ' · scoped'}`
  const named = typeof kind === 'string' ? kind.replace(/_/g, ' ') : 'Limit'
  return named.charAt(0).toUpperCase() + named.slice(1) + suffix
}

/**
 * The two named windows the response carries outside the `limits` array.
 *
 * These predate `limits` but are still sent, still populated, and — crucially —
 * carry no `is_active` flag, so they say what the allowance is even when the
 * matching `limits` entry has been marked inactive. Read as a backfill rather
 * than only as a fallback for an old server; see `parseClaudeUsage`.
 */
function namedClaudeWindows(body: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = []
  for (const [key, label, primary] of [
    ['five_hour', 'Session', false],
    ['seven_day', 'Weekly', true]
  ] as const) {
    const w = body[key]
    if (!isObj(w)) continue
    const percent = asNumber(w.utilization)
    if (percent === null) continue
    windows.push({
      label,
      percentUsed: percent,
      resetsAt: isoToMs(w.resets_at),
      severity: severityFor(percent),
      primary
    })
  }
  return windows
}

/**
 * Turns a `/api/oauth/usage` body into meter rows.
 *
 * The `limits` array is the shape to read: it is self-describing, so a limit
 * kind we have never seen still renders.
 *
 * But it is not read alone. `is_active` marks the window the account is being
 * metered against right now, and a weekly limit reports `is_active: false`
 * until the week has actually started accruing — so honouring the flag on its
 * own blanked the meter's weekly row on precisely the days when the allowance
 * was untouched. A blank row reads as a broken meter, not as a full week.
 *
 * So inactive entries are still skipped (a scoped pool the account is not on
 * has no business claiming a row), and then the top-level `five_hour` and
 * `seven_day` keys fill in any named window the array did not yield. A scoped
 * weekly keeps its model suffix, so it never collides with the account-wide
 * `Weekly` and both stay visible when both are real.
 */
export function parseClaudeUsage(body: unknown, now = Date.now()): AgentUsage {
  if (!isObj(body)) return emptyUsage('claude', 'Unrecognised response')

  const windows: UsageWindow[] = []

  if (Array.isArray(body.limits)) {
    for (const raw of body.limits) {
      if (!isObj(raw)) continue
      if (raw.is_active === false) continue
      const percent = asNumber(raw.percent)
      if (percent === null) continue
      windows.push({
        label: claudeLabel(raw.kind, raw.scope),
        percentUsed: percent,
        resetsAt: isoToMs(raw.resets_at),
        severity: severityFor(percent, raw.severity),
        primary: raw.kind === 'weekly_all'
      })
    }
  }

  for (const w of namedClaudeWindows(body)) {
    if (!windows.some((existing) => existing.label === w.label)) windows.push(w)
  }

  if (windows.length === 0) return emptyUsage('claude', 'No limits reported')

  // Weekly is what the meter is for; if the API stopped marking one, promote
  // the largest weekly-looking window rather than showing no primary at all.
  if (!windows.some((w) => w.primary)) {
    const weekly = windows.filter((w) => w.label.startsWith('Weekly'))
    const pick = (weekly.length > 0 ? weekly : windows).reduce((a, b) =>
      b.percentUsed > a.percentUsed ? b : a
    )
    pick.primary = true
  }

  return { agent: 'claude', windows, plan: null, observedAt: now, source: 'account', error: null }
}

/** `10080` → `Weekly`. Codex reports its windows in minutes, not by name. */
function codexLabel(windowMinutes: number | null, fallback: string): string {
  if (windowMinutes === null) return fallback
  if (windowMinutes >= 10_080) {
    const weeks = Math.round(windowMinutes / 10_080)
    return weeks === 1 ? 'Weekly' : `${weeks}-weekly`
  }
  if (windowMinutes >= 1440) {
    const days = Math.round(windowMinutes / 1440)
    return days === 1 ? 'Daily' : `${days}-day`
  }
  if (windowMinutes >= 60) return `${Math.round(windowMinutes / 60)}h`
  return `${windowMinutes}m`
}

function codexWindow(raw: unknown, fallbackLabel: string, primary: boolean): UsageWindow | null {
  if (!isObj(raw)) return null
  const percent = asNumber(raw.used_percent)
  if (percent === null) return null
  const resetsAt = asNumber(raw.resets_at)
  return {
    label: codexLabel(asNumber(raw.window_minutes), fallbackLabel),
    percentUsed: percent,
    // Codex reports seconds since the epoch; everything else here is ms.
    resetsAt: resetsAt === null ? null : resetsAt * 1000,
    severity: severityFor(percent),
    primary
  }
}

/**
 * Turns one `rate_limits` payload from a rollout into meter rows.
 *
 * Codex's own `primary` slot holds the weekly window on every plan seen so far,
 * but that is not promised, so the meter's primary row is chosen by the window
 * length we decoded rather than by which slot it arrived in.
 */
export function parseCodexRateLimits(raw: unknown, observedAt: number): AgentUsage {
  if (!isObj(raw)) return emptyUsage('codex', 'Unrecognised snapshot')

  const windows = [
    codexWindow(raw.primary, 'Primary', true),
    codexWindow(raw.secondary, 'Secondary', false)
  ].filter((w): w is UsageWindow => w !== null)

  if (windows.length === 0) return emptyUsage('codex', 'No limits recorded')

  const weekly = windows.find((w) => w.label === 'Weekly')
  for (const w of windows) w.primary = false
  ;(weekly ?? windows[0]).primary = true

  const plan = typeof raw.plan_type === 'string' ? raw.plan_type : null
  return { agent: 'codex', windows, plan, observedAt, error: null }
}

/** The live API uses camelCase and can report several independent model pools.
 * Select the ordinary Codex pool by its id; Spark's five-hour allowance must
 * never fill in an absent five-hour limit for the rest of the account.
 */
export function parseCodexAccountUsage(body: unknown, now: number): AgentUsage {
  if (!isObj(body)) return emptyUsage('codex', 'Unrecognised account response')
  const pools = isObj(body.rateLimitsByLimitId) ? body.rateLimitsByLimitId : {}
  const raw = pools.codex ?? body.rateLimits
  if (!isObj(raw) || (raw.limitId != null && raw.limitId !== 'codex')) return emptyUsage('codex', 'No Codex account limits reported')
  const convert = (value: unknown): unknown => isObj(value) ? {
    used_percent: value.usedPercent, window_minutes: value.windowDurationMins, resets_at: value.resetsAt
  } : null
  return { ...parseCodexRateLimits({ primary: convert(raw.primary), secondary: convert(raw.secondary), plan_type: raw.planType }, now), source: 'account' }
}

/** The newest rollout files by mtime, without reading any of them. */
function newestRollouts(home: string, limit: number): { file: string; mtime: number }[] {
  const root = path.join(home, '.codex', 'sessions')
  const found: { file: string; mtime: number }[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // Rollouts are filed year/month/day, so descending order reaches today
    // first and the walk stays cheap even with years of history below it.
    for (const e of [...entries].sort((a, b) => b.name.localeCompare(a.name))) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
      try {
        found.push({ file: full, mtime: fs.statSync(full).mtimeMs })
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  walk(root, 0)
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}

/**
 * Reads a file's last `CODEX_TAIL_BYTES`, whole if it is smaller.
 *
 * A long Codex session's rollout runs to megabytes and the snapshot we want is
 * always at the end, so reading the tail keeps a 90-second poll from churning
 * through the whole log.
 */
function readTail(file: string): string {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - CODEX_TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** Depth-first hunt for a `rate_limits` object anywhere in a parsed line. */
function findRateLimits(node: unknown, depth = 0): unknown {
  if (depth > 6 || !isObj(node)) return null
  if (isObj(node.rate_limits)) return node.rate_limits
  for (const v of Object.values(node)) {
    const hit = findRateLimits(v, depth + 1)
    if (hit) return hit
  }
  return null
}

/**
 * The most recent rate-limit snapshot Codex has written.
 *
 * Scans a handful of the newest rollouts rather than only the newest, because
 * a session that has just started has a header but no turn yet, and its empty
 * log should not hide yesterday's perfectly good number.
 */
export function readCodexUsage(home: string = os.homedir()): AgentUsage {
  const files = newestRollouts(home, CODEX_ROLLOUTS_TO_SCAN)
  if (files.length === 0) return emptyUsage('codex', 'No Codex sessions on disk yet')

  let newest: AgentUsage | null = null
  for (const { file, mtime } of files) {
    let text: string
    try {
      text = readTail(file)
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      // Cheap reject first: parsing every line of a megabyte tail is the
      // expensive part, and almost none of them carry limits.
      if (!line.includes('"rate_limits"')) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue // a truncated first line, from starting mid-file
      }
      const limits = findRateLimits(parsed)
      if (!limits) continue
      if (isObj(limits) && limits.limit_id != null && limits.limit_id !== 'codex') continue
      // Appending unrelated output changes mtime without refreshing account
      // limits. Use the event's own timestamp and compare across active logs.
      const observedAt = isObj(parsed) ? isoToMs(parsed.timestamp) ?? mtime : mtime
      const usage = parseCodexRateLimits(limits, observedAt)
      if (usage.error === null) {
        if (!newest || observedAt > (newest.observedAt ?? 0)) newest = { ...usage, source: 'history' }
        break
      }
    }
  }

  return newest ?? emptyUsage('codex', 'No usage recorded yet — run a Codex turn')
}

export interface UsageMonitorDeps {
  /** Returns the OAuth access token, or null when not signed in. */
  claudeToken: () => Promise<string | null>
  /** Injected so tests never reach the network. */
  fetchJson: (url: string, token: string) => Promise<unknown>
  /** Live account API; optional for older CLI installations and offline tests. */
  codexQuota?: () => Promise<unknown>
  home?: string
  now?: () => number
}

/**
 * Keeps a current `UsageReport` and calls `onChange` when it actually changes.
 *
 * The equality check matters: this polls on a timer, and pushing an identical
 * snapshot to the renderer every 90 seconds would re-render the whole tree for
 * nothing.
 */
export class UsageMonitor {
  private report = emptyReport()
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<UsageReport> | null = null
  private inFlightChecksAccounts = false
  private queuedAccountCheck: Promise<UsageReport> | null = null
  private readonly readTokens = createTokenReader()
  private claudeRetryAt = 0
  private claudeNextCheck = 0
  private codexNextCheck = 0
  private readonly deps: UsageMonitorDeps
  private readonly onChange: () => void
  private readonly home: string
  private readonly now: () => number

  constructor(deps: UsageMonitorDeps, onChange: () => void) {
    this.deps = deps
    this.onChange = onChange
    this.home = deps.home ?? os.homedir()
    this.now = deps.now ?? Date.now
  }

  current(): UsageReport {
    return this.report
  }

  start(intervalMs = TOKEN_POLL_MS): void {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(false), intervalMs)
    // Never hold the process open for a status-bar widget.
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** One refresh of both agents. Safe to call while a poll is already running. */
  refresh(forceAccountCheck = true): Promise<UsageReport> {
    // A local token poll may deliberately reuse account limits for 90 seconds.
    // If Refresh arrives during that poll, queue one actual account check:
    // merely awaiting the local poll would leave the button showing old quota.
    // Repeated clicks share the queued request, and provider backoff still wins.
    if (this.inFlight && forceAccountCheck && !this.inFlightChecksAccounts) {
      if (!this.queuedAccountCheck) this.queuedAccountCheck = this.inFlight.then(() => this.refresh(true))
        .finally(() => { this.queuedAccountCheck = null })
      return this.queuedAccountCheck
    }
    if (!this.inFlight) {
      this.inFlightChecksAccounts = forceAccountCheck
      this.inFlight = this.poll(forceAccountCheck).finally(() => { this.inFlight = null })
    }
    return this.inFlight
  }

  private async poll(forceAccountCheck: boolean): Promise<UsageReport> {
    try {
      const [claude, codex, tokens] = await Promise.all([
        this.readClaude(forceAccountCheck), this.readCodexSafely(forceAccountCheck), this.readTokens(this.home, this.now())
      ])
      const next: UsageReport = { claude, codex, tokens, checkedAt: this.now() }
      // `checkedAt` moves every poll by design, so compare everything else.
      const same =
        JSON.stringify({ c: this.report.claude, x: this.report.codex, t: this.report.tokens }) ===
        JSON.stringify({ c: next.claude, x: next.codex, t: next.tokens })
      this.report = next
      if (!same) this.onChange()
      return next
    } catch { return this.report }
  }

  private async readClaude(forceAccountCheck: boolean): Promise<AgentUsage> {
    if (this.now() < this.claudeRetryAt) return this.report.claude
    if (!forceAccountCheck && this.now() < this.claudeNextCheck) return this.report.claude
    this.claudeNextCheck = this.now() + USAGE_POLL_MS
    let token: string | null
    try {
      token = await this.deps.claudeToken()
    } catch (err) {
      return emptyUsage('claude', describe(err))
    }
    if (!token) return emptyUsage('claude', 'Not signed in to Claude')
    try {
      return parseClaudeUsage(await this.deps.fetchJson(CLAUDE_USAGE_URL, token), this.now())
    } catch (err) {
      const retry = isObj(err) ? asNumber(err.retryAfterMs) : null
      if (retry !== null) {
        this.claudeRetryAt = this.now() + retry
        // A throttled lookup says nothing about quota consumption. Preserve the
        // last reading with its age and error, and honor the server's backoff.
        return { ...this.report.claude, retryAt: this.claudeRetryAt, error: describe(err) }
      }
      return emptyUsage('claude', describe(err))
    }
  }

  private async readCodexSafely(forceAccountCheck: boolean): Promise<AgentUsage> {
    let liveError: string | null = null
    if (this.deps.codexQuota) {
      if (!forceAccountCheck && this.now() < this.codexNextCheck && this.report.codex.source === 'account') return this.report.codex
      if (forceAccountCheck || this.now() >= this.codexNextCheck) {
        this.codexNextCheck = this.now() + USAGE_POLL_MS
        try {
          const live = parseCodexAccountUsage(await this.deps.codexQuota(), this.now())
          if (!live.error) return live
          liveError = live.error
        } catch (error) { liveError = describe(error) }
      } else liveError = this.report.codex.error
    }
    try {
      const history = readCodexUsage(this.home)
      return liveError ? { ...history, error: liveError } : history
    } catch (err) {
      return emptyUsage('codex', describe(err))
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
