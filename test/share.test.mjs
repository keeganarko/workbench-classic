/**
 * Session sharing, driven over real HTTP against a real listener.
 *
 * The server is written against a three-function host precisely so this file
 * needs no electron, no tmux and no session — everything below is the actual
 * request a guest's browser would make.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { ShareServer } from '../src/main/share.js'
import { Tunnel } from '../src/main/tunnel.js'
import {
  MAX_GUESTS,
  guestInitials,
  isGuestStale,
  mayType,
  sanitizeGuestName
} from '../src/shared/share.js'

/** A host double. Records writes so "did that keystroke land" is checkable. */
function fakeHost() {
  return {
    screen: 'hello from the session',
    alive: true,
    writes: [],
    async snapshot() {
      return this.alive ? this.screen : null
    },
    write(sessionId, data) {
      this.writes.push({ sessionId, data })
    },
    title() {
      return 'my session'
    }
  }
}

let host
let server
let base

before(async () => {
  host = fakeHost()
  server = new ShareServer(host)
  await server.start()
  base = `http://127.0.0.1:${server.port}`
})

after(async () => {
  await server.stop()
})

beforeEach(() => {
  for (const s of server.list()) server.destroy(s.sessionId)
  host.alive = true
  host.screen = 'hello from the session'
  host.writes.length = 0
})

const post = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  })

/** Joins and returns the guest id, failing loudly if the join was refused. */
async function join(token, name) {
  const res = await post(`/s/${token}/join`, { name })
  assert.equal(res.status, 200, `join refused: ${res.status}`)
  return (await res.json()).guestId
}

