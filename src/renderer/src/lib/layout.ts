/**
 * Pure helpers for the split-pane tree. Kept separate from React so the tricky
 * parts (splitting, removing, rebalancing) are easy to reason about.
 */

import type { LayoutNode, PaneView, Tab } from '../../../shared/types'

export function uid(prefix = 'n'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export function leaf(
  sessionId: string | null = null,
  view: PaneView = 'terminal',
  artifactPath?: string
): LayoutNode {
  return {
    type: 'leaf',
    id: uid('pane'),
    sessionId,
    // Keep ordinary leaves in their old on-disk shape. Besides making state
    // files quieter, absence is the compatibility contract for old layouts.
    ...(view === 'visual' ? { view } : {}),
    ...(artifactPath ? { artifact: { path: artifactPath, revision: 0 } } : {})
  }
}

export function newTab(
  title = 'Workspace',
  sessionId: string | null = null,
  view: PaneView = 'terminal'
): Tab {
  const root = leaf(sessionId, view)
  return { id: uid('tab'), title, layout: root, activePaneId: root.id, zoomedPaneId: null }
}

export function findLeaf(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null
  for (const child of node.children) {
    const hit = findLeaf(child, paneId)
    if (hit) return hit
  }
  return null
}

export function allLeaves(node: LayoutNode): Extract<LayoutNode, { type: 'leaf' }>[] {
  if (node.type === 'leaf') return [node]
  return node.children.flatMap(allLeaves)
}

/** The session a specific pane is showing, if that pane exists and has one. */
export function sessionInPane(node: LayoutNode, paneId: string): string | null {
  const hit = findLeaf(node, paneId)
  return hit && hit.type === 'leaf' ? hit.sessionId : null
}

export function sessionIdsIn(node: LayoutNode): string[] {
  return allLeaves(node)
    .map((l) => l.sessionId)
    .filter((id): id is string => !!id)
}

/**
 * Splits a pane in the given direction. If the parent already runs along that
 * axis we append a sibling instead of nesting — the same flattening tmux does,
 * which keeps deep layouts from turning into a matryoshka of 2-way splits.
 */
export function splitPane(
  root: LayoutNode,
  paneId: string,
  dir: 'h' | 'v',
  sessionId: string | null,
  options: { view?: PaneView; artifactPath?: string } = {}
): { layout: LayoutNode; newPaneId: string } {
  const fresh = leaf(sessionId, options.view, options.artifactPath)

  const walk = (node: LayoutNode, parentDir: 'h' | 'v' | null): LayoutNode => {
    if (node.type === 'leaf') {
      if (node.id !== paneId) return node
      return {
        type: 'split',
        id: uid('split'),
        dir,
        sizes: [0.5, 0.5],
        children: [node, fresh]
      }
    }

    // Direct child match on the same axis → append as a sibling.
    if (node.dir === dir) {
      const idx = node.children.findIndex((c) => c.type === 'leaf' && c.id === paneId)
      if (idx >= 0) {
        const children = [...node.children]
        children.splice(idx + 1, 0, fresh)
        const each = 1 / children.length
        return { ...node, children, sizes: children.map(() => each) }
      }
    }

    return { ...node, children: node.children.map((c) => walk(c, node.dir)) }
  }

  return { layout: walk(root, null), newPaneId: fresh.id }
}

/** Removes a pane and collapses any split left with a single child. */
export function removePane(root: LayoutNode, paneId: string): LayoutNode | null {
  if (root.type === 'leaf') return root.id === paneId ? null : root

  const kept: LayoutNode[] = []
  const keptSizes: number[] = []
  root.children.forEach((child, i) => {
    const next = removePane(child, paneId)
    if (next) {
      kept.push(next)
      keptSizes.push(root.sizes[i] ?? 1 / root.children.length)
    }
  })

  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]

  // Renormalise so the survivors still sum to 1.
  const total = keptSizes.reduce((a, b) => a + b, 0) || 1
  return { ...root, children: kept, sizes: keptSizes.map((s) => s / total) }
}

