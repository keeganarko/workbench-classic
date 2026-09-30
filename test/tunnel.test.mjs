/**
 * The tunnel's reachability check.
 *
 * What matters here is the case a host cannot diagnose from the outside: the
 * hostname exists, Cloudflare answers, and the answer is error 1033 — no tunnel
 * behind the name. Every link from a previous run of the app becomes that, so
 * it is the most likely thing a guest ever sees.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { reachable, describeNoTunnel, interpretStatus } from '../src/main/tunnel.js'

describe('the 1033 message', () => {
  test('names the error and says what to do about it', () => {
    const msg = describeNoTunnel()
    assert.match(msg, /1033/)
    assert.match(msg, /no tunnel is connected/)
    assert.match(msg, /Stop and start the share/)
  })

  test('explains why an old link is dead rather than blaming the guest', () => {
    assert.match(describeNoTunnel(), /earlier run of Workbench/)
  })
})

describe('checking a hostname', () => {
  test('a name nothing resolves is reported as unresolvable, not as broken', async () => {
    const result = await reachable(
      'https://workbench-test-does-not-exist-83f21a.trycloudflare.com'
    )
    assert.equal(result.ok, false)
    assert.match(result.reason, /does not resolve anywhere yet/)
  })

  test('a 530 from the edge is the 1033 case, and is not treated as an answer', () => {
    const r = interpretStatus(530)
    assert.equal(r.ok, false)
    assert.match(r.reason, /1033/)
  })

  test('a 404 from our own share server proves the path works', () => {
    assert.deepEqual(interpretStatus(404), { ok: true })
    assert.deepEqual(interpretStatus(200), { ok: true })
  })

  test('no answer at all is not blamed on the tunnel', () => {
    const r = interpretStatus(null)
    assert.equal(r.ok, false)
    assert.doesNotMatch(r.reason, /1033/)
  })
})
