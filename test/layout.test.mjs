/**
 * The split tree: rearranging it into named shapes, exchanging what two panes
 * show, and deciding where an arrow key lands.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  allLeaves,
  applyPreset,
  leaf,
  paneInDirection,
  paneOrder,
  paneView,
  removePane,
  setPaneSession,
  setPaneView,
  setVisualArtifact,
  splitPane,
  swapPaneSessions
} from '../src/renderer/src/lib/layout.js'

/** A tree of `n` panes, each showing session `s1`…`sn`, in one column. */
function column(n) {
  const children = Array.from({ length: n }, (_, i) => leaf(`s${i + 1}`))
  if (n === 1) return children[0]
  return {
    type: 'split',
    id: 'root',
    dir: 'v',
    sizes: children.map(() => 1 / n),
    children
  }
}

const ids = (node) => paneOrder(node)
const sessions = (node) => allLeaves(node).map((l) => l.sessionId)

/** left/top/right/bottom, the four numbers paneInDirection reads. */
function rect(id, left, top, right, bottom) {
  return { id, left, top, right, bottom }
}

/** Four equal panes in a 2×2 grid, each 100×100. */
const GRID_2X2 = [
  rect('tl', 0, 0, 100, 100),
  rect('tr', 100, 0, 200, 100),
  rect('bl', 0, 100, 100, 200),
  rect('br', 100, 100, 200, 200)
]

describe('arranging panes into a preset', () => {
  test('reuses the existing leaves, because their ids are what keep terminals alive', () => {
    const before = column(4)
    const originals = allLeaves(before)
    const after = applyPreset(before, 'columns')

    assert.deepEqual(ids(after), ids(before))
    // Identity, not just equal ids: a fresh object with the same id would still
    // be a new React element and would still remount the terminal.
    allLeaves(after).forEach((l, i) => assert.equal(l, originals[i]))
  })

  test('columns is one row of equal children; rows is one column', () => {
    const cols = applyPreset(column(3), 'columns')
    assert.equal(cols.type, 'split')
    assert.equal(cols.dir, 'h')
    assert.equal(cols.children.length, 3)
    assert.deepEqual(cols.sizes, [1 / 3, 1 / 3, 1 / 3])

    const rows = applyPreset(column(3), 'rows')
    assert.equal(rows.dir, 'v')
    assert.equal(rows.children.length, 3)
  })

  test('focus gives the first pane the majority and stacks the rest beside it', () => {
    const focus = applyPreset(column(4), 'focus')
    assert.equal(focus.dir, 'h')
    assert.deepEqual(focus.sizes, [0.68, 0.32])

    const [main, strip] = focus.children
    assert.equal(main.type, 'leaf')
    assert.equal(main.sessionId, 's1')
    assert.equal(strip.dir, 'v')
    assert.deepEqual(sessions(strip), ['s2', 's3', 's4'])
  })

  test('focus with two panes stacks nothing — the strip is just the other pane', () => {
    const focus = applyPreset(column(2), 'focus')
    assert.deepEqual(focus.children.map((c) => c.type), ['leaf', 'leaf'])
    assert.deepEqual(sessions(focus), ['s1', 's2'])
  })

  test('auto is a balanced grid, and puts the short row last', () => {
    const four = applyPreset(column(4), 'auto')
    assert.equal(four.dir, 'v')
    assert.deepEqual(four.children.map((r) => sessions(r)), [['s1', 's2'], ['s3', 's4']])

    // Five panes: three across, then two. Leftover width beats leftover height
    // for line-oriented terminal output.
    const five = applyPreset(column(5), 'auto')
    assert.deepEqual(five.children.map((r) => sessions(r)), [['s1', 's2', 's3'], ['s4', 's5']])
  })

  test('a single pane is left alone rather than wrapped in a pointless split', () => {
    const one = column(1)
    for (const preset of ['auto', 'focus', 'columns', 'rows']) {
      const after = applyPreset(one, preset)
      assert.equal(after.type, 'leaf', preset)
      assert.equal(after.id, one.id, preset)
    }
  })

  test('every preset keeps every session, in reading order', () => {
    for (const preset of ['auto', 'focus', 'columns', 'rows']) {
      assert.deepEqual(sessions(applyPreset(column(6), preset)),
        ['s1', 's2', 's3', 's4', 's5', 's6'], preset)
    }
  })
})

describe('swapping what two panes show', () => {
  test('the sessions move and the panes stay put', () => {
    const before = column(3)
    const [a, , c] = ids(before)
    const after = swapPaneSessions(before, a, c)

    assert.deepEqual(ids(after), ids(before))
    assert.deepEqual(sessions(after), ['s3', 's2', 's1'])
  })

  test('swapping with an empty pane moves the session and empties the source', () => {
    const empty = leaf(null)
    const busy = leaf('s1')
    const root = { type: 'split', id: 'r', dir: 'h', sizes: [0.5, 0.5], children: [busy, empty] }

    const after = swapPaneSessions(root, busy.id, empty.id)
    assert.deepEqual(sessions(after), [null, 's1'])
  })
})

