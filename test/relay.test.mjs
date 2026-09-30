import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Relay } from '../src/main/relay.ts'
import {
  clampTimeout,
  relayEnvelope,
  trimReply,
  describeResult,
  RELAY_MAX_TIMEOUT_MS,
  RELAY_DEFAULT_TIMEOUT_MS,
  RELAY_MAX_REPLY_CHARS
} from '../src/shared/relay.ts'

/**
 * A relay driven by a fake clock and manual status transitions.
 *
 * The engine's `sleep`/`deadline` seams are overridden so a "ten minute
 * timeout" resolves instantly — otherwise every timing test would have to
 * actually wait, and the suite could not assert on the timing at all.
 */
class TestRelay extends Relay {
  constructor(deps) {
    super(deps)
    this.slept = []
    this.deadlines = []
  }
  sleep(ms) {
    this.slept.push(ms)
    return Promise.resolve()
  }
  deadline(ms, fire) {
    const entry = { ms, fire, cancelled: false, fired: false }
    this.deadlines.push(entry)
    return () => {
      entry.cancelled = true
    }
  }
  /**
   * Fires the most recent live timeout.
   *
   * Marks it spent immediately rather than waiting for the engine's canceller:
   * that only runs a microtask later, so two back-to-back `expire()` calls
   * would otherwise fire the same deadline twice and leave the other relay
   * hanging forever.
   */
  expire() {
    const d = this.deadlines.filter((x) => !x.cancelled && !x.fired).at(-1)
    assert.ok(d, 'no live deadline to expire')
    d.fired = true
    d.fire()
  }
}

function world(sessions) {
  const map = new Map(sessions.map((s) => [s.id, { ...s }]))
  const sent = []
  return {
    map,
    sent,
    deps: {
      send: async (id, text) => {
        sent.push({ id, text })
        const s = map.get(id)
        if (!s) throw new Error('gone')
        s.status = 'working'
      },
      lookup: (id) => (map.has(id) ? { ...map.get(id) } : null),
      readReply: async (id) => map.get(id)?.reply ?? null
    }
  }
}

const LIVE = (id, title, status = 'idle', extra = {}) => ({
  id,
  title,
  alive: true,
  status,
  ...extra
})

// ── pure helpers ─────────────────────────────────────────────────────────

test('clampTimeout defends against nonsense', () => {
  assert.equal(clampTimeout(undefined), 600000)
  assert.equal(clampTimeout(0), 600000)
  assert.equal(clampTimeout(-5), 600000)
  assert.equal(clampTimeout(NaN), 600000)
  assert.equal(clampTimeout(5000), 5000)
  assert.equal(clampTimeout(1e12), RELAY_MAX_TIMEOUT_MS)
})

test('the envelope tells the recipient someone is blocked', () => {
  const waiting = relayEnvelope('Reviewer', 'check this', true)
  assert.match(waiting, /blocked waiting on your answer/)
  assert.match(waiting, /"Reviewer"/)
  assert.match(waiting, /check this$/)

  const loose = relayEnvelope('Reviewer', 'check this', false)
  assert.match(loose, /No one is blocked/)
})

test('a composer relay names the composer, not a session', () => {
  assert.match(relayEnvelope(null, 'x', false), /Workbench composer/)
})

test('trimReply keeps the tail, which is where the conclusion is', () => {
  assert.equal(trimReply(null), null)
  assert.equal(trimReply('   '), null)
  assert.equal(trimReply(' hi '), 'hi')
  const long = 'a'.repeat(RELAY_MAX_REPLY_CHARS + 500) + 'CONCLUSION'
  const out = trimReply(long)
  assert.ok(out.length <= RELAY_MAX_REPLY_CHARS + 40)
  assert.ok(out.endsWith('CONCLUSION'))
  assert.match(out, /^…\(reply truncated\)…/)
})

// ── delivery ─────────────────────────────────────────────────────────────

test('fire-and-forget delivers and returns immediately', async () => {
  const w = world([LIVE('a', 'Alpha'), LIVE('b', 'Beta')])
  const r = new TestRelay(w.deps)
  const res = await r.run({
    fromSessionId: 'a',
    toSessionId: 'b',
    message: 'go',
    wait: false,
    timeoutMs: 1000
  })
  assert.equal(res.phase, 'delivered')
  assert.equal(res.ok, true)
  assert.equal(w.sent.length, 1)
  assert.match(w.sent[0].text, /go$/)
  assert.deepEqual(r.activeWaits(), [], 'a non-blocking relay blocks nobody')
})

