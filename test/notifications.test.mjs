/**
 * Notification policy: who gets told, who does not, and how many banners one
 * flapping session is allowed to produce.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NotificationManager } from '../src/main/notifications.js'
import { created, reset, setSupported } from './stubs/electron.mjs'

/** A host with knobs for the two questions suppression depends on. */
function fakeHost(overrides = {}) {
  const focused = []
  return {
    focusedSessions: focused,
    suppress: true,
    silentMode: false,
    waitingCalls: 0,
    focusCalls: [],
    isPaneFocused(id) {
      return this.focusedSessions.includes(id)
    },
    suppressWhenFocused() {
      return this.suppress
    },
    silent() {
      return this.silentMode
    },
    focusSession(id) {
      this.focusCalls.push(id)
    },
    onWaiting() {
      this.waitingCalls++
    },
    ...overrides
  }
}

const waiting = (sessionId, body = 'needs you') => ({
  sessionId,
  title: `${sessionId} needs you`,
  body,
  status: 'waiting'
})

describe('notifications', () => {
  beforeEach(() => reset())

  test('is silent about the exact pane you are looking at', () => {
    const host = fakeHost()
    host.focusedSessions.push('a')
    const mgr = new NotificationManager(host)

    assert.equal(mgr.show(waiting('a')), false, 'the focused pane needs no banner')
    assert.equal(created.length, 0)
    assert.equal(mgr.trackedCount, 0)
    mgr.dispose()
  })

  test('still tells you about another session while you stare at this one', () => {
    // This is the bug the per-pane rule exists to fix: window focus alone used
    // to silence every session, including the one you were not watching.
    const host = fakeHost()
    host.focusedSessions.push('a')
    const mgr = new NotificationManager(host)

    assert.equal(mgr.show(waiting('b')), true)
    assert.equal(created.length, 1)
    assert.equal(created[0].options.title, 'b needs you')
    mgr.dispose()
  })

  test('honours "notify me even when I am looking"', () => {
    const host = fakeHost()
    host.focusedSessions.push('a')
    host.suppress = false
    const mgr = new NotificationManager(host)

    assert.equal(mgr.show(waiting('a')), true)
    assert.equal(created.length, 1)
    mgr.dispose()
  })

  test('replaces rather than stacks a repeat for the same session and category', () => {
    const mgr = new NotificationManager(fakeHost())

    assert.equal(mgr.show(waiting('a', 'first')), true)
    assert.equal(mgr.show(waiting('a', 'second')), true)
    assert.equal(mgr.show(waiting('a', 'third')), true)

    assert.equal(created.length, 3, 'each is a real notification')
    assert.equal(created[0].closedCount, 1, 'the first was withdrawn')
    assert.equal(created[1].closedCount, 1, 'the second was withdrawn')
    assert.equal(created[2].closedCount, 0)
    assert.equal(mgr.trackedCount, 1, 'only one banner is live')
    mgr.dispose()
  })

  test('keeps different categories and different sessions apart', () => {
    const mgr = new NotificationManager(fakeHost())

    mgr.show(waiting('a'))
    mgr.show({ sessionId: 'a', title: 'a failed', body: 'boom', status: 'failed' })
    mgr.show({ sessionId: 'b', title: 'b finished', body: 'done', status: 'review' })

    assert.equal(mgr.trackedCount, 3)
    assert.equal(
      created.filter((n) => n.closedCount > 0).length,
      0,
      'none of these are duplicates of each other'
    )
    mgr.dispose()
  })

  test('marks the two states you must not miss as critical', () => {
    const mgr = new NotificationManager(fakeHost())
    mgr.show(waiting('a'))
    mgr.show({ sessionId: 'b', title: 'b failed', body: 'boom', status: 'failed' })
    mgr.show({ sessionId: 'c', title: 'c finished', body: 'done', status: 'review' })

    assert.equal(created[0].options.urgency, 'critical')
    assert.equal(created[1].options.urgency, 'critical')
    assert.equal(created[2].options.urgency, 'normal')
    mgr.dispose()
  })

  test('a click lands on the session, not merely on the window', () => {
    const host = fakeHost()
    const mgr = new NotificationManager(host)
    mgr.show(waiting('a'))

    created[0].fire('click')
    assert.deepEqual(host.focusCalls, ['a'])
    assert.equal(mgr.trackedCount, 0, 'a clicked banner stops being tracked')
    mgr.dispose()
  })

  test('dismissing a banner keeps the identical message quiet but permits a new request', () => {
    const mgr = new NotificationManager(fakeHost())
    mgr.show(waiting('a'))
    created[0].fire('close')
    assert.equal(mgr.trackedCount, 0)

    assert.equal(mgr.show(waiting('a')), false)
    assert.equal(created.length, 1)
    assert.equal(mgr.show(waiting('a', 'Approve a different edit?')), true)
    assert.equal(created.length, 2)
    assert.equal(created[0].closedCount, 0, 'nothing was closed twice')
    mgr.dispose()
  })

  test('identical reports do not re-show or bounce while the banner is live', () => {
    const host = fakeHost(), mgr = new NotificationManager(host)
    assert.equal(mgr.show(waiting('a')), true)
    assert.equal(mgr.show(waiting('a')), false)
    assert.equal(created.length, 1)
    assert.equal(host.waitingCalls, 1)
    mgr.dispose()
  })

  test('reconciling resumed or cleared sessions withdraws stale banners only', () => {
    const mgr = new NotificationManager(fakeHost())
    mgr.show(waiting('a'))
    mgr.show(waiting('b'))
    mgr.show({ sessionId: 'c', title: 'Reply ready', body: 'I made the update.', status: 'review' })
    mgr.reconcile([{ id: 'a', status: 'working' }, { id: 'b', status: 'waiting' }, { id: 'c', status: 'idle' }])
    assert.deepEqual(created.map((n) => n.closedCount), [1, 0, 1])
    assert.equal(mgr.trackedCount, 1)
    // Genuine new approvals may repeat the wording of an earlier question.
    assert.equal(mgr.show(waiting('a')), true)
    mgr.reconcile([])
    assert.equal(mgr.trackedCount, 0)
    assert.equal(created[1].closedCount, 1)
    mgr.dispose()
  })

  test('a late click from a replaced banner cannot untrack its successor', () => {
    const mgr = new NotificationManager(fakeHost())
    mgr.show(waiting('a', 'First request'))
    mgr.show(waiting('a', 'New request'))
    created[0].fire('click')
    assert.equal(mgr.trackedCount, 1)
    mgr.reconcile([])
    assert.equal(created[1].closedCount, 1)
    mgr.dispose()
  })

  test('tracking expires so the map cannot grow forever', () => {
    const mgr = new NotificationManager(fakeHost())
    mgr.show(waiting('a'))
    mgr.show(waiting('b'))
    assert.equal(mgr.trackedCount, 2)

    mgr.expire(Date.now() + 30_000)
    assert.equal(mgr.trackedCount, 2, 'still inside the window')

    mgr.expire(Date.now() + 61_000)
    assert.equal(mgr.trackedCount, 0)
    assert.deepEqual(created.map((n) => n.closedCount), [1, 1], 'expired OS banners are withdrawn')
    assert.equal(mgr.show(waiting('a')), true, 'a future distinct episode may notify again')
    mgr.dispose()
  })

  test('bounces the dock only for waiting', () => {
    const host = fakeHost()
    const mgr = new NotificationManager(host)
    mgr.show({ sessionId: 'a', title: 't', body: 'b', status: 'review' })
    assert.equal(host.waitingCalls, 0)
    mgr.show(waiting('a'))
    assert.equal(host.waitingCalls, 1)
    mgr.dispose()
  })

  test('passes the sound preference through', () => {
    const host = fakeHost()
    host.silentMode = true
    const mgr = new NotificationManager(host)
    mgr.show(waiting('a'))
    assert.equal(created[0].options.silent, true)
    mgr.dispose()
  })

  test('does nothing at all where the OS has no notifications', () => {
    setSupported(false)
    const mgr = new NotificationManager(fakeHost())
    assert.equal(mgr.show(waiting('a')), false)
    assert.equal(created.length, 0)
    mgr.dispose()
  })

  test('dispose withdraws everything still on screen', () => {
    const mgr = new NotificationManager(fakeHost())
    mgr.show(waiting('a'))
    mgr.show(waiting('b'))
    mgr.dispose()

    assert.equal(mgr.trackedCount, 0)
    assert.equal(created.filter((n) => n.closedCount > 0).length, 2)
  })
})