/** Replaces the session shown in a pane. */
export function setPaneSession(
  root: LayoutNode,
  paneId: string,
  sessionId: string | null
): LayoutNode {
  if (root.type === 'leaf') {
    if (root.id !== paneId || root.sessionId === sessionId) return root
    // An artifact belongs to the session that made it. Reassigning the pane
    // without clearing this would put the previous agent's work behind the new
    // agent's prompt box, which is a much worse lie than an empty canvas.
    const { artifact: _oldArtifact, ...withoutArtifact } = root
    return { ...withoutArtifact, sessionId }
  }
  return { ...root, children: root.children.map((c) => setPaneSession(c, paneId, sessionId)) }
}

/** Terminal is the default so layouts written before visual panes keep working. */
export function paneView(node: LayoutNode): PaneView {
  return node.type === 'leaf' && node.view === 'visual' ? 'visual' : 'terminal'
}

/** Changes presentation without moving the session or discarding its last visual. */
export function setPaneView(root: LayoutNode, paneId: string, view: PaneView): LayoutNode {
  if (root.type === 'leaf') {
    if (root.id !== paneId || paneView(root) === view) return root
    if (view === 'visual') return { ...root, view }
    const { view: _oldView, ...terminal } = root
    return terminal
  }
  const children = root.children.map((child) => setPaneView(child, paneId, view))
  return children.every((child, i) => child === root.children[i]) ? root : { ...root, children }
}

/**
 * Points every visual mirror of a session at the file it just produced.
 *
 * A revision is separate from the path because visual work is iterative: the
 * useful case rewrites one HTML file over and over, and a path-only React
 * dependency would render the first turn forever.
 */
export function setVisualArtifact(
  root: LayoutNode,
  sessionId: string,
  artifactPath: string
): LayoutNode {
  if (root.type === 'leaf') {
    if (root.view !== 'visual' || root.sessionId !== sessionId) return root
    return {
      ...root,
      artifact: {
        path: artifactPath,
        revision: (root.artifact?.revision ?? 0) + 1
      }
    }
  }
  const children = root.children.map((child) =>
    setVisualArtifact(child, sessionId, artifactPath)
  )
  return children.every((child, i) => child === root.children[i]) ? root : { ...root, children }
}

/** Updates the ratios of one split node during a drag. */
export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (root.type === 'leaf') return root
  if (root.id === splitId) return { ...root, sizes }
  return { ...root, children: root.children.map((c) => setSizes(c, splitId, sizes)) }
}

/** First pane showing a given session, if any. */
export function paneShowing(root: LayoutNode, sessionId: string): string | null {
  return allLeaves(root).find((l) => l.sessionId === sessionId)?.id ?? null
}

/** Swaps what two panes are showing, leaving the panes themselves where they are. */
export function swapPaneSessions(root: LayoutNode, a: string, b: string): LayoutNode {
  const sa = sessionInPane(root, a)
  const sb = sessionInPane(root, b)
  return setPaneSession(setPaneSession(root, a, sb), b, sa)
}

// ── presets ────────────────────────────────────────────────────────────────

/**
 * `auto`    — a balanced grid, the everyday arrangement for any N.
 * `focus`   — one large pane with the rest stacked beside it.
 * `columns` — one row of equal columns.
 * `rows`    — one column of equal rows.
 *
 * There is deliberately no strict N×M grid: with a balanced `auto` already on
 * the list, the only thing a strict grid adds is empty slots, and an empty pane
 * is one split away whenever you actually want one.
 */
export type LayoutPreset = 'auto' | 'focus' | 'columns' | 'rows'

export const LAYOUT_PRESETS: { key: LayoutPreset; label: string; title: string }[] = [
  { key: 'auto', label: 'Auto', title: 'Balanced grid — the everyday arrangement' },
  { key: 'focus', label: 'Spotlight', title: 'One large pane, the rest stacked beside it' },
  { key: 'columns', label: 'Cols', title: 'Equal columns, side by side' },
  { key: 'rows', label: 'Rows', title: 'Equal rows, stacked' }
]

function evenSplit(dir: 'h' | 'v', children: LayoutNode[]): LayoutNode {
  if (children.length === 1) return children[0]
  const each = 1 / children.length
  return { type: 'split', id: uid('split'), dir, sizes: children.map(() => each), children }
}

/**
 * Rearrange a tab's panes into a named shape.
 *
 * The existing leaf *objects* are reused rather than rebuilt. That is not
 * tidiness: a leaf's id is what React keys the pane on, so minting fresh ids
 * would unmount and remount every xterm — dropping each tmux client and
 * repainting every screen — for what is meant to be a rearrangement. Only the
 * split nodes above them are new.
 */