test('an exited target fails before anything is typed', async () => {
  const w = world([LIVE('a', 'Alpha'), { id: 'b', title: 'Beta', alive: false, status: 'exited' }])
  const r = new TestRelay(w.deps)
  const res = await r.run({
    fromSessionId: 'a',
    toSessionId: 'b',
    message: 'go',
    wait: false,
    timeoutMs: 1000
  })
  assert.equal(res.phase, 'failed')
  assert.match(res.error, /has exited/)
  assert.equal(w.sent.length, 0)
})

test('an unknown target fails', async () => {
  const w = world([LIVE('a', 'Alpha')])
  const r = new TestRelay(w.deps)
  const res = await r.run({
    fromSessionId: 'a',
    toSessionId: 'nope',
    message: 'go',
    wait: false,
    timeoutMs: 1000
  })
  assert.match(res.error, /No such session/)
})

test('an empty message is refused rather than typed', async () => {
  const w = world([LIVE('a', 'Alpha'), LIVE('b', 'Beta')])
  const r = new TestRelay(w.deps)
  const res = await r.run({
    fromSessionId: 'a',
    toSessionId: 'b',
    message: '   \n ',
    wait: false,
    timeoutMs: 1000
  })
  assert.match(res.error, /Nothing to send/)
  assert.equal(w.sent.length, 0)
})

// ── blocking hand-off ────────────────────────────────────────────────────

test('a blocking relay resolves when the target finishes its turn', async () => {
  const w = world([LIVE('a', 'Alpha'), LIVE('b', 'Beta', 'idle', { reply: 'Looks fine to me.' })])
  const r = new TestRelay(w.deps)
  const p = r.run({
    fromSessionId: 'a',
    toSessionId: 'b',
    message: 'review it',
    wait: true,
    timeoutMs: 60000
  })
  await Promise.resolve()
  await Promise.resolve()
  r.onStatus('b', 'working', null)
  r.onStatus('b', 'review', null)
  const res = await p
  assert.equal(res.phase, 'replied')
  assert.equal(res.ok, true)
  assert.equal(res.reply, 'Looks fine to me.')
  assert.deepEqual(r.activeWaits(), [], 'the wait is released once it resolves')
})

test('a target that stops to ask a human is reported as waiting, not failed', async () => {
  const w = world([LIVE('a', 'Alpha'), LIVE('b', 'Beta')])
  const r = new TestRelay(w.deps)
  const p = r.run({
    fromSessionId: 'a',
    toSessionId: 'b',
    message: 'do it',
    wait: true,
    timeoutMs: 60000
  })
  await Promise.resolve()
  await Promise.resolve()
  r.onStatus('b', 'working', null)
  r.onStatus('b', 'waiting', 'Approve running rm?')
  const res = await p
  assert.equal(res.phase, 'waiting')
  assert.equal(res.ok, false, 'no answer came back')
  assert.equal(res.reason, 'Approve running rm?')
  assert.equal(res.reply, null)
})

test('a timeout is a timeout, not a failure', async () => {
  const w = world([LIVE('a', 'Alpha'), LIVE('b', 'Beta')])
  const r = new TestRelay(w.deps)
  const p = r.run({
    fromSessionId: 'a',
    toSessionId: 'b',
    message: 'slow',
    wait: true,
    timeoutMs: 30000
  })
  await Promise.resolve()
  await Promise.resolve()
  r.expire()
  const res = await p
  assert.equal(res.phase, 'timeout')
  assert.match(res.error, /within 30s/)
  assert.deepEqual(r.activeWaits(), [], 'a timed-out wait still releases its slot')
})

