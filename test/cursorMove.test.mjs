/**
 * Click-to-move-the-cursor.
 *
 * A terminal has no way to *place* a cursor — the only thing a TUI understands
 * is arrow keys — so clicking somewhere means counting the distance and sending
 * that many. Two things are worth pinning down: the arithmetic, and the guards
 * that stop a mis-measured click from firing hundreds of keystrokes at an agent.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_CURSOR_MOVE,
  clickToCell,
  cursorMoveSequence,
  selectionDeleteSequence
} from '../src/shared/cursorMove.js'

const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'

/** Defaults for an 80-column terminal with the cursor at row 5, column 40. */
function move(patch) {
  return cursorMoveSequence({
    targetRow: 5,
    targetCol: 40,
    cursorRow: 5,
    cursorCol: 40,
    cols: 80,
    ...patch
  })
}

describe('cursor move arithmetic', () => {
  test('clicking to the right of the cursor sends that many right arrows', () => {
    assert.equal(move({ targetCol: 47 }), RIGHT.repeat(7))
  })

  test('clicking to the left sends left arrows', () => {
    assert.equal(move({ targetCol: 12 }), LEFT.repeat(28))
  })

  test('clicking where the cursor already is sends nothing', () => {
    assert.equal(move({}), '')
  })

  test('a row change is charged at the full terminal width', () => {
    // The documented approximation: exact for text that wrapped at the edge of
    // the screen, which is the case this gesture is actually for.
    assert.equal(move({ targetRow: 6, targetCol: 40 }), RIGHT.repeat(80))
    assert.equal(move({ targetRow: 4, targetCol: 40 }), LEFT.repeat(80))
    assert.equal(move({ targetRow: 6, targetCol: 45 }), RIGHT.repeat(85))
    assert.equal(move({ targetRow: 4, targetCol: 75 }), LEFT.repeat(45))
  })

  test('a row up and a column right can still net out to zero', () => {
    assert.equal(move({ targetRow: 4, targetCol: 40 + 80 - 80 }), LEFT.repeat(80))
    assert.equal(cursorMoveSequence({
      targetRow: 4, targetCol: 79,
      cursorRow: 5, cursorCol: 79 - 80,
      cols: 80
    }), '')
  })
})

describe('cursor move guards', () => {
  test('a distance beyond the cap sends nothing rather than a keystroke storm', () => {
    // One arrow per cell means a click far up a scrollback is thousands of
    // keypresses into a live agent. Better to do nothing visible.
    const rowsAway = Math.ceil((MAX_CURSOR_MOVE + 1) / 80)
    assert.equal(move({ targetRow: 5 - rowsAway }), '')
  })

  test('the cap itself is still honoured', () => {
    assert.equal(
      cursorMoveSequence({
        targetRow: 0,
        targetCol: MAX_CURSOR_MOVE,
        cursorRow: 0,
        cursorCol: 0,
        cols: MAX_CURSOR_MOVE + 10
      }).length,
      RIGHT.length * MAX_CURSOR_MOVE
    )
  })

  test('a terminal with no width yet produces nothing', () => {
    assert.equal(move({ cols: 0 }), '')
    assert.equal(move({ cols: -1 }), '')
    assert.equal(move({ cols: Number.NaN }), '')
  })
})

describe('mapping a click to a cell', () => {
  const rect = { left: 100, top: 50, width: 800, height: 400 }
  const grid = { rect, cols: 80, rows: 20 } // 10px wide, 20px tall cells

  test('a click in the middle of a cell selects that cell', () => {
    assert.deepEqual(clickToCell({ x: 105, y: 60, ...grid }), { col: 0, row: 0 })
    assert.deepEqual(clickToCell({ x: 255, y: 190, ...grid }), { col: 15, row: 7 })
  })

  test('a click past the last cell clamps instead of running off the grid', () => {
    // The mouseup can land outside the screen element after a small drag; the
    // last column is the honest answer, not column 94.
    assert.deepEqual(clickToCell({ x: 5000, y: 5000, ...grid }), { col: 79, row: 19 })
    assert.deepEqual(clickToCell({ x: -500, y: -500, ...grid }), { col: 0, row: 0 })
  })

  test('an unlaid-out terminal has no cell to report', () => {
    assert.equal(clickToCell({ x: 105, y: 60, rect: { ...rect, width: 0 }, cols: 80, rows: 20 }), null)
    assert.equal(clickToCell({ x: 105, y: 60, rect: { ...rect, height: 0 }, cols: 80, rows: 20 }), null)
    assert.equal(clickToCell({ x: 105, y: 60, rect, cols: 0, rows: 20 }), null)
    assert.equal(clickToCell({ x: 105, y: 60, rect, cols: 80, rows: 0 }), null)
  })
})

describe('deleting selected terminal input', () => {
  const BACKSPACE = '\x7f'
  const edit = (patch = {}) => selectionDeleteSequence({
    startRow: 5,
    startCol: 12,
    endRow: 5,
    endCol: 20,
    cursorRow: 5,
    cursorCol: 24,
    editableStartRow: 5,
    editableEndRow: 5,
    cols: 80,
    ...patch
  })

  test('moves to the right edge and backspaces the selected span', () => {
    assert.equal(edit(), LEFT.repeat(4) + BACKSPACE.repeat(8))
    assert.equal(edit({ cursorCol: 16 }), RIGHT.repeat(4) + BACKSPACE.repeat(8))
  })

  test('handles an input that wrapped across terminal rows', () => {
    assert.equal(edit({
      startRow: 4,
      startCol: 76,
      endRow: 5,
      endCol: 4,
      cursorCol: 8,
      editableStartRow: 4
    }), LEFT.repeat(4) + BACKSPACE.repeat(8))
  })

  test('understands an exclusive end at the next row column zero', () => {
    assert.equal(edit({
      startCol: 76,
      endRow: 6,
      endCol: 0,
      cursorRow: 5,
      cursorCol: 80,
      editableEndRow: 5
    }), BACKSPACE.repeat(4))
  })

  test('refuses scrollback and unbounded keystroke floods', () => {
    assert.equal(edit({ startRow: 4 }), '')
    assert.equal(edit({ endRow: 6 }), '')
    assert.equal(edit({ endCol: MAX_CURSOR_MOVE + 1 }), '')
  })
})