describe('visual panes', () => {
  test('old leaves stay terminal, while a visual split mirrors the focused session', () => {
    const original = leaf('artist')
    assert.equal(paneView(original), 'terminal')

    const { layout, newPaneId } = splitPane(original, original.id, 'h', 'artist', {
      view: 'visual',
      artifactPath: '/work/art.html'
    })
    const visual = allLeaves(layout).find((item) => item.id === newPaneId)
    assert.equal(paneView(visual), 'visual')
    assert.equal(visual.sessionId, 'artist')
    assert.equal(visual.artifact.path, '/work/art.html')
  })

  test('the same artifact path gets a new revision on every visual turn', () => {
    const visual = leaf('artist', 'visual')
    const first = setVisualArtifact(visual, 'artist', '/work/art.html')
    const second = setVisualArtifact(first, 'artist', '/work/art.html')

    assert.equal(first.artifact.revision, 1)
    assert.equal(second.artifact.revision, 2)
    assert.equal(setVisualArtifact(second, 'someone-else', '/x.svg'), second)
  })

  test('presentation can toggle without losing the artifact', () => {
    const visual = setVisualArtifact(leaf('artist', 'visual'), 'artist', '/work/art.html')
    const terminal = setPaneView(visual, visual.id, 'terminal')
    const restored = setPaneView(terminal, visual.id, 'visual')

    assert.equal(paneView(terminal), 'terminal')
    assert.equal(restored.artifact.path, '/work/art.html')
    assert.equal(paneView(restored), 'visual')
  })

  test('assigning a different session clears the previous session artifact', () => {
    const visual = setVisualArtifact(leaf('artist', 'visual'), 'artist', '/work/art.html')
    const reassigned = setPaneSession(visual, visual.id, 'reviewer')

    assert.equal(reassigned.sessionId, 'reviewer')
    assert.equal(reassigned.artifact, undefined)
    assert.equal(paneView(reassigned), 'visual')
  })
})

describe('parking a pane', () => {
  test('removing the last pane yields nothing, which is why minimize empties it', () => {
    // minimizePane leans on this: `removePane(...) ?? setPaneSession(..., null)`.
    // If the last pane were removable, minimizing it would take the tab and the
    // chip strip with it.
    const one = column(1)
    assert.equal(removePane(one, one.id), null)

    const emptied = setPaneSession(one, one.id, null)
    assert.equal(emptied.type, 'leaf')
    assert.equal(emptied.id, one.id)
    assert.equal(emptied.sessionId, null)
  })

  test('removing one of several collapses the split rather than leaving a gap', () => {
    const before = column(2)
    const [a, b] = ids(before)
    const after = removePane(before, a)
    assert.equal(after.type, 'leaf')
    assert.equal(after.id, b)
  })
})

describe('deciding where an arrow key lands', () => {
  test('moves to the neighbour on that side of a 2×2 grid', () => {
    assert.equal(paneInDirection(GRID_2X2, 'tl', 'right'), 'tr')
    assert.equal(paneInDirection(GRID_2X2, 'tr', 'left'), 'tl')
    assert.equal(paneInDirection(GRID_2X2, 'tl', 'down'), 'bl')
    assert.equal(paneInDirection(GRID_2X2, 'bl', 'up'), 'tl')
  })

  test('the edge of the grid is a dead end, not a wrap', () => {
    // Wrapping would mean ⌘→ held down never settles, and you would lose track
    // of which pane you are in.
    assert.equal(paneInDirection(GRID_2X2, 'tr', 'right'), null)
    assert.equal(paneInDirection(GRID_2X2, 'tl', 'up'), null)
    assert.equal(paneInDirection(GRID_2X2, 'bl', 'left'), null)
  })

  test('an unknown pane, or a lone pane, has nowhere to go', () => {
    assert.equal(paneInDirection(GRID_2X2, 'nope', 'right'), null)
    assert.equal(paneInDirection([rect('only', 0, 0, 10, 10)], 'only', 'down'), null)
  })

  test('out of a tall pane, it lands on the one you are level with', () => {
    // A full-height pane on the left and two unequal panes stacked on the
    // right. The tall pane's centre line (y=100) falls inside the lower one.
    const rects = [
      rect('tall', 0, 0, 100, 200),
      rect('top', 100, 0, 200, 60),
      rect('bottom', 100, 60, 200, 200)
    ]
    assert.equal(paneInDirection(rects, 'tall', 'right'), 'bottom')
    assert.equal(paneInDirection(rects, 'top', 'left'), 'tall')
    assert.equal(paneInDirection(rects, 'bottom', 'left'), 'tall')
  })

  test('a dead-even tie goes to the first pane in reading order', () => {
    // Centre line exactly between two equal neighbours. Any answer is
    // defensible; what matters is that it is always the same answer.
    const rects = [
      rect('tall', 0, 0, 100, 200),
      rect('top', 100, 0, 200, 90),
      rect('bottom', 100, 110, 200, 200)
    ]
    assert.equal(paneInDirection(rects, 'tall', 'right'), 'top')
  })

  test('the nearer pane wins even when a farther one is better aligned', () => {
    const rects = [
      rect('c1', 0, 0, 100, 200),
      // Middle column is offset from c1's centre line; the far column is not.
      rect('c2', 100, 0, 200, 90),
      rect('c3', 200, 0, 300, 200)
    ]
    assert.equal(paneInDirection(rects, 'c1', 'right'), 'c2')
  })

  test('a pane that merely overlaps is not "beyond" you', () => {
    // Same left edge, so nothing has actually been passed going left.
    const rects = [rect('a', 0, 0, 200, 100), rect('b', 0, 100, 200, 200)]
    assert.equal(paneInDirection(rects, 'a', 'left'), null)
    assert.equal(paneInDirection(rects, 'a', 'down'), 'b')
  })
})
