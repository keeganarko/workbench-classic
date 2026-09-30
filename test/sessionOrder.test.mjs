/**
 * The sidebar's top-to-bottom order, which ⌘1…⌘9 index into.
 *
 * The rules worth pinning are the ones that decide whether a digit lands where
 * the badge next to it says it will: a collapsed section contributes no rows,
 * a filtered sidebar contributes only its one section, and a pinned session is
 * counted exactly once even though its status would also place it elsewhere.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  RECENT_LIMIT,
  SECTIONS,
  numberKeyOrder,
  paneSessionOrder,
  projectSectionKey,
  repoSectionKey,
  sectionRows,
  sidebarSessionNumbers,
  sidebarSessionOrder
} from '../src/shared/sessionOrder.js'

/** Only the fields the ordering reads; the rest of a Session is noise here. */
function session(id, over = {}) {
  return {
    id,
    status: 'idle',
    pinned: false,
    alive: true,
    lastActivityAt: 0,
    workspaceId: null,
    ...over
  }
}

function project(id) {
  return {
    id,
    name: id,
    root: `/repos/${id}`,
    commonDir: `/repos/${id}/.git`,
    origin: null,
    defaultBranch: 'main'
  }
}

function workspace(id, projectId) {
  return {
    id,
    projectId,
    name: id,
    path: `/repos/${id}`,
    kind: 'main',
    branch: 'main',
    createdByApp: false,
    createdAt: 0
  }
}

/** The common case: triage grouping, nothing folded, no filter. */
function order(sessions, over = {}) {
  return sidebarSessionOrder({
    sessions,
    sessionProjects: [],
    workspaces: [],
    projects: [],
    groupBy: 'status',
    activeSection: 'recent',
    collapsed: {},
    ...over
  })
}

describe('sidebar session order', () => {
  test('walks the triage sections in the order the sidebar draws them', () => {
    const sessions = [
      session('idle-one'),
      session('review-one', { status: 'review' }),
      session('waiting-one', { status: 'waiting' }),
      session('working-one', { status: 'working' }),
      session('failed-one', { status: 'failed' })
    ]
    assert.deepEqual(order(sessions), [
      'waiting-one',
      'failed-one',
      'working-one',
      'review-one',
      'idle-one'
    ])
  })

  test('a pinned session is counted once, at the top, whatever its status', () => {
    const sessions = [
      session('other', { status: 'waiting', lastActivityAt: 2 }),
      session('star', { status: 'waiting', pinned: true, lastActivityAt: 1 })
    ]
    assert.deepEqual(order(sessions), ['star', 'other'])
  })

  test('newest activity first inside a section', () => {
    const sessions = [
      session('old', { status: 'working', lastActivityAt: 10 }),
      session('new', { status: 'working', lastActivityAt: 99 })
    ]
    assert.deepEqual(order(sessions), ['new', 'old'])
  })

  test('a collapsed section contributes no rows, so the digits close up', () => {
    const sessions = [
      session('waiting-one', { status: 'waiting' }),
      session('working-one', { status: 'working' })
    ]
    assert.deepEqual(order(sessions, { collapsed: { waiting: true } }), ['working-one'])
  })

  test('a filtered sidebar numbers only the section it is showing', () => {
    const sessions = [
      session('waiting-one', { status: 'waiting' }),
      session('working-one', { status: 'working' })
    ]
    assert.deepEqual(order(sessions, { activeSection: 'working' }), ['working-one'])
  })

  test('Recent stops where the sidebar stops drawing it', () => {
    const many = Array.from({ length: RECENT_LIMIT + 5 }, (_, i) =>
      session(`s${i}`, { lastActivityAt: i })
    )
    assert.equal(order(many).length, RECENT_LIMIT)
  })

  test('grouping by repo walks each repo section in turn, skipping collapsed ones', () => {
    const sessions = [
      session('a1', { workspaceId: 'wa', lastActivityAt: 5 }),
      session('b1', { workspaceId: 'wb', lastActivityAt: 9 }),
      session('a2', { workspaceId: 'wa', lastActivityAt: 7 })
    ]
    const repos = {
      groupBy: 'repo',
      workspaces: [workspace('wa', 'alpha'), workspace('wb', 'beta')],
      projects: [project('alpha'), project('beta')]
    }
    // beta was touched most recently, so its section is drawn first.
    assert.deepEqual(order(sessions, repos), ['b1', 'a2', 'a1'])
    assert.deepEqual(
      order(sessions, { ...repos, collapsed: { [repoSectionKey('beta')]: true } }),
      ['a2', 'a1']
    )
  })

  test('grouping by Workbench project is independent of repository grouping', () => {
    const sessions = [
      session('a', { sessionProjectId: 'writing', lastActivityAt: 5 }),
      session('b', { sessionProjectId: 'product', lastActivityAt: 9 }),
      session('c', { sessionProjectId: 'writing', lastActivityAt: 7 })
    ]
    const projects = [
      { id: 'writing', name: 'Writing', defaultCwd: '/notes', createdAt: 1 },
      { id: 'product', name: 'Product', defaultCwd: '/code', createdAt: 2 }
    ]
    const grouped = { groupBy: 'project', sessionProjects: projects }
    assert.deepEqual(order(sessions, grouped), ['b', 'c', 'a'])
    assert.deepEqual(
      order(sessions, { ...grouped, collapsed: { [projectSectionKey('product')]: true } }),
      ['c', 'a']
    )
  })

  test('exited sessions still get a row, and therefore a number', () => {
    const sessions = [session('gone', { status: 'exited', alive: false })]
    assert.deepEqual(order(sessions), ['gone'])
  })
})

