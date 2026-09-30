/**
 * Arranging sessions by repository.
 *
 * The rules worth pinning are the ones that decide whether a session is
 * visible at all: an unresolvable project must not make a row disappear, and
 * an empty repo selection must not quietly become "everyone".
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  UNGROUPED,
  groupSessionsByProject,
  groupSessionsByWorkbenchProject,
  projectIdOf,
  projectLabel,
  projectsWithLiveSessions
} from '../src/shared/grouping.js'

function project(id, over = {}) {
  return {
    id,
    name: id,
    root: `/repos/${id}`,
    commonDir: `/repos/${id}/.git`,
    origin: null,
    defaultBranch: 'main',
    ...over
  }
}

function workspace(id, projectId, over = {}) {
  return {
    id,
    projectId,
    name: id,
    path: `/repos/${id}`,
    kind: projectId ? 'main' : 'local',
    branch: 'main',
    createdByApp: false,
    createdAt: 0,
    ...over
  }
}

function session(id, workspaceId, over = {}) {
  return {
    id,
    title: id,
    agent: 'claude',
    status: 'idle',
    cwd: '/repos/x',
    alive: true,
    lastActivityAt: 0,
    workspaceId,
    pinned: false,
    depth: 0,
    ...over
  }
}

describe('naming a repository', () => {
  test('a known remote reads as owner/name, without the host', () => {
    assert.equal(projectLabel(project('p1', { origin: 'github.com/me/app' })), 'me/app')
  })

  test('a repository with no remote falls back to its folder name', () => {
    assert.equal(projectLabel(project('p1', { name: 'scratch' })), 'scratch')
  })

  test('an origin too short to carry an owner is not sliced into nonsense', () => {
    assert.equal(projectLabel(project('p1', { name: 'fallback', origin: 'weird' })), 'fallback')
  })
})

describe('grouping sessions by Workbench project', () => {
  const projects = [
    { id: 'p1', name: 'Mission Control', defaultCwd: '/code', createdAt: 1 },
    { id: 'p2', name: 'Private Writing', defaultCwd: '/notes', createdAt: 2 }
  ]

  test('uses explicit project membership rather than the session repository', () => {
    const groups = groupSessionsByWorkbenchProject(
      [
        session('code', 'w1', { sessionProjectId: 'p1', lastActivityAt: 10 }),
        session('notes', 'w1', { sessionProjectId: 'p2', lastActivityAt: 20 }),
        session('loose', 'w1', { sessionProjectId: null, lastActivityAt: 30 })
      ],
      projects
    )
    assert.deepEqual(groups.map((group) => group.label), [
      'Private Writing',
      'Mission Control',
      'No project'
    ])
  })

  test('keeps an empty project visible so its new-terminal button has a home', () => {
    const groups = groupSessionsByWorkbenchProject([], projects)
    assert.equal(groups.length, 2)
    assert.ok(groups.every((group) => group.sessions.length === 0))
  })
})

describe('finding a session’s repository', () => {
  const ws = [workspace('w1', 'p1'), workspace('w2', null)]

  test('a session in a repository workspace reports that project', () => {
    assert.equal(projectIdOf(session('s1', 'w1'), ws), 'p1')
  })

  test('a session in a plain folder has no project', () => {
    assert.equal(projectIdOf(session('s2', 'w2'), ws), null)
  })

  test('a session filed under nothing, or under a workspace that is gone', () => {
    assert.equal(projectIdOf(session('s3', null), ws), null)
    assert.equal(projectIdOf(session('s4', 'vanished'), ws), null)
  })
})

describe('grouping sessions by repository', () => {
  const projects = [
    project('p1', { origin: 'github.com/me/app' }),
    project('p2', { origin: 'github.com/me/site' })
  ]
  const ws = [workspace('w1', 'p1'), workspace('w2', 'p2'), workspace('w3', null)]

  test('sessions land under their repository, and loose ones under a bucket at the end', () => {
    const groups = groupSessionsByProject(
      [
        session('a', 'w1', { lastActivityAt: 100 }),
        session('b', 'w3', { lastActivityAt: 500 }),
        session('c', 'w2', { lastActivityAt: 200 })
      ],
      ws,
      projects
    )

    assert.deepEqual(
      groups.map((g) => g.label),
      ['me/site', 'me/app', 'No repository'],
      'most recently touched repo first; the loose bucket is last despite being newest'
    )
    assert.equal(groups[2].key, UNGROUPED)
    assert.equal(groups[2].project, null)
  })

  test('a session whose project id no longer resolves still appears', () => {
    const groups = groupSessionsByProject(
      [session('a', 'w9')],
      [workspace('w9', 'deleted-project')],
      projects
    )
    assert.equal(groups.length, 1)
    assert.equal(groups[0].key, UNGROUPED, 'it falls into the loose bucket')
    assert.equal(groups[0].sessions.length, 1, 'and is not silently dropped from the sidebar')
  })

  test('every session survives the grouping, exactly once', () => {
    const input = [session('a', 'w1'), session('b', 'w1'), session('c', 'w3'), session('d', null)]
    const out = groupSessionsByProject(input, ws, projects).flatMap((g) => g.sessions)
    assert.equal(out.length, input.length)
    assert.deepEqual(new Set(out.map((s) => s.id)).size, input.length)
  })

  test('no sessions is no groups, not a group of nothing', () => {
    assert.deepEqual(groupSessionsByProject([], ws, projects), [])
  })
})

describe('offering repositories as broadcast targets', () => {
  const projects = [
    project('p1', { origin: 'github.com/me/app' }),
    project('p2', { origin: 'github.com/me/site' })
  ]
  const ws = [workspace('w1', 'p1'), workspace('w2', 'p2'), workspace('w3', null)]

  test('counts only live sessions, and omits a repo whose agents have all exited', () => {
    const opts = projectsWithLiveSessions(
      [
        session('a', 'w1'),
        session('b', 'w1'),
        session('c', 'w2', { alive: false }),
        session('d', 'w3')
      ],
      ws,
      projects
    )

    assert.deepEqual(opts, [{ id: 'p1', label: 'me/app', count: 2 }])
  })

  test('sorts by name so the list does not reshuffle under the cursor', () => {
    const opts = projectsWithLiveSessions(
      [session('a', 'w2'), session('b', 'w1')],
      ws,
      projects
    )
    assert.deepEqual(
      opts.map((o) => o.label),
      ['me/app', 'me/site']
    )
  })
})
