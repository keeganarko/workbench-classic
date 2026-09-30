import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { previewRoute } from '../src/shared/previewRoute.js'

/** The common case: auto-show on, nothing held, asking for nothing. */
const base = { autoShow: true, focused: true, held: null, path: '/w/report.md', asked: false }
const route = (patch) => previewRoute({ ...base, ...patch })

describe('routing a document to a chat', () => {
  test('the focused chat opens the pane', () => {
    assert.equal(route({}), 'open')
  })

  test('a background chat fills its own slot instead', () => {
    assert.equal(route({ focused: false }), 'stash')
  })

  test('auto-show off silences a produced document entirely', () => {
    assert.equal(route({ autoShow: false }), 'ignore')
    assert.equal(route({ autoShow: false, focused: false }), 'ignore')
  })

  test('auto-show off does not silence a file a session asked for by name', () => {
    assert.equal(route({ autoShow: false, asked: true }), 'open')
    assert.equal(route({ autoShow: false, focused: false, asked: true }), 'stash')
  })
})

describe('a document you chose yourself', () => {
  const chosen = { path: '/w/notes.md', auto: false }

  test('is not replaced by one the chat produced', () => {
    assert.equal(route({ held: chosen }), 'ignore')
    assert.equal(route({ held: chosen, focused: false }), 'ignore')
  })

  test('is replaced when the chat asked for a file by name', () => {
    assert.equal(route({ held: chosen, asked: true }), 'open')
  })

  test('re-renders when the produced document is that same file', () => {
    assert.equal(route({ held: chosen, path: chosen.path }), 'open')
  })

  test('holds only its own chat back, never another one', () => {
    // The slot belongs to one session; a second session's document is routed
    // against that session's slot, which here is empty.
    assert.equal(route({ held: null, focused: false }), 'stash')
  })
})

describe('a document the pane surfaced by itself', () => {
  const surfaced = { path: '/w/old.md', auto: true }

  test('is replaced by the next one', () => {
    assert.equal(route({ held: surfaced }), 'open')
    assert.equal(route({ held: surfaced, focused: false }), 'stash')
  })
})