export function applyPreset(root: LayoutNode, preset: LayoutPreset): LayoutNode {
  const leaves: LayoutNode[] = allLeaves(root)
  if (leaves.length <= 1) return leaves[0] ?? root

  switch (preset) {
    case 'columns':
      return evenSplit('h', leaves)

    case 'rows':
      return evenSplit('v', leaves)

    case 'focus': {
      const [first, ...rest] = leaves
      // 68/32 rather than half and half — a "focus" that gave the focused pane
      // the same width as the strip beside it would not be one.
      return {
        type: 'split',
        id: uid('split'),
        dir: 'h',
        sizes: [0.68, 0.32],
        children: [first, evenSplit('v', rest)]
      }
    }

    case 'auto':
    default: {
      // Square-ish, and wider than tall on the last row when N is not a perfect
      // square: terminal output is line-oriented, so leftover width costs less
      // than leftover height.
      const cols = Math.ceil(Math.sqrt(leaves.length))
      const rows: LayoutNode[] = []
      for (let i = 0; i < leaves.length; i += cols) {
        rows.push(evenSplit('h', leaves.slice(i, i + cols)))
      }
      return evenSplit('v', rows)
    }
  }
}

/** An empty pane we can drop a session into rather than splitting again. */
export function firstEmptyPane(root: LayoutNode): string | null {
  return allLeaves(root).find((l) => !l.sessionId)?.id ?? null
}

// ── directional navigation ─────────────────────────────────────────────────

export type Direction = 'left' | 'right' | 'up' | 'down'

/** A pane's on-screen box. Same shape as a DOMRect, narrowed to what we read. */
export interface PaneRect {
  id: string
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Panes in reading order — depth-first, left to right, which for this tree is
 * exactly top-left to bottom-right on screen. This is the order the pane
 * numbers count in, so ⌘3 always means "the third pane you'd read".
 */
export function paneOrder(root: LayoutNode): string[] {
  return allLeaves(root).map((l) => l.id)
}

/**
 * The pane a directional move lands on, decided from geometry rather than from
 * the tree.
 *
 * The tree is the wrong oracle here: after a few splits, the pane visually to
 * your right can be an arbitrary distance away in the tree, and walking the
 * tree gives moves that feel random. Rects are what the eye uses, so rects are
 * what the keyboard should use.
 */
export function paneInDirection(
  rects: PaneRect[],
  fromId: string,
  dir: Direction
): string | null {
  const from = rects.find((r) => r.id === fromId)
  if (!from) return null

  const horizontal = dir === 'left' || dir === 'right'
  // Where the cursor "is" across the axis of travel: the source's centre line.
  const mid = horizontal ? (from.top + from.bottom) / 2 : (from.left + from.right) / 2

  let best: string | null = null
  let bestGap = 0
  let bestOff = 0

  for (const r of rects) {
    if (r.id === fromId) continue

    // Genuinely on that side — measured by the leading edge, so a pane that
    // merely overlaps the source does not count as being beyond it.
    const advance =
      dir === 'left'
        ? from.left - r.left
        : dir === 'right'
          ? r.right - from.right
          : dir === 'up'
            ? from.top - r.top
            : r.bottom - from.bottom
    if (advance <= 0.5) continue

    // Distance along the axis of travel, and how far the candidate's band sits
    // off the centre line. Zero when the centre line runs through it.
    const gap = Math.max(
      0,
      dir === 'left'
        ? from.left - r.right
        : dir === 'right'
          ? r.left - from.right
          : dir === 'up'
            ? from.top - r.bottom
            : r.top - from.bottom
    )
    const lo = horizontal ? r.top : r.left
    const hi = horizontal ? r.bottom : r.right
    const off = mid < lo ? lo - mid : mid > hi ? mid - hi : 0

    // Nearest along the axis wins; the offset only settles ties between panes
    // at the same depth. That is what makes ⌘→ out of a tall left pane land on
    // the right-hand pane you are level with rather than the top one.
    const nearer = best === null || gap < bestGap - 1
    const level = best !== null && Math.abs(gap - bestGap) <= 1 && off < bestOff
    if (nearer || level) {
      best = r.id
      bestGap = gap
      bestOff = off
    }
  }

  return best
}
