/**
 * Usage meters: how much of the week's allowance is left.
 *
 * Everything here reads a payload written by somebody else — an undocumented
 * Anthropic endpoint, and Codex's rollout log — so the tests are mostly about
 * what happens when those payloads are not the shape we expect. The rule the
 * whole module follows is that a surprise degrades to "unavailable", never to
 * a confident wrong number, because a quota meter that lies is worse than one
 * that is blank.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  UsageMonitor,
  parseClaudeUsage,
  parseCodexRateLimits,
  readCodexUsage
} from '../src/main/usage.js'
import { percentLeft, primaryWindow, staleness, untilReset } from '../src/shared/usage.js'
import { tempDir } from './helpers.mjs'

/** A response in the current shape, with the self-describing `limits` array. */
function claudeBody(limits) {
  return {
    five_hour: { utilization: 7, resets_at: '2026-09-03T17:00:00Z' },
    seven_day: { utilization: 60, resets_at: '2026-09-08T18:00:00Z' },
    limits
  }
}

const LIMITS = [
  {
    kind: 'session',
    group: 'session',
    percent: 7,
    severity: 'normal',
    resets_at: '2026-09-03T17:00:00Z',
    scope: null
  },
  {
    kind: 'weekly_all',
    group: 'weekly',
    percent: 60,
    severity: 'normal',
    resets_at: '2026-09-08T18:00:00Z',
    scope: null
  },
  {
    kind: 'weekly_scoped',
    group: 'weekly',
    percent: 100,
    severity: 'critical',
    resets_at: '2026-09-08T18:00:00Z',
    scope: { model: { id: null, display_name: 'Opus' } }
  }
]

/** Writes a rollout whose last line carries the given rate-limit payload. */
function writeRollout(home, { day = '03', name = 'rollout-a.jsonl', limits, extra = [] } = {}) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', day)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  const lines = [
    JSON.stringify({ payload: { session_id: 'abc', cwd: '/tmp' } }),
    ...extra,
    ...(limits ? [JSON.stringify({ payload: { type: 'token_count', rate_limits: limits } })] : [])
  ]
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

const CODEX_LIMITS = {
  limit_id: 'codex',
  primary: { used_percent: 18, window_minutes: 10080, resets_at: 1788887771 },
  secondary: { used_percent: 42, window_minutes: 300, resets_at: 1788800000 },
  plan_type: 'pro'
}

describe('reading Claude usage', () => {
  test('every limit window becomes a bar, and weekly is the primary one', () => {
    const u = parseClaudeUsage(claudeBody(LIMITS), 1000)
    assert.equal(u.error, null)
    assert.deepEqual(
      u.windows.map((w) => w.label),
      ['Session', 'Weekly', 'Weekly · Opus']
    )
    assert.equal(primaryWindow(u).label, 'Weekly')
    assert.equal(primaryWindow(u).percentUsed, 60)
    assert.equal(u.observedAt, 1000)
  })

  test("the vendor's own severity wins over our thresholds", () => {
    const u = parseClaudeUsage(claudeBody(LIMITS))
    // 100% would read as critical either way; the point is that the field is
    // consulted, so a limit the API calls fine does not get painted red.
    const scoped = u.windows.find((w) => w.label === 'Weekly · Opus')
    assert.equal(scoped.severity, 'critical')
    assert.equal(u.windows.find((w) => w.label === 'Session').severity, 'normal')
  })

  test('a limit kind we have never seen still gets drawn', () => {
    const u = parseClaudeUsage(
      claudeBody([{ kind: 'monthly_pilot', percent: 12, resets_at: null, scope: null }])
    )
    assert.equal(u.windows.find((w) => w.label === 'Monthly pilot').percentUsed, 12)
    // The named windows are backfilled from the top-level keys whatever the
    // array holds, so an unfamiliar kind joins Session and Weekly instead of
    // standing in for them.
    assert.deepEqual(u.windows.map((w) => w.label), ['Monthly pilot', 'Session', 'Weekly'])
  })

  test('the sole window becomes primary when nothing claims to be weekly', () => {
    // No top-level keys either, so the unfamiliar kind really is all there is
    // and the compact meter would otherwise have nothing to show.
    const u = parseClaudeUsage({
      limits: [{ kind: 'monthly_pilot', percent: 12, resets_at: null, scope: null }]
    })
    assert.equal(u.windows.length, 1)
    assert.equal(u.windows[0].primary, true)
  })

  test('a response predating the limits array falls back to the fixed keys', () => {
    const u = parseClaudeUsage({
      five_hour: { utilization: 7, resets_at: '2026-09-03T17:00:00Z' },
      seven_day: { utilization: 60, resets_at: '2026-09-08T18:00:00Z' }
    })
    assert.deepEqual(
      u.windows.map((w) => w.label),
      ['Session', 'Weekly']
    )
    assert.equal(primaryWindow(u).percentUsed, 60)
  })

  test('a shape we cannot read reports unavailable rather than zero', () => {
    for (const body of [null, 'nope', 42, {}, { limits: [{ kind: 'weekly_all' }] }]) {
      const u = parseClaudeUsage(body)
      assert.notEqual(u.error, null, `expected an error for ${JSON.stringify(body)}`)
      assert.deepEqual(u.windows, [])
    }
  })
})