describe('sidebar row numbers', () => {
  test('are 1-based and stop at nine, because there are nine digits', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`)
    const numbers = sidebarSessionNumbers(ids)
    assert.equal(numbers.get('s0'), 1)
    assert.equal(numbers.get('s8'), 9)
    assert.equal(numbers.get('s9'), undefined)
    assert.equal(numbers.size, 9)
  })
})

describe('section rows', () => {
  test('every triage section has a rule, and none of them overlap', () => {
    const sessions = [
      session('pin', { status: 'waiting', pinned: true }),
      session('wait', { status: 'waiting' }),
      session('fail', { status: 'failed' }),
      session('work', { status: 'working' }),
      session('rev', { status: 'review' }),
      session('idle', { status: 'idle' })
    ]
    const seen = SECTIONS.flatMap((def) => sectionRows(def, sessions).map((s) => s.id))
    assert.deepEqual([...seen].sort(), [...new Set(seen)].sort(), 'a session was listed twice')
    assert.equal(seen.length, sessions.length, 'a session was listed nowhere')
  })
})

/** A leaf pane. Ids only matter where a zoom has to name one. */
function pane(sessionId, id = `pane_${sessionId ?? 'empty'}`) {
  return { type: 'leaf', id, sessionId }
}

/** Children in array order are laid out left to right, which is the point. */
function split(...children) {
  return { type: 'split', id: 'split_root', dir: 'h', children, sizes: null }
}

describe('panes on screen, left to right', () => {
  test('reads a split in visual order', () => {
    const sessions = [session('a'), session('b'), session('c')]
    const layout = split(pane('a'), pane('b'), pane('c'))
    assert.deepEqual(paneSessionOrder(layout, null, sessions), ['a', 'b', 'c'])
  })

  test('nested splits still read left to right', () => {
    const sessions = [session('a'), session('b'), session('c')]
    // a | (b over c) — the walk must not surface the nested pair first.
    const layout = split(pane('a'), split(pane('b'), pane('c')))
    assert.deepEqual(paneSessionOrder(layout, null, sessions), ['a', 'b', 'c'])
  })

  test('a zoomed pane is the only thing on screen', () => {
    const sessions = [session('a'), session('b')]
    const layout = split(pane('a', 'p_a'), pane('b', 'p_b'))
    assert.deepEqual(paneSessionOrder(layout, 'p_b', sessions), ['b'])
  })

  test('empty panes and unknown sessions are not counted', () => {
    const sessions = [session('a')]
    const layout = split(pane('a'), pane(null), pane('ghost'))
    assert.deepEqual(paneSessionOrder(layout, null, sessions), ['a'])
  })

  test('the same session in two panes takes one number, not two', () => {
    const sessions = [session('a'), session('b')]
    const layout = split(pane('a', 'p1'), pane('b'), pane('a', 'p2'))
    assert.deepEqual(paneSessionOrder(layout, null, sessions), ['a', 'b'])
  })
})

describe('what the number keys walk', () => {
  /** Panes first, then whatever the sidebar has left. */
  function keys(sessions, layout, over = {}) {
    return numberKeyOrder({
      sessions,
      sessionProjects: [],
      workspaces: [],
      projects: [],
      groupBy: 'status',
      activeSection: 'recent',
      collapsed: {},
      layout,
      zoomedPaneId: null,
      ...over
    })
  }

  test('two panes take 1 and 2, and the sidebar continues from 3', () => {
    // `waiting` sorts to the top of the sidebar, so if the sidebar were
    // leading, `wait` would be number 1 rather than number 3.
    const sessions = [
      session('left', { status: 'idle', lastActivityAt: 1 }),
      session('right', { status: 'idle', lastActivityAt: 2 }),
      session('wait', { status: 'waiting' }),
      session('idle', { status: 'idle', lastActivityAt: 3 })
    ]
    const layout = split(pane('left'), pane('right'))
    assert.deepEqual(keys(sessions, layout), ['left', 'right', 'wait', 'idle'])
  })

  test('one pane open puts the next number on the top sidebar row', () => {
    const sessions = [
      session('open'),
      session('wait', { status: 'waiting' }),
      session('work', { status: 'working' })
    ]
    assert.deepEqual(keys(sessions, pane('open')), ['open', 'wait', 'work'])
  })

  test('a session on screen is never numbered twice', () => {
    const sessions = [session('a', { status: 'waiting' }), session('b')]
    const order = keys(sessions, split(pane('a'), pane('b')))
    assert.deepEqual(order, ['a', 'b'])
    assert.equal(new Set(order).size, order.length)
  })

  test('with no layout at all it is exactly the sidebar order', () => {
    const sessions = [session('wait', { status: 'waiting' }), session('idle')]
    assert.deepEqual(keys(sessions, null), sidebarSessionOrder({
      sessions,
      sessionProjects: [],
      workspaces: [],
      projects: [],
      groupBy: 'status',
      activeSection: 'recent',
      collapsed: {}
    }))
  })

  test('a collapsed sidebar still numbers the panes', () => {
    const sessions = [session('a', { status: 'waiting' }), session('b', { status: 'waiting' })]
    assert.deepEqual(
      keys(sessions, pane('a'), { collapsed: { waiting: true } }),
      ['a']
    )
  })
})