describe('the link', () => {
  test('a share hands back a URL carrying its own token', () => {
    const share = server.create('sess-1')
    assert.match(share.url, /^http:\/\/127\.0\.0\.1:\d+\/s\/[a-f0-9]{48}$/)
    assert.equal(share.reach, 'local')
    assert.deepEqual(share.guests, [])
  })

  test('sharing the same session twice is the same link, not a second one', () => {
    const first = server.create('sess-1')
    const second = server.create('sess-1')
    assert.equal(second.token, first.token)
    assert.equal(server.list().length, 1)
  })

  test('a tunnel rewrites existing links without invalidating their tokens', () => {
    const before = server.create('sess-1')
    server.setOrigin('https://x.trycloudflare.com/', 'tunnel')
    const after = server.get('sess-1')
    assert.equal(after.token, before.token)
    assert.equal(after.url, `https://x.trycloudflare.com/s/${before.token}`)
    assert.equal(after.reach, 'tunnel')
    server.setOrigin(`http://127.0.0.1:${server.port}`, 'local')
  })

  test('the guest page loads and is locked down for a stranger', async () => {
    const share = server.create('sess-1')
    const res = await fetch(`${base}/s/${share.token}`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/)
    assert.equal(res.headers.get('x-frame-options'), 'DENY')
    const html = await res.text()
    assert.match(html, /What should we call you\?/)
    // Self-contained: no request off this origin, because the CSP forbids one.
    assert.equal(/<(script|link|img)[^>]+(src|href)="https?:/.test(html), false)
  })

  test('a wrong token is indistinguishable from a share that ended', async () => {
    const share = server.create('sess-1')
    const wrong = await fetch(`${base}/s/${'0'.repeat(48)}`)
    server.destroy('sess-1')
    const ended = await fetch(`${base}/s/${share.token}`)
    assert.equal(wrong.status, 404)
    assert.equal(ended.status, 404)
    assert.equal(await wrong.text(), await ended.text())
  })

  test('a token of a different length is rejected, not crashed on', async () => {
    server.create('sess-1')
    const res = await fetch(`${base}/s/short`)
    assert.equal(res.status, 404)
  })
})

describe('joining', () => {
  test('a guest is named and counted', async () => {
    const share = server.create('sess-1')
    const id = await join(share.token, 'Sam')
    const after = server.get('sess-1')
    assert.equal(after.guests.length, 1)
    assert.equal(after.guests[0].name, 'Sam')
    assert.equal(after.guests[0].id, id)
  })

  test(`the person after the ${MAX_GUESTS}th is turned away`, async () => {
    const share = server.create('sess-1')
    for (let i = 0; i < MAX_GUESTS; i++) await join(share.token, `P${i}`)
    const overflow = await post(`/s/${share.token}/join`, { name: 'Late' })
    assert.equal(overflow.status, 429)
    assert.equal(server.get('sess-1').guests.length, MAX_GUESTS)
  })

  test('a nameless join still gets a name', async () => {
    const share = server.create('sess-1')
    await join(share.token, '')
    assert.equal(server.get('sess-1').guests[0].name, 'Guest')
  })
})

describe('typing', () => {
  test('a new guest cannot type — that is the default and it is enforced', async () => {
    const share = server.create('sess-1')
    const id = await join(share.token, 'Sam')
    const res = await post(`/s/${share.token}/input`, { guestId: id, data: 'whoami' })
    assert.equal(res.status, 403)
    assert.deepEqual(host.writes, [])
  })

  test('a promoted guest reaches the session', async () => {
    const share = server.create('sess-1')
    const id = await join(share.token, 'Sam')
    server.setCanType('sess-1', id, true)
    const res = await post(`/s/${share.token}/input`, { guestId: id, data: 'ls' })
    assert.equal(res.status, 204)
    assert.deepEqual(host.writes, [{ sessionId: 'sess-1', data: 'ls' }])
  })

  test('revoking takes effect on the next keystroke, not the next reload', async () => {
    const share = server.create('sess-1')
    const id = await join(share.token, 'Sam')
    server.setCanType('sess-1', id, true)
    await post(`/s/${share.token}/input`, { guestId: id, data: 'a' })
    server.setCanType('sess-1', id, false)
    const after = await post(`/s/${share.token}/input`, { guestId: id, data: 'b' })
    assert.equal(after.status, 403)
    assert.deepEqual(
      host.writes.map((w) => w.data),
      ['a']
    )
  })

  test('an unknown guest id cannot type, promoted or not', async () => {
    const share = server.create('sess-1')
    const id = await join(share.token, 'Sam')
    server.setCanType('sess-1', id, true)
    const res = await post(`/s/${share.token}/input`, { guestId: 'made-up', data: 'x' })
    assert.equal(res.status, 403)
    assert.deepEqual(host.writes, [])
  })

  test('a guest promoted on one share cannot type into another', async () => {
    const a = server.create('sess-a')
    server.create('sess-b')
    const id = await join(a.token, 'Sam')
    server.setCanType('sess-b', id, true)
    const res = await post(`/s/${a.token}/input`, { guestId: id, data: 'x' })
    assert.equal(res.status, 403)
    assert.deepEqual(host.writes, [])
  })

  test('a keystroke payload is capped', async () => {
    const share = server.create('sess-1')
    const id = await join(share.token, 'Sam')
    server.setCanType('sess-1', id, true)
    await post(`/s/${share.token}/input`, { guestId: id, data: 'x'.repeat(10_000) })
    assert.equal(host.writes[0].data.length, 4096)
  })

  test('a body too large to be a keystroke never reaches the session', async () => {
    const share = server.create('sess-1')
    const id = await join(share.token, 'Sam')
    server.setCanType('sess-1', id, true)
    // Refused while still uploading, so the guest id is never even read — the
    // request cannot be a keystroke and is not treated as one.
    const res = await post(`/s/${share.token}/input`, { guestId: id, data: 'x'.repeat(200_000) })
    assert.equal(res.status, 403)
    assert.deepEqual(host.writes, [])
  })

  test('a kicked guest is out, link or no link', async () => {
    const share = server.create('sess-1')
    const id = await join(share.token, 'Sam')
    server.setCanType('sess-1', id, true)
    server.kick('sess-1', id)
    const res = await post(`/s/${share.token}/input`, { guestId: id, data: 'x' })
    assert.equal(res.status, 403)
    assert.equal(server.get('sess-1').guests.length, 0)
  })
})

describe('watching', () => {
  test('the stream refuses anyone who has not joined', async () => {
    const share = server.create('sess-1')
    const res = await fetch(`${base}/s/${share.token}/stream?g=nobody`)
    assert.equal(res.status, 403)
    await res.arrayBuffer()
  })

  test('a watcher is painted immediately and told who else is here', async () => {
    const share = server.create('sess-1')
    const id = await join(share.token, 'Sam')
    await join(share.token, 'Alex')

    const res = await fetch(`${base}/s/${share.token}/stream?g=${id}`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/event-stream/)

    const events = await readEvents(res, 1, (e) => e.event === 'presence')
    const presence = events.find((e) => e.event === 'presence')
    assert.ok(presence, 'a joining guest is told the room')
    assert.deepEqual(
      presence.data.people.map((p) => p.name),
      ['Sam', 'Alex']
    )
    assert.equal(presence.data.you.canType, false)
    // Nobody learns anyone else's id — that is the only impersonation handle.
    assert.equal(JSON.stringify(presence.data).includes(id), false)
  })

  test('a frame reaches an open stream when the screen changes', async () => {
    const share = server.create('sess-1')
    const id = await join(share.token, 'Sam')
    const res = await fetch(`${base}/s/${share.token}/stream?g=${id}`)
    host.screen = 'the screen moved'
    const events = await readEvents(res, 1, (e) => e.event === 'frame')
    const frame = events.find((e) => e.event === 'frame')
    assert.equal(frame.data.text, 'the screen moved')
  })

  test('a promotion reaches the guest without them asking', async () => {
    const share = server.create('sess-1')
    const id = await join(share.token, 'Sam')
    const res = await fetch(`${base}/s/${share.token}/stream?g=${id}`)
    // Wait for the opening presence before changing anything, so the assertion
    // below cannot pass on the frame the guest was already sent.
    await readEvents(res, 1, (e) => e.event === 'presence', false)
    server.setCanType('sess-1', id, true)
    const events = await readEvents(res, 1, (e) => e.event === 'presence' && e.data.you.canType)
    assert.ok(events.some((e) => e.event === 'presence' && e.data.you.canType))
  })

  test('a dead session ends the share instead of freezing on a stale screen', async () => {
    const share = server.create('sess-1')
    const id = await join(share.token, 'Sam')
    const res = await fetch(`${base}/s/${share.token}/stream?g=${id}`)
    host.alive = false
    const events = await readEvents(res, 1, (e) => e.event === 'ended')
    assert.ok(events.some((e) => e.event === 'ended'))
    assert.equal(server.get('sess-1'), null)
  })

  test('leaving removes the guest from the room', async () => {
    const share = server.create('sess-1')
    const id = await join(share.token, 'Sam')
    const res = await post(`/s/${share.token}/leave`, { guestId: id })
    assert.equal(res.status, 204)
    assert.equal(server.get('sess-1').guests.length, 0)
  })

  test('stopping the share drops everyone', async () => {
    const share = server.create('sess-1')
    await join(share.token, 'Sam')
    server.destroy('sess-1')
    assert.equal(server.get('sess-1'), null)
    const res = await fetch(`${base}/s/${share.token}`)
    assert.equal(res.status, 404)
  })

  test('a closed session takes its link with it, watched or not', async () => {
    const share = server.create('sess-1')
    // Nobody is watching, so the snapshot loop never looks at this share — the
    // manager's own change event is what has to end it.
    server.prune(() => false)
    assert.equal(server.get('sess-1'), null)
    const res = await fetch(`${base}/s/${share.token}`)
    assert.equal(res.status, 404)
  })

  test('pruning leaves live sessions alone', () => {
    server.create('sess-1')
    server.prune(() => true)
    assert.equal(server.get('sess-1')?.sessionId, 'sess-1')
  })

  test('the host is told when the room changes', async () => {
    const share = server.create('sess-1')
    let seen = null
    const onChange = (list) => {
      seen = list
    }
    server.on('change', onChange)
    await join(share.token, 'Sam')
    server.off('change', onChange)
    assert.equal(seen?.[0].guests[0].name, 'Sam')
  })
})

describe('names arriving from strangers', () => {
  test('markup and control characters cannot escape a chip', () => {
    assert.equal(sanitizeGuestName('<script>alert(1)</script>'), 'script alert(1) /script')
    assert.equal(sanitizeGuestName('two\nlines'), 'two lines')
    assert.equal(sanitizeGuestName('bellring'), 'bell ring')
  })

  test('ordinary names survive intact', () => {
    assert.equal(sanitizeGuestName('Sam Alvarez'), 'Sam Alvarez')
    assert.equal(sanitizeGuestName('  Jose  '), 'Jose')
    assert.equal(sanitizeGuestName("O'Neill"), "O'Neill")
  })

  test('a name cannot push the presence bar off screen', () => {
    assert.equal(sanitizeGuestName('x'.repeat(500)).length, 24)
  })

  test('nothing usable falls back rather than rendering an empty chip', () => {
    assert.equal(sanitizeGuestName('   '), 'Guest')
    assert.equal(sanitizeGuestName(null), 'Guest')
    assert.equal(sanitizeGuestName(42), 'Guest')
  })

  test('initials come from the ends of the name', () => {
    assert.equal(guestInitials('Sam Alvarez'), 'SA')
    assert.equal(guestInitials('Sam'), 'SA')
    assert.equal(guestInitials('Guest'), 'GU')
  })
})

describe('helpers', () => {
  test('typing is denied for a guest that is not there at all', () => {
    assert.equal(mayType(undefined), false)
    assert.equal(mayType({ canType: false }), false)
    assert.equal(mayType({ canType: true }), true)
  })

  test('a browser that vanished is treated as gone after the timeout', () => {
    const now = Date.now()
    assert.equal(isGuestStale({ lastSeenAt: now }, now), false)
    assert.equal(isGuestStale({ lastSeenAt: now - 31_000 }, now), true)
  })
})

describe('public reach', () => {
  // The fix named in the message is whatever installs cloudflared *here*:
  // Homebrew on macOS, winget on Windows, and the download page on Linux,
  // where there is no one package manager to name. The assertion tracks the
  // platform rather than pinning one spelling, because the property under
  // test is "the failure carries a fix", not which fix.
  const INSTALL_HINT =
    process.platform === 'darwin'
      ? /brew install cloudflared/
      : process.platform === 'win32'
        ? /winget install --id Cloudflare\.cloudflared/
        : /developers\.cloudflare\.com/

  test('a missing cloudflared is a state with a fix, not a thrown error', async () => {
    const tunnel = new Tunnel('definitely-not-a-real-binary-xyz')
    const state = await tunnel.start(1234)
    assert.equal(state.status, 'unavailable')
    assert.match(state.reason, INSTALL_HINT)
    assert.equal(tunnel.state.status, 'unavailable')
    tunnel.stop()
  })

  test('a binary that cannot be found is the same reported state as a missing one', async () => {
    // The Finder-launched case: cloudflared is installed, but not on this
    // process's PATH, so the lookup comes back empty.
    const tunnel = new Tunnel(() => null)
    const state = await tunnel.start(1234)
    assert.equal(state.status, 'unavailable')
    assert.match(state.reason, INSTALL_HINT)
  })

  test('stopping an idle tunnel is harmless', () => {
    const tunnel = new Tunnel('definitely-not-a-real-binary-xyz')
    tunnel.stop()
    assert.equal(tunnel.state.status, 'off')
  })
})

/**
 * Reads SSE frames off a live response until `count` of them match, or the
 * budget runs out. The snapshot loop ticks on its own clock, so the wait has to
 * be for an event rather than for a fixed delay.
 *
 * `cancel` is false when the caller intends to keep reading the same response;
 * cancelling the reader would close the stream underneath them.
 */
async function readEvents(res, count, match = () => true, cancel = true) {
  res._reader ??= res.body.getReader()
  res._buffer ??= ''
  const reader = res._reader
  const decoder = new TextDecoder()
  const events = []
  const deadline = Date.now() + 5000

  while (events.filter(match).length < count && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    res._buffer += decoder.decode(value, { stream: true })
    let split
    while ((split = res._buffer.indexOf('\n\n')) !== -1) {
      const raw = res._buffer.slice(0, split)
      res._buffer = res._buffer.slice(split + 2)
      const event = /event: (.+)/.exec(raw)?.[1]
      const data = /data: (.+)/.exec(raw)?.[1]
      if (event && data) events.push({ event, data: JSON.parse(data) })
    }
  }
  if (cancel) await reader.cancel().catch(() => undefined)
  return events
}