describe('reading Codex usage', () => {
  test('the weekly window is named and marked primary, whichever slot it is in', () => {
    const u = parseCodexRateLimits(CODEX_LIMITS, 5000)
    assert.equal(u.error, null)
    assert.deepEqual(
      u.windows.map((w) => w.label),
      ['Weekly', '5h']
    )
    assert.equal(primaryWindow(u).label, 'Weekly')
    assert.equal(u.plan, 'pro')
    assert.equal(u.observedAt, 5000)
  })

  test('reset times are seconds here and milliseconds everywhere else', () => {
    const u = parseCodexRateLimits(CODEX_LIMITS, 0)
    assert.equal(primaryWindow(u).resetsAt, 1788887771 * 1000)
  })

  test('a snapshot with only one window is still usable', () => {
    const u = parseCodexRateLimits(
      { primary: { used_percent: 3, window_minutes: 10080, resets_at: null }, secondary: null },
      0
    )
    assert.equal(u.windows.length, 1)
    assert.equal(u.windows[0].primary, true)
    assert.equal(u.windows[0].resetsAt, null)
  })

  test('a snapshot with no numbers reports unavailable', () => {
    for (const raw of [null, {}, { primary: null, secondary: null }]) {
      assert.notEqual(parseCodexRateLimits(raw, 0).error, null)
    }
  })
})

describe('finding the newest Codex snapshot on disk', () => {
  test('reads the most recent rollout that actually recorded limits', async () => {
    const home = await tempDir()
    writeRollout(home, { day: '01', name: 'rollout-old.jsonl', limits: CODEX_LIMITS })
    const u = readCodexUsage(home)
    assert.equal(u.error, null)
    assert.equal(primaryWindow(u).percentUsed, 18)
  })

  test('a session that has started but not answered does not hide an older number', async () => {
    const home = await tempDir()
    writeRollout(home, { day: '01', name: 'rollout-old.jsonl', limits: CODEX_LIMITS })
    // Newer file, header only — exactly what a just-opened Codex pane leaves.
    const fresh = writeRollout(home, { day: '02', name: 'rollout-new.jsonl', limits: null })
    fs.utimesSync(fresh, new Date(), new Date())

    const u = readCodexUsage(home)
    assert.equal(u.error, null, 'should have fallen back to the older rollout')
    assert.equal(primaryWindow(u).percentUsed, 18)
  })

  test('the last snapshot in a file wins, not the first', async () => {
    const home = await tempDir()
    writeRollout(home, {
      limits: CODEX_LIMITS,
      extra: [
        JSON.stringify({
          payload: {
            type: 'token_count',
            rate_limits: { primary: { used_percent: 1, window_minutes: 10080, resets_at: null } }
          }
        })
      ]
    })
    assert.equal(primaryWindow(readCodexUsage(home)).percentUsed, 18)
  })

  test('a truncated or malformed line is skipped, not fatal', async () => {
    const home = await tempDir()
    const file = writeRollout(home, { limits: CODEX_LIMITS })
    fs.appendFileSync(file, '{"payload":{"rate_limits":{"prim\n')
    assert.equal(primaryWindow(readCodexUsage(home)).percentUsed, 18)
  })

  test('no Codex history at all says so instead of throwing', async () => {
    const home = await tempDir()
    const u = readCodexUsage(home)
    assert.notEqual(u.error, null)
    assert.deepEqual(u.windows, [])
  })
})

