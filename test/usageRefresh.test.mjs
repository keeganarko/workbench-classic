import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { UsageMonitor, parseClaudeUsage, parseCodexAccountUsage, readCodexUsage } from '../src/main/usage.js'
import { queryCodexQuota } from '../src/main/codexUsageSource.js'
import { usageFreshness, quotaWindow } from '../src/shared/usage.js'
import { tempDir } from './helpers.mjs'
import fs from 'node:fs'
import path from 'node:path'

const NOW = Date.parse('2026-09-05T04:00:00Z')
const pool = (used, minutes = 10080) => ({ limitId: 'codex', planType: 'pro', primary: { usedPercent: used, windowDurationMins: minutes, resetsAt: NOW / 1000 + 86400 }, secondary: null })
const body = (used) => ({ rateLimits: pool(used), rateLimitsByLimitId: { codex: pool(used) } })

function processFixture(onRequest) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
  const requests = []
  child.stdin.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      const message = JSON.parse(line)
      requests.push(message)
      queueMicrotask(() => onRequest(message, (value) => child.stdout.write(JSON.stringify(value) + '\n')))
    }
  })
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)))
  return { child, requests }
}

test('live Codex handshake reads account usage without creating a thread or turn', async () => {
  const fixture = processFixture((request, reply) => {
    if (request.method === 'initialize') reply({ id: 1, result: {} })
    if (request.method === 'account/rateLimits/read') reply({ id: 2, result: body(63) })
  })
  const result = await queryCodexQuota(() => fixture.child)
  assert.equal(result.rateLimits.primary.usedPercent, 63)
  assert.deepEqual(fixture.requests.map(x => x.method), ['initialize', 'initialized', 'account/rateLimits/read'])
})

test('server authentication requests cannot be confused with client response ids', async () => {
  const fixture = processFixture((request, reply) => {
    if (request.method === 'initialize') {
      reply({ id: 1, method: 'account/chatgptAuthTokens/refresh', params: {} })
      reply({ id: 1, result: {} })
    }
    if (request.method === 'account/rateLimits/read') reply({ id: 2, result: body(12) })
  })
  await queryCodexQuota(() => fixture.child)
  assert.equal(fixture.requests.filter(x => x.method === 'account/rateLimits/read').length, 1)
  assert.equal(fixture.requests.find(x => x.error)?.error.code, -32601)
})

test('account errors and a hung helper fail explicitly without exposing server diagnostics', async () => {
  const fixture = processFixture((request, reply) => {
    if (request.method === 'initialize') reply({ id: 1, result: {} })
    if (request.method === 'account/rateLimits/read') reply({ id: 2, error: { message: 'private server detail' } })
  })
  await assert.rejects(queryCodexQuota(() => fixture.child), /Live Codex limits unavailable/)
  const hung = processFixture(() => {})
  await assert.rejects(queryCodexQuota(() => hung.child, 10), /timed out/)
})

test('select the main Codex allowance, never substitute Spark for a missing session window', () => {
  const response = body(63)
  response.rateLimits = { ...pool(0, 300), limitId: 'codex_spark' }
  response.rateLimitsByLimitId.codex_spark = response.rateLimits
  const usage = parseCodexAccountUsage(response, NOW)
  assert.equal(quotaWindow(usage, 'week').percentUsed, 63)
  assert.equal(quotaWindow(usage, 'session'), null)
  assert.equal(usage.source, 'account')
  assert.equal(usage.observedAt, NOW)
  assert.notEqual(parseCodexAccountUsage({ rateLimits: response.rateLimits }, NOW).error, null)
})

test('inactive Claude limits do not show a misleading full allowance', () => {
  const usage = parseClaudeUsage({ limits: [{ kind: 'weekly_scoped', percent: 0, is_active: false }, { kind: 'weekly_all', percent: 62, is_active: true }] }, NOW)
  assert.equal(usage.windows.length, 1)
  assert.equal(usage.windows[0].percentUsed, 62)
})

// The response the account actually returns at the start of a week: the weekly
// limit is present and populated, but flagged inactive because nothing has been
// spent yet. Honouring only `limits` blanked the meter's weekly row exactly
// then, which reads as "the meter is broken", not as "the week is untouched".
test('a weekly limit still reports while the week has not started accruing', () => {
  const usage = parseClaudeUsage({
    five_hour: { utilization: 0, resets_at: '2026-09-05T08:00:00Z' },
    seven_day: { utilization: 0, resets_at: '2026-09-08T18:00:00Z' },
    limits: [
      { kind: 'session', percent: 0, resets_at: '2026-09-05T08:00:00Z', is_active: true },
      { kind: 'weekly_all', percent: 0, resets_at: '2026-09-08T18:00:00Z', is_active: false },
      { kind: 'weekly_scoped', percent: 0, resets_at: null, scope: { model: { display_name: 'Fable' } }, is_active: false }
    ]
  }, NOW)
  const week = quotaWindow(usage, 'week')
  assert.equal(week?.percentUsed, 0)
  assert.equal(week?.resetsAt, Date.parse('2026-09-08T18:00:00Z'))
  assert.equal(quotaWindow(usage, 'session')?.percentUsed, 0)
  // The pool this account is not metered on stays hidden rather than adding a
  // third row that looks like independent capacity.
  assert.equal(usage.windows.length, 2)
  assert.equal(week?.primary, true)
})

