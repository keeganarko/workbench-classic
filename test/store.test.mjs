/**
 * Persistence: migration from the v1 schema, recovery from a damaged file, and
 * a write failure that is reported rather than swallowed.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { Store, migrate, emptyState, STORE_VERSION } from '../src/main/store.js'
import { tempDir, persistedDescriptor } from './helpers.mjs'

/** The shape Workbench wrote before the status vocabulary was fixed. */
function v1Document() {
  return {
    version: 1,
    prefs: {
      fontSize: 900,
      scrollback: 5,
      sessionLogMaxMb: 99999,
      defaultPermissionMode: 'root-access',
      triggers: [
        { id: 't1', name: 'perm', pattern: 'Do you want', action: 'waiting' },
        { id: 't2', name: 'err', pattern: 'Traceback', action: 'highlight' },
        { id: 't3', name: 'busy', pattern: 'Thinking', action: 'running' },
        { id: 't4', name: 'fin', pattern: 'Done', action: 'done' },
        { id: 'bad', pattern: 42 }
      ]
    },
    sessions: [
      {
        id: 's1',
        agent: 'claude',
        status: 'running',
        cwd: '/tmp/one',
        tmuxName: 'term_s1',
        waitingReason: 'Grant file access?'
      },
      { id: 's2', agent: 'codex', status: 'done', cwd: '/tmp/two' },
      { id: 's3', agent: 'codex', status: 'not-a-status' },
      { agent: 'claude', status: 'running' },
      'nonsense'
    ],
    descriptors: [
      persistedDescriptor({ sessionId: 's1' }),
      { sessionId: 's2' },
      { version: 1, sessionId: 's3', command: 'x', baseArgs: 'nope', launchArgs: [], cwd: '/tmp' }
    ]
  }
}