describe('the monitor', () => {
  /** A monitor wired to fakes, with a counter for how often it pushed. */
  async function makeMonitor({ token = 'tok', body = claudeBody(LIMITS), fail = null } = {}) {
    const home = await tempDir()
    writeRollout(home, { limits: CODEX_LIMITS })
    let pushes = 0
    let calls = 0
    const monitor = new UsageMonitor(
      {
        claudeToken: async () => token,
        fetchJson: async () => {
          calls += 1
          if (fail) throw new Error(fail)
          return body
        },
        home,
        now: () => 9000
      },
      () => {
        pushes += 1
      }
    )
    return { monitor, pushes: () => pushes, calls: () => calls, home }
  }

  test('one refresh reads both agents', async () => {
    const { monitor } = await makeMonitor()
    const r = await monitor.refresh()
    assert.equal(primaryWindow(r.claude).percentUsed, 60)
    assert.equal(primaryWindow(r.codex).percentUsed, 18)
    assert.equal(r.checkedAt, 9000)
  })

  test('an unchanged reading does not push a re-render', async () => {
    const { monitor, pushes } = await makeMonitor()
    await monitor.refresh()
    assert.equal(pushes(), 1, 'the first reading is a change')
    await monitor.refresh()
    assert.equal(pushes(), 1, 'the second reading was identical')
  })

  test('a failed Claude lookup leaves the Codex number alone', async () => {
    const { monitor } = await makeMonitor({ fail: 'network down' })
    const r = await monitor.refresh()
    assert.equal(r.claude.error, 'network down')
    assert.deepEqual(r.claude.windows, [])
    assert.equal(primaryWindow(r.codex).percentUsed, 18, 'Codex reads from disk and is unaffected')
  })

  test('not being signed in is reported as such, without a request', async () => {
    const { monitor, calls } = await makeMonitor({ token: null })
    const r = await monitor.refresh()
    assert.match(r.claude.error, /signed in/i)
    assert.equal(calls(), 0)
  })
})

describe('presenting a window', () => {
  test('remaining is the complement of used, clamped at both ends', () => {
    assert.equal(percentLeft({ percentUsed: 60 }), 40)
    assert.equal(percentLeft({ percentUsed: 0 }), 100)
    // Going over a limit reads as empty, never as a negative bar.
    assert.equal(percentLeft({ percentUsed: 140 }), 0)
  })

  test('reset countdowns are coarse on purpose', () => {
    const now = 0
    assert.equal(untilReset(null, now), null)
    assert.equal(untilReset(-1000, now), 'due now')
    assert.equal(untilReset(90 * 60_000, now), '1h')
    assert.equal(untilReset(26 * 3600_000, now), '1d 2h')
    assert.equal(untilReset(48 * 3600_000, now), '2d')
    assert.equal(untilReset(30_000, now), '1m', 'under a minute still reads as a minute')
  })

  test('a reading is only called stale once it is worth mentioning', () => {
    const now = 10 * 3600_000
    assert.equal(staleness(null, now), null)
    assert.equal(staleness(now - 60_000, now), null, 'a minute old is just current')
    assert.equal(staleness(now - 40 * 60_000, now), '40m ago')
    assert.equal(staleness(now - 3 * 3600_000, now), '3h ago')
  })
})