// The array is authoritative once it carries the window, so the older top-level
// key must not append a duplicate row beside it.
test('a live weekly limit is not duplicated by the top-level key', () => {
  const usage = parseClaudeUsage({
    five_hour: { utilization: 10, resets_at: '2026-09-05T08:00:00Z' },
    seven_day: { utilization: 11, resets_at: '2026-09-08T18:00:00Z' },
    limits: [{ kind: 'weekly_all', percent: 62, resets_at: '2026-09-08T18:00:00Z', is_active: true }]
  }, NOW)
  assert.equal(usage.windows.filter((w) => w.label === 'Weekly').length, 1)
  assert.equal(quotaWindow(usage, 'week')?.percentUsed, 62)
  assert.equal(quotaWindow(usage, 'session')?.percentUsed, 10)
})

test('failed, historical, and old readings are marked directly in the footer', () => {
  const live = parseCodexAccountUsage(body(42), NOW)
  assert.equal(usageFreshness(live, NOW).label, 'Live')
  assert.equal(usageFreshness(live, NOW + 181_000).label, 'Stale')
  assert.equal(usageFreshness({ ...live, source: 'history' }, NOW).label, 'Last turn')
  const failed = usageFreshness({ ...live, error: 'Rate-limited', retryAt: NOW + 300_000 }, NOW)
  assert.equal(failed.label, 'Cached')
  assert.match(failed.detail, /Next attempt in 5m/)
  assert.equal(failed.stale, true)
})

test('routine local polls keep account checks at 90 seconds; manual Refresh obtains a new live reading', async () => {
  const home = await tempDir()
  let now = NOW, claudeCalls = 0, codexCalls = 0
  const monitor = new UsageMonitor({ home, now: () => now, claudeToken: async () => 'fixture', fetchJson: async () => { claudeCalls++; return { five_hour: { utilization: 4 } } }, codexQuota: async () => body(++codexCalls) }, () => {})
  assert.equal((await monitor.refresh()).codex.windows[0].percentUsed, 1)
  now += 15_000
  await monitor.refresh(false)
  assert.equal(codexCalls, 1)
  assert.equal(claudeCalls, 1)
  assert.equal((await monitor.refresh()).codex.windows[0].percentUsed, 2)
  now += 90_000
  await monitor.refresh(false)
  assert.equal(codexCalls, 3)
})

test('Refresh during a local token poll queues one real account check for all callers', async () => {
  const home = tempDir()
  let now = NOW, claudeCalls = 0, codexCalls = 0
  const monitor = new UsageMonitor({ home, now: () => now, claudeToken: async () => 'fixture',
    fetchJson: async () => ({ five_hour: { utilization: ++claudeCalls } }),
    codexQuota: async () => body(++codexCalls) }, () => {})
  await monitor.refresh()
  now += 15_000
  const local = monitor.refresh(false)
  const manual = monitor.refresh()
  assert.equal(monitor.refresh(), manual, 'concurrent button presses share the queued check')
  assert.equal((await local).claude.windows[0].percentUsed, 1)
  assert.equal((await manual).claude.windows[0].percentUsed, 2)
  assert.equal((await manual).codex.windows[0].percentUsed, 2)
  assert.equal(claudeCalls, 2)
  assert.equal(codexCalls, 2)
})

test('when live Codex fails, fallback is identified as history and cannot take a model-specific snapshot', async () => {
  const home = await tempDir()
  const dir = path.join(home, '.codex', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const event = (id, used, timestamp) => JSON.stringify({ timestamp, payload: { type: 'token_count', rate_limits: { limit_id: id, primary: { used_percent: used, window_minutes: 10080 } } } })
  fs.writeFileSync(path.join(dir, 'rollout-test.jsonl'), event('codex', 38, new Date(NOW - 60_000).toISOString()) + '\n' + event('codex_spark', 0, new Date(NOW).toISOString()) + '\n')
  assert.equal(readCodexUsage(home).windows[0].percentUsed, 38)
  const monitor = new UsageMonitor({ home, now: () => NOW, claudeToken: async () => null, fetchJson: async () => null, codexQuota: async () => { throw Error('Network unavailable') } }, () => {})
  const usage = (await monitor.refresh()).codex
  assert.equal(usage.windows[0].percentUsed, 38)
  assert.equal(usage.source, 'history')
  assert.equal(usage.error, 'Network unavailable')
  assert.equal(usageFreshness(usage, NOW).label, 'Cached')
})