describe('store', () => {
  test('App Manager persists only an explicit null-bound grant and old grants never widen', () => {
    const document = v1Document()
    document.sessions = [
      { id: 'app', bus: 'app-manager', busProjectId: null, sessionProjectId: 'one' },
      { id: 'unfiled-app', bus: 'app-manager', busProjectId: null, sessionProjectId: null },
      { id: 'project', bus: 'manager', busProjectId: 'one', sessionProjectId: 'one' },
      { id: 'missing-binding', bus: 'app-manager', sessionProjectId: 'one' },
      { id: 'project-binding', bus: 'app-manager', busProjectId: 'one', sessionProjectId: 'one' },
      { id: 'unknown', bus: 'global-manager' },
      { id: 'ordinary', bus: 'full' }
    ]
    const { data } = migrate(document)
    assert.deepEqual(data.sessions.map(s => [s.id, s.bus, s.busProjectId]), [
      ['app', 'app-manager', null], ['unfiled-app', 'app-manager', null], ['project', 'manager', 'one'],
      ['missing-binding', 'off', null], ['project-binding', 'off', null], ['unknown', 'off', null], ['ordinary', 'full', null]
    ])
  })

  test('prompt recency survives migration and older or malformed timestamps stay unknown', () => {
    const document = v1Document()
    document.sessions = [
      { id: 'new', lastPromptAt: 1234 }, { id: 'old' },
      { id: 'invalid', lastPromptAt: -1 }, { id: 'infinite', lastPromptAt: Infinity }
    ]
    const { data } = migrate(document)
    assert.deepEqual(data.sessions.map((session) => session.lastPromptAt), [1234, null, null, null])
  })

  test('a fresh install gets current defaults', () => {
    const store = new Store(tempDir())
    assert.equal(store.error, null)
    assert.equal(store.migratedFrom, null)
    assert.deepEqual(store.sessions, [])
    assert.equal(store.prefs.defaultPermissionMode, 'default')
    assert.ok(store.prefs.triggers.length > 0, 'default triggers ship with the app')
  })

  test('migrate maps v1 statuses, reasons and trigger actions onto the v2 machine', () => {
    const { data, migratedFrom } = migrate(v1Document())
    assert.equal(migratedFrom, 1)
    assert.equal(data.version, STORE_VERSION)

    const byId = Object.fromEntries(data.sessions.map((s) => [s.id, s]))
    assert.equal(byId.s1.status, 'working', '"running" is now "working"')
    assert.equal(byId.s1.statusReason, 'Grant file access?', 'waitingReason must not be lost')
    assert.equal(byId.s2.status, 'review', '"done" is now "review"')
    assert.equal(byId.s3.status, 'idle', 'an unknown status degrades to idle, not to nothing')
    assert.equal(data.sessions.length, 3, 'sessions with no id are dropped')
    assert.equal(byId.s3.rootId, 's3', 'missing lineage is filled in')

    const actions = Object.fromEntries(data.prefs.triggers.map((t) => [t.id, t.action]))
    assert.equal(actions.t1, 'waiting')
    assert.equal(actions.t2, 'failed', '"highlight" always meant "something broke"')
    assert.equal(actions.t3, 'working')
    assert.equal(actions.t4, 'review')
    assert.ok(!('bad' in actions), 'a trigger with no pattern is dropped')
  })

  test('migrate clamps out-of-range numbers and rejects an unknown permission mode', () => {
    const { data } = migrate(v1Document())
    assert.equal(data.prefs.fontSize, 48)
    assert.equal(data.prefs.scrollback, 1000)
    assert.equal(data.prefs.sessionLogMaxMb, 2048)
    assert.equal(data.prefs.defaultPermissionMode, 'default')
  })

  test('migrate keeps only well-formed launch descriptors', () => {
    const { data } = migrate(v1Document())
    assert.equal(data.descriptors.length, 1)
    assert.equal(data.descriptors[0].sessionId, 's1')
  })

  test('a current-schema document keeps the statuses it was saved with', () => {
    // Regression: every load used to run through the v1 name table alone, so
    // `working`, `review` and `failed` all fell through to `idle`. Quitting the
    // app turned a session that was mid-turn — or finished and unread — neutral.
    const doc = emptyState()
    doc.sessions = ['idle', 'working', 'waiting', 'review', 'failed', 'exited'].map((status) => ({
      id: status,
      agent: 'claude',
      status,
      cwd: '/tmp'
    }))
    doc.prefs.triggers = [
      { id: 'a', pattern: 'x', action: 'failed' },
      { id: 'b', pattern: 'y', action: 'review' },
      { id: 'c', pattern: 'z', action: 'working' },
      { id: 'd', pattern: 'w', action: 'notify' }
    ]

    const { data } = migrate(doc)
    for (const s of data.sessions) {
      assert.equal(s.status, s.id, `${s.id} must survive a round-trip`)
    }
    assert.deepEqual(
      data.prefs.triggers.map((t) => t.action),
      ['failed', 'review', 'working', 'notify'],
      'a v2 trigger action must not be rewritten as "waiting"'
    )
  })

  test('migrate survives junk instead of throwing', () => {
    for (const junk of [null, undefined, 42, 'string', []]) {
      const { data } = migrate(junk)
      assert.equal(data.version, STORE_VERSION)
      assert.deepEqual(data.sessions, [])
    }
  })

  test('a document already at the current version is not marked as migrated', () => {
    const { migratedFrom } = migrate(emptyState())
    assert.equal(migratedFrom, null)
  })

  test('a corrupt file falls back to the backup and says so', () => {
    const dir = tempDir()
    const file = path.join(dir, 'workbench.json')
    const good = emptyState()
    good.sessions = [{ id: 'kept', agent: 'claude', status: 'waiting', cwd: '/tmp' }]
    fs.writeFileSync(`${file}.bak`, JSON.stringify(good))
    fs.writeFileSync(file, '{"version": 2, "sessions": [')

    const store = new Store(dir)
    assert.equal(store.sessions.length, 1)
    assert.equal(store.sessions[0].id, 'kept')
    assert.match(store.error ?? '', /recovered the previous version/)
    assert.ok(fs.existsSync(`${file}.corrupt`), 'the damaged file is kept, not destroyed')
    assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf8'), '{"version": 2, "sessions": [')
  })

  test('a corrupt file with no usable backup starts clean and still says so', () => {
    const dir = tempDir()
    const file = path.join(dir, 'workbench.json')
    fs.writeFileSync(file, 'total garbage')

    const store = new Store(dir)
    assert.deepEqual(store.sessions, [])
    assert.match(store.error ?? '', /no backup could be used/)
    assert.ok(fs.existsSync(`${file}.corrupt`))
  })

  test('a save rolls the last good file aside first', () => {
    const dir = tempDir()
    const file = path.join(dir, 'workbench.json')

    const first = new Store(dir)
    first.setSessions([{ id: 'v1' }])
    assert.equal(first.saveNow(), true)
    assert.equal(fs.existsSync(`${file}.bak`), false, 'nothing to back up on the first write')

    const second = new Store(dir)
    second.setSessions([{ id: 'v2' }])
    assert.equal(second.saveNow(), true)
    assert.ok(fs.existsSync(`${file}.bak`), 'the previous document is now the backup')
    assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).sessions[0].id, 'v1')
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions[0].id, 'v2')
  })

  test('state files are written owner-only', { skip: process.platform === 'win32' ? 'Windows uses profile ACLs, not POSIX permission bits' : false }, () => {
    const dir = tempDir()
    const store = new Store(dir)
    store.saveNow()
    const mode = fs.statSync(path.join(dir, 'workbench.json')).mode & 0o777
    assert.equal(mode, 0o600)
  })

  test('a failed write is reported, not swallowed, and clears on the next success', () => {
    const dir = tempDir()
    // A plain file where the state directory should be: mkdir cannot proceed.
    const blocked = path.join(dir, 'blocked')
    fs.writeFileSync(blocked, 'in the way')

    const store = new Store(path.join(blocked, 'data'))
    assert.equal(store.saveNow(), false)
    assert.match(store.error ?? '', /Could not save app state/)

    // Clear the obstruction; the next save must recover and reset the error.
    fs.rmSync(blocked)
    assert.equal(store.saveNow(), true)
    assert.equal(store.error, null)
  })

  test('workspaces round-trip, and a damaged row cannot become deletable', () => {
    const dir = tempDir()
    const first = new Store(dir)
    first.setWorkspaceState(
      [{ id: 'p1', name: 'app', root: '/repo', commonDir: '/repo/.git', origin: null, defaultBranch: 'main' }],
      [
        {
          id: 'w1',
          projectId: 'p1',
          name: 'term-fix',
          path: '/wt/term-fix',
          kind: 'worktree',
          branch: 'term/fix',
          createdByApp: true,
          createdAt: 1
        }
      ]
    )
    assert.equal(first.saveNow(), true)

    const second = new Store(dir)
    assert.equal(second.projects[0].commonDir, '/repo/.git')
    assert.equal(second.workspaces[0].branch, 'term/fix')
    assert.equal(second.workspaces[0].createdByApp, true)
  })

  test('conversation projects round-trip independently of Git repositories', () => {
    const dir = tempDir()
    const first = new Store(dir)
    const project = first.createSessionProject('Mission Control', '/code/mission-control')
    first.renameSessionProject(project.id, 'Mission Control HQ')
    assert.equal(first.saveNow(), true)

    const second = new Store(dir)
    assert.deepEqual(second.sessionProjects, [
      {
        id: project.id,
        name: 'Mission Control HQ',
        defaultCwd: '/code/mission-control',
        createdAt: project.createdAt
      }
    ])
    assert.deepEqual(second.projects, [], 'the Git repository catalog is a separate concept')
    assert.equal(second.removeSessionProject(project.id), true)
    assert.equal(second.removeSessionProject(project.id), false)
  })

  test('a workspace row that lost its flag is treated as somebody else\'s', () => {
    // The unsafe direction is exactly one way round: reading a damaged row as
    // "Workbench made this" would hand it a delete button for a worktree it
    // never created.
    const { data } = migrate({
      version: STORE_VERSION,
      workspaces: [
        { id: 'w1', path: '/wt/x', kind: 'worktree' },
        { id: 'w2', path: '/wt/y', kind: 'worktree', createdByApp: 'yes' },
        { path: '/wt/no-id' },
        'nonsense'
      ]
    })
    assert.equal(data.workspaces.length, 2, 'rows with no id or no path are dropped')
    assert.equal(data.workspaces[0].createdByApp, false)
    assert.equal(data.workspaces[1].createdByApp, false, 'only a real boolean true counts')
    assert.equal(data.workspaces[0].projectId, null)
  })

  test('a document from before workspaces existed gets empty ones', () => {
    const { data } = migrate({ version: 2, sessions: [], prefs: {} })
    assert.deepEqual(data.sessionProjects, [])
    assert.deepEqual(data.projects, [])
    assert.deepEqual(data.workspaces, [])
  })

  test('preferences, sessions, descriptors and tabs all round-trip', () => {
    const dir = tempDir()
    const first = new Store(dir)
    first.setPrefs({ defaultPermissionMode: 'full-access', fontSize: 15 })
    first.setSessions([{ id: 'r1', agent: 'codex', status: 'waiting', cwd: '/tmp' }])
    first.setDescriptors([persistedDescriptor({ sessionId: 'r1', permissionMode: 'full-access' })])
    first.setTabs(
      [
        {
          id: 'tab1',
          layout: {
            id: 'leaf',
            type: 'leaf',
            sessionId: 'r1',
            view: 'visual',
            artifact: { path: '/tmp/art.html', revision: 3 }
          }
        }
      ],
      'tab1'
    )
    assert.equal(first.saveNow(), true)

    const second = new Store(dir)
    assert.equal(second.prefs.defaultPermissionMode, 'full-access')
    assert.equal(second.prefs.fontSize, 15)
    assert.equal(second.sessions[0].id, 'r1')
    assert.equal(second.sessions[0].status, 'waiting')
    assert.equal(second.descriptors[0].permissionMode, 'full-access')
    assert.equal(second.activeTabId, 'tab1')
    assert.equal(second.tabs[0].layout.view, 'visual')
    assert.deepEqual(second.tabs[0].layout.artifact, { path: '/tmp/art.html', revision: 3 })
    assert.equal(second.error, null)
  })

  test('a store with no custom agents at all reads as an empty list', () => {
    // Every store written before Settings → Agents existed. `undefined` here
    // would crash the first `.filter` in the profile builder.
    assert.deepEqual(migrate(v1Document()).data.prefs.customAgents, [])
  })

  test('a hand-edited agent list keeps what it can and drops the rest', () => {
    // store.json is a file a person can open, and load must never throw on a
    // bad one: a single malformed profile would otherwise cost every session.
    const doc = {
      version: STORE_VERSION,
      prefs: {
        customAgents: [
          { id: 'gemini', label: 'Gemini CLI', command: 'gemini', color: '#4285f4' },
          { id: 'codex', label: 'Impostor', command: 'nope' },
          { id: 'No Good', label: 'Bad Id', command: 'x' },
          { id: 'nameless', label: '  ', command: 'x' },
          { id: 'commandless', label: 'No Command', command: '' },
          'not an object',
          { id: 'aider', label: 'Aider', command: 'aider', color: 'chartreuse', args: 'nope' }
        ]
      }
    }
    const agents = migrate(doc).data.prefs.customAgents
    assert.deepEqual(
      agents.map((a) => a.id),
      ['gemini', 'aider']
    )
    // A colour that is not a hex triple falls back rather than reaching the CSS.
    assert.equal(agents[1].color, '#8b949e')
    assert.deepEqual(agents[1].args, [])
  })

  test('a custom agent survives a save and a reload', () => {
    const dir = tempDir()
    const first = new Store(dir)
    first.setPrefs({
      customAgents: [
        { id: 'gemini', label: 'Gemini CLI', command: 'gemini', args: [], color: '#4285f4' }
      ]
    })
    assert.equal(first.saveNow(), true)
    assert.deepEqual(new Store(dir).prefs.customAgents[0].label, 'Gemini CLI')
  })
})