test('a stale turn-end from the previous turn does not resolve the relay', async () => {
  let clock = 1000
  const w = world([LIVE('a', 'Alpha'), LIVE('b', 'Beta', 'idle', { reply: 'the real answer' })])
  const r = new TestRelay({ ...w.deps, now: () => clock })
  const p = r.run({
    fromSessionId: 'a',
    toSessionId: 'b',
    message: 'go',
    wait: true,
    timeoutMs: 60000
  })
  await Promise.resolve()
  await Promise.resolve()

  // A `Stop` hook from the turn that was already finishing, arriving 200ms
  // after we typed. We have not seen our own turn start, so it must be ignored.
  clock += 200
  r.onStatus('b', 'review', null)

  let settled = false
  void p.then(() => {
    settled = true
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(settled, false, 'the stale hook resolved the relay')

  // Now our turn really starts and really ends.
  r.onStatus('b', 'working', null)
  r.onStatus('b', 'review', null)
  const res = await p
  assert.equal(res.phase, 'replied')
  assert.equal(res.reply, 'the real answer')
})

test('after the grace window a turn-end is accepted without seeing working', async () => {
  let clock = 1000
  const w = world([LIVE('a', 'Alpha'), LIVE('b', 'Beta', 'idle', { reply: 'done' })])
  const r = new TestRelay({ ...w.deps, now: () => clock })
  const p = r.run({
    fromSessionId: 'a',
    toSessionId: 'b',
    message: 'go',
    wait: true,
    timeoutMs: 60000
  })
  await Promise.resolve()
  await Promise.resolve()
  // The `working` hook never arrived, but two seconds have passed, so this
  // cannot be the previous turn.
  clock += 2000
  r.onStatus('b', 'review', null)
  const res = await p
  assert.equal(res.phase, 'replied')
})

// ── guards ───────────────────────────────────────────────────────────────

test('a session cannot block on itself', async () => {
  const w = world([LIVE('a', 'Alpha')])
  const r = new TestRelay(w.deps)
  const res = await r.run({
    fromSessionId: 'a',
    toSessionId: 'a',
    message: 'hi',
    wait: true,
    timeoutMs: 1000
  })
  assert.match(res.error, /cannot wait on itself/)
  assert.equal(w.sent.length, 0)
})

test('a two-agent cycle is refused before either is blocked', async () => {
  const w = world([LIVE('a', 'Alpha'), LIVE('b', 'Beta')])
  const r = new TestRelay(w.deps)
  const first = r.run({
    fromSessionId: 'a',
    toSessionId: 'b',
    message: 'you first',
    wait: true,
    timeoutMs: 60000
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(r.activeWaits(), [{ fromSessionId: 'a', toSessionId: 'b' }])

  const back = await r.run({
    fromSessionId: 'b',
    toSessionId: 'a',
    message: 'no, you',
    wait: true,
    timeoutMs: 60000
  })
  assert.equal(back.phase, 'failed')
  assert.match(back.error, /deadlock/)
  assert.match(back.error, /Beta → Alpha/)

  r.onStatus('b', 'working', null)
  r.onStatus('b', 'review', null)
  await first
})

test('a three-agent cycle is refused too', async () => {
  const w = world([LIVE('a', 'A'), LIVE('b', 'B'), LIVE('c', 'C')])
  const r = new TestRelay(w.deps)
  const ab = r.run({ fromSessionId: 'a', toSessionId: 'b', message: '1', wait: true, timeoutMs: 60000 })
  await Promise.resolve()
  await Promise.resolve()
  const bc = r.run({ fromSessionId: 'b', toSessionId: 'c', message: '2', wait: true, timeoutMs: 60000 })
  await Promise.resolve()
  await Promise.resolve()

  const ca = await r.run({
    fromSessionId: 'c',
    toSessionId: 'a',
    message: '3',
    wait: true,
    timeoutMs: 60000
  })
  assert.match(ca.error, /deadlock/)
  assert.match(ca.error, /C → A → B → C/)

  r.expire()
  r.expire()
  await Promise.all([ab, bc])
})

test('one blocking relay per session at a time', async () => {
  const w = world([LIVE('a', 'A'), LIVE('b', 'B'), LIVE('c', 'C')])
  const r = new TestRelay(w.deps)
  const first = r.run({ fromSessionId: 'a', toSessionId: 'b', message: '1', wait: true, timeoutMs: 60000 })
  await Promise.resolve()
  await Promise.resolve()

  const second = await r.run({
    fromSessionId: 'a',
    toSessionId: 'c',
    message: '2',
    wait: true,
    timeoutMs: 60000
  })
  assert.match(second.error, /one blocking relay at a time/)
  assert.match(second.error, /"B"/)

  r.expire()
  await first
})

test('a non-blocking send is exempt from the cycle guard', async () => {
  const w = world([LIVE('a', 'A'), LIVE('b', 'B')])
  const r = new TestRelay(w.deps)
  const first = r.run({ fromSessionId: 'a', toSessionId: 'b', message: '1', wait: true, timeoutMs: 60000 })
  await Promise.resolve()
  await Promise.resolve()

  // B answering A out-of-band is exactly how a handoff *should* work.
  const back = await r.run({
    fromSessionId: 'b',
    toSessionId: 'a',
    message: 'here you go',
    wait: false,
    timeoutMs: 60000
  })
  assert.equal(back.phase, 'delivered')

  r.expire()
  await first
})

// ── settling ─────────────────────────────────────────────────────────────

test('a busy target is given time to finish before we type into it', async () => {
  const w = world([LIVE('a', 'A'), LIVE('b', 'B', 'working')])
  let clock = 0
  const r = new TestRelay({ ...w.deps, now: () => clock })
  // Each poll advances the clock; the target frees up on the third look.
  const original = r.sleep.bind(r)
  r.sleep = (ms) => {
    clock += 250
    if (clock >= 750) w.map.get('b').status = 'idle'
    return original(ms)
  }
  const res = await r.run({
    fromSessionId: 'a',
    toSessionId: 'b',
    message: 'go',
    wait: false,
    timeoutMs: 60000
  })
  assert.equal(res.phase, 'delivered')
  assert.equal(w.sent.length, 1)
})

test('a target that never settles is refused rather than typed over', async () => {
  const w = world([LIVE('a', 'A'), LIVE('b', 'B', 'working')])
  let clock = 0
  const r = new TestRelay({ ...w.deps, now: () => clock })
  r.sleep = (ms) => {
    clock += 250
    return Promise.resolve()
  }
  const res = await r.run({
    fromSessionId: 'a',
    toSessionId: 'b',
    message: 'go',
    wait: false,
    timeoutMs: 60000
  })
  assert.equal(res.phase, 'failed')
  assert.match(res.error, /still mid-turn/)
  assert.equal(w.sent.length, 0, 'nothing was typed into a busy TUI')
})

// ── reporting ────────────────────────────────────────────────────────────

test('describeResult says something useful for every phase', () => {
  const base = {
    ok: true,
    relayId: 'x',
    toSessionId: 'b',
    toTitle: 'Beta',
    reply: null,
    reason: null,
    error: null,
    elapsedMs: 4000
  }
  assert.match(describeResult({ ...base, phase: 'replied' }), /Beta replied after 4s/)
  assert.match(describeResult({ ...base, phase: 'delivered' }), /Delivered to Beta/)
  assert.match(
    describeResult({ ...base, phase: 'waiting', reason: 'approve?' }),
    /needs a human: approve\?/
  )
  assert.match(describeResult({ ...base, phase: 'timeout' }), /did not finish within 4s/)
  assert.match(describeResult({ ...base, phase: 'failed', error: 'boom' }), /failed: boom/)
})

/**
 * The composer sends no `timeoutMs`, so whatever the boundary defaults to is
 * what every @mention-with-wait actually gets. It defaulted to the *ceiling*,
 * which is why the send button sat on "Sending…" — a 30-minute blocking wait
 * reads exactly like a hang. The ceiling exists to stop a typo parking a
 * session for a day; it was never meant to be the default.
 */
test('an omitted timeout falls back to the default, not the hard ceiling', () => {
  assert.equal(clampTimeout(undefined), RELAY_DEFAULT_TIMEOUT_MS)
  assert.ok(RELAY_DEFAULT_TIMEOUT_MS < RELAY_MAX_TIMEOUT_MS)
  assert.equal(clampTimeout(999_999_999), RELAY_MAX_TIMEOUT_MS)
})

test('revoking an agent grant while a recipient settles prevents delivery', async () => {
  let allowed = true, sent = false, now = 0
  const relay = new TestRelay({
    lookup: id => ({ id, title: id, alive: true, status: 'working' }),
    send: async () => { sent = true }, readReply: async () => 'private', now: () => now
  })
  relay.sleep = async () => { now += 250; allowed = false }
  await assert.rejects(relay.run({ fromSessionId: 'a', toSessionId: 'b', message: 'hello', wait: false },
    () => { if (!allowed) throw new Error('grant revoked') }), /grant revoked/)
  assert.equal(sent, false)
})

test('revoking a blocking relay ends the wait and releases its deadlock bookkeeping', async () => {
  let allowed = true
  const relay = new TestRelay({
    lookup: id => ({ id, title: id, alive: true, status: 'idle' }),
    send: async () => {}, readReply: async () => 'private'
  })
  const pending = relay.run({ fromSessionId: 'a', toSessionId: 'b', message: 'hello', wait: true },
    () => { if (!allowed) throw new Error('grant revoked') })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(relay.activeWaits().length, 1)
  allowed = false
  await assert.rejects(pending, /grant revoked/)
  assert.deepEqual(relay.activeWaits(), [])
  assert.ok(relay.deadlines.every(d => d.cancelled))
})
