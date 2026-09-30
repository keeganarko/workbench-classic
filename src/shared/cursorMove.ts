/**
 * Click somewhere in a pane, land the agent's text cursor there.
 *
 * A terminal has no "put the cursor at column 40" for the *application* — the
 * only thing a TUI's line editor understands is arrow keys. So the gesture is
 * really: measure the distance between where the cursor is and where you
 * clicked, and send that many arrows. iTerm2 and xterm.js both do exactly this
 * for ⌥-click; the arithmetic below is the same idea with the grid geometry
 * spelled out, because Workbench also offers it on a plain click.
 *
 * Kept free of imports so the maths can be tested without a DOM or a terminal.
 */

/** How far a single click is allowed to travel, in keystrokes. */
export const MAX_CURSOR_MOVE = 4000

export interface CursorMoveInput {
  /** Clicked cell, absolute in the buffer (viewport offset already added). */
  targetRow: number
  targetCol: number
  /** Where the application's cursor is, absolute in the same coordinates. */
  cursorRow: number
  cursorCol: number
  /** Terminal width, which is also the wrap width for a row change. */
  cols: number
}

/**
 * The exact bytes to send, or `''` when there is nothing to do.
 *
 * A row change is charged at full terminal width. That is exact for text that
 * wraps at the edge of the screen — a shell prompt, a plain composer — and
 * approximate inside a TUI that draws a bordered box, because the box steals a
 * few columns per line that the application's own buffer does not contain.
 * Clicking within the line you are already on is always exact, which is the
 * case this gesture is really for.
 */
export function cursorMoveSequence(input: CursorMoveInput): string {
  const { targetRow, targetCol, cursorRow, cursorCol, cols } = input
  if (!Number.isFinite(cols) || cols <= 0) return ''

  const delta = (targetRow - cursorRow) * cols + (targetCol - cursorCol)
  if (delta === 0) return ''

  const steps = Math.abs(delta)
  // A click far off in the scrollback would otherwise blast thousands of
  // keystrokes at an agent that is probably not even editing text.
  if (steps > MAX_CURSOR_MOVE) return ''

  return (delta > 0 ? '\x1b[C' : '\x1b[D').repeat(steps)
}

export interface SelectionDeleteInput {
  /** Selection bounds from xterm; the end is exclusive. */
  startRow: number
  startCol: number
  endRow: number
  endCol: number
  /** The live application's cursor, in the same absolute buffer coordinates. */
  cursorRow: number
  cursorCol: number
  /** The wrapped terminal rows that make up the currently editable prompt. */
  editableStartRow: number
  editableEndRow: number
  cols: number
}

/**
 * Turns an xterm selection in the current prompt into ordinary line-editor
 * keystrokes: move to the selection's right edge, then backspace over it.
 *
 * A terminal buffer is a painting, not a document model. This intentionally
 * refuses selections in scrollback: sending their length as backspaces would
 * erase unrelated live input while leaving the selected history untouched.
 */
export function selectionDeleteSequence(input: SelectionDeleteInput): string {
  const {
    startRow, startCol, cursorRow, cursorCol,
    editableStartRow, editableEndRow, cols
  } = input
  let { endRow, endCol } = input

  if (![startRow, startCol, endRow, endCol, cursorRow, cursorCol, cols]
    .every(Number.isFinite) || cols <= 0) return ''

  // xterm can express a selection ending just after the last column as the
  // start of the next row. Canonicalising it keeps the editable-row guard fair.
  if (endRow > startRow && endCol === 0) {
    endRow -= 1
    endCol = cols
  }

  if (startRow < editableStartRow || endRow > editableEndRow) return ''

  const at = (row: number, col: number): number => row * cols + col
  const start = at(startRow, startCol)
  const end = at(endRow, endCol)
  const cursor = at(cursorRow, cursorCol)
  const selectedCells = end - start
  const moveCells = end - cursor
  if (selectedCells <= 0 || selectedCells + Math.abs(moveCells) > MAX_CURSOR_MOVE) return ''

  const move = moveCells === 0
    ? ''
    : (moveCells > 0 ? '\x1b[C' : '\x1b[D').repeat(Math.abs(moveCells))
  return move + '\x7f'.repeat(selectedCells)
}

export interface ClickToCellInput {
  /** Pointer position, in the same space as the screen rect. */
  x: number
  y: number
  /** Bounding box of the terminal's screen element. */
  rect: { left: number; top: number; width: number; height: number }
  cols: number
  rows: number
}

/** Maps a pointer position onto a cell, clamped to the visible grid. */
export function clickToCell(input: ClickToCellInput): { col: number; row: number } | null {
  const { x, y, rect, cols, rows } = input
  if (rect.width <= 0 || rect.height <= 0 || cols <= 0 || rows <= 0) return null
  const cellW = rect.width / cols
  const cellH = rect.height / rows
  const col = clamp(Math.floor((x - rect.left) / cellW), 0, cols - 1)
  const row = clamp(Math.floor((y - rect.top) / cellH), 0, rows - 1)
  return { col, row }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
