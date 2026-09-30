import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from './helpers.mjs'
import { createTokenReader } from '../src/main/usageTokens.js'
import { quotaWindow, quotaExpired } from '../src/shared/usage.js'
import { parseClaudeUsage, parseCodexRateLimits, readCodexUsage, UsageMonitor } from '../src/main/usage.js'

const NOW = Date.parse('2026-09-05T12:00:00Z')
const at = (days) => new Date(NOW - days * 86400_000).toISOString()
function write(home, relative, rows) {
  const file = path.join(home, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n')
  fs.utimesSync(file, new Date(NOW), new Date(NOW))
  return file
}
function claude(id, days, output = 20) {
  return { type: 'assistant', sessionId: 'claude-session', timestamp: at(days), message: { id, usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 60, cache_creation_input_tokens: 30 } } }
}
const meta = (id, days = 10) => ({ type: 'session_meta', timestamp: at(days), payload: { id, timestamp: at(days) } })
const codex = (days, input, output) => ({ type: 'event_msg', timestamp: at(days), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: input / 2, reasoning_output_tokens: output / 2, total_tokens: input + output } } } })

test('Claude streaming snapshots and copied transcripts count once; cache input is included once', async () => {
  const home = await tempDir()
  const rows = [claude('old', 9), claude('new', 1, 10), claude('new', 1, 20), '{broken']
  write(home, '.claude/projects/test/a.jsonl', rows)
  write(home, '.claude/projects/test/copy.jsonl', rows)
  const report = await createTokenReader()(home, NOW)
  assert.deepEqual(report.claude.last7Days, { input: 100, output: 20, cachedInput: 60, cacheWriteInput: 30 })
  assert.equal(report.claude.sessions['claude-session'].input, 200)
  assert.equal(report.claude.partial, false)
})

test('Codex cumulative differences exclude previous weeks and never add reasoning twice', async () => {
  const home = await tempDir()
  write(home, '.codex/sessions/2026/09/05/rollout-a.jsonl', [meta('codex-session'), codex(9, 100, 20), codex(1, 150, 30), codex(1, 150, 30), codex(.5, 180, 40)])
  const report = await createTokenReader()(home, NOW)
  assert.deepEqual(report.codex.last7Days, { input: 80, output: 20, cachedInput: 40, cacheWriteInput: 0 })
  assert.equal(report.codex.sessions['codex-session'].input, 180)
})

test('inherited Codex history establishes a baseline; archived copies are deduplicated', async () => {
  const home = await tempDir()
  const rows = [meta('child', 2), codex(3, 100, 20), codex(1, 130, 30)]
  write(home, '.codex/sessions/rollout-child.jsonl', rows)
  write(home, '.codex/archived_sessions/rollout-child.jsonl', rows)
  const report = await createTokenReader()(home, NOW)
  assert.equal(report.codex.last7Days.input, 30)
  assert.equal(report.codex.sessions.child.output, 10)
})

test('cached files refresh after append and expire as the rolling week moves', async () => {
  const home = await tempDir()
  const read = createTokenReader()
  const file = write(home, '.claude/projects/test/a.jsonl', [claude('one', 1)])
  assert.equal((await read(home, NOW)).claude.last7Days.output, 20)
  fs.appendFileSync(file, JSON.stringify(claude('two', 0, 30)) + '\n')
  assert.equal((await read(home, NOW)).claude.last7Days.output, 50)
  fs.utimesSync(file, new Date(NOW), new Date(NOW))
  assert.equal((await read(home, NOW + 8 * 86400_000)).claude.last7Days, null)
})

test('absent history remains unknown; untrusted session ids cannot mutate prototypes', async () => {
  const home = await tempDir()
  const read = createTokenReader()
  assert.equal((await read(home, NOW)).claude.last7Days, null)
  write(home, '.claude/projects/test/a.jsonl', [{ ...claude('one', 1), sessionId: '__proto__' }])
  const report = await read(home, NOW)
  assert.equal(Object.getPrototypeOf(report.claude.sessions), Object.prototype)
  assert.equal(Object.hasOwn(report.claude.sessions, '__proto__'), true)
  assert.equal(report.claude.sessions.__proto__.output, 20)
})

test('session and week are distinct, and expired allowance never implies 100% remaining', () => {
  const c = parseClaudeUsage({ five_hour: { utilization: 12 }, seven_day: { utilization: 35 } })
  assert.equal(quotaWindow(c, 'session').percentUsed, 12)
  assert.equal(quotaWindow(c, 'week').percentUsed, 35)
  const x = parseCodexRateLimits({ primary: { used_percent: 50, window_minutes: 10080, resets_at: NOW / 1000 } }, NOW)
  assert.equal(quotaWindow(x, 'session'), null)
  assert.equal(quotaExpired(quotaWindow(x, 'week'), NOW), true)
  assert.equal(quotaExpired(null, NOW), false)
})

test('Codex quota chooses the newest event, not the last file touched by tool output', async () => {
  const home = await tempDir()
  const quota = (days, used) => ({ timestamp: at(days), payload: { type: 'token_count', rate_limits: { primary: { used_percent: used, window_minutes: 10080 } } } })
  write(home, '.codex/sessions/rollout-new.jsonl', [quota(1, 70)])
  const old = write(home, '.codex/sessions/rollout-old.jsonl', [quota(3, 10)])
  fs.utimesSync(old, new Date(NOW + 1000), new Date(NOW + 1000))
  const report = readCodexUsage(home)
  assert.equal(report.windows[0].percentUsed, 70)
  assert.equal(report.observedAt, Date.parse(at(1)))
})

test('a manual refresh during polling awaits the same completed reading', async () => {
  const home = await tempDir()
  let resolve
  let calls = 0
  const pending = new Promise((done) => { resolve = done })
  const monitor = new UsageMonitor({ home, claudeToken: async () => 'test', fetchJson: async () => { calls++; return pending }, now: () => NOW }, () => {})
  const first = monitor.refresh()
  const second = monitor.refresh()
  assert.equal(first, second)
  resolve({ five_hour: { utilization: 25 } })
  assert.equal((await second).claude.windows[0].percentUsed, 25)
  assert.equal(calls, 1)
})

test('a reset cumulative counter starts a new accounting epoch', async () => {
  const home = await tempDir()
  write(home, '.codex/sessions/rollout-reset.jsonl', [meta('reset'), codex(2, 100, 20), codex(1, 10, 2), codex(.5, 25, 5)])
  const report = await createTokenReader()(home, NOW)
  assert.equal(report.codex.last7Days.input, 125)
  assert.equal(report.codex.last7Days.output, 25)
})

test('a throttled quota request retains the last reading and honors retry delay', async () => {
  const home = await tempDir()
  let now = NOW
  let calls = 0
  const monitor = new UsageMonitor({ home, now: () => now, claudeToken: async () => 'test', fetchJson: async () => {
    calls++
    if (calls > 1) throw Object.assign(new Error('Temporarily rate-limited'), { retryAfterMs: 300_000 })
    return { five_hour: { utilization: 25 } }
  } }, () => {})
  await monitor.refresh()
  now += 90_000
  assert.equal((await monitor.refresh()).claude.windows[0].percentUsed, 25)
  now += 90_000
  const report = await monitor.refresh()
  assert.equal(calls, 2)
  assert.match(report.claude.error, /rate-limited/)
  assert.equal(report.claude.observedAt, NOW)
})
