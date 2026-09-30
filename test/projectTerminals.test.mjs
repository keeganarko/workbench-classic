import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { newTab, sessionIdsIn, sessionInPane } from '../src/renderer/src/lib/layout.js'
import { priorityProjectSession, reconcileProjectTabs, tabSession } from '../src/renderer/src/lib/projectTerminals.js'
import { asTabs } from '../src/main/validate.js'

// No PTY is started by these tests. They drive the same store actions as the
// project rail, terminal cards and IPC snapshots, then inspect what PaneGrid
// and the composer would actually receive, rather than only testing a filter.
const saves = []
globalThis.window = { term: { setTabs: async (tabs, activeTabId) => { saves.push({ tabs, activeTabId }) } } }
const { useStore } = await import('../src/renderer/src/state/store.js')
const state = () => useStore.getState()
const shown = () => sessionIdsIn(state().activeTab().layout)
const focused = () => sessionInPane(state().activeTab().layout, state().activeTab().activePaneId)
const projects = [{ id: 'mba', name: 'MBA' }, { id: 'workbench', name: 'Workbench' }, { id: 'empty', name: 'Empty' }]
const sessions = [
  { id: 'mba-1', sessionProjectId: 'mba', alive: true, lastActivityAt: 10, lastPromptAt: 20 },
  { id: 'mba-2', sessionProjectId: 'mba', alive: true, lastActivityAt: 20 },
  { id: 'wb-1', sessionProjectId: 'workbench', alive: true, lastActivityAt: 30 },
  { id: 'wb-2', sessionProjectId: 'workbench', alive: true, lastActivityAt: 40 },
  { id: 'unfiled', sessionProjectId: null, alive: true, lastActivityAt: 50 }
]

test('tab labels follow the focused role, and use remaining sessions when the pane is empty', () => {
  const first = { id: 'a', title: 'Software Engineer' }, second = { id: 'b', title: 'Financial Advisor' }
  const tab = newTab('Workspace 37', first.id)
  assert.equal(tabSession(tab, [first, second]).title, 'Software Engineer')
  const empty = newTab('Old random name')
  assert.equal(tabSession({ ...empty, minimized: ['b'] }, [first, second]).title, 'Financial Advisor')
  assert.equal(tabSession(empty, [first, second]), undefined)
})
beforeEach(() => {
  saves.length = 0
  const tab = newTab('Original workspace', 'mba-1')
  useStore.setState({ ...useStore.getInitialState(), sessions, sessionProjects: projects,
    tabs: [tab], activeTabId: tab.id, ready: true }, true)
})

test('project filter navigation keeps IDs distinct through duplicate names, renames, and view changes', () => {
  useStore.setState({ sessionProjects: projects.map((project) => ({ ...project, name: 'Shared name' })) })
  state().navigateExperience('scheduled', 'mba')
  assert.equal(state().experienceProjectId, 'mba')
  assert.ok(shown().every((id) => id.startsWith('mba-')))
  for (const view of ['overview', 'focus', 'inbox', 'outputs', 'context', 'terminals']) {
    state().navigateExperience(view, 'workbench')
    assert.equal(state().experienceProjectId, 'workbench')
    assert.ok(shown().every((id) => id.startsWith('wb-')))
  }
  useStore.setState({ sessionProjects: projects.map((project) => ({ ...project, name: 'Renamed project' })) })
  state().navigateExperience('terminals', 'mba')
  assert.equal(state().experienceProjectId, 'mba')
  assert.ok(shown().every((id) => id.startsWith('mba-')))
  state().navigateExperience('terminals', null)
  assert.equal(state().experienceProjectId, null)
  assert.equal(state().sessions, sessions)
})

test('MBA → Workbench → MBA preserves layouts and reselects the priority terminal', () => {
  const originalSessions = state().sessions
  state().navigateExperience('terminals', 'mba')
  const mbaTab = state().activeTabId
  state().split('h', 'mba-2')
  const mbaLayout = state().activeTab().layout
  state().navigateExperience('terminals', 'workbench')
  assert.deepEqual(shown(), ['wb-2'])
  assert.equal(state().experienceView, 'terminals')
  assert.ok(state().visibleTabs().every((tab) => tab.sessionProjectId === 'workbench'))
  state().revealSession('wb-1')
  state().navigateExperience('terminals', 'mba')
  assert.equal(state().activeTabId, mbaTab)
  assert.equal(state().activeTab().layout, mbaLayout)
  assert.deepEqual(shown(), ['mba-1', 'mba-2'])
  state().navigateExperience('terminals', 'workbench')
  assert.deepEqual(shown(), ['wb-2'])
  assert.equal(state().sessions, originalSessions)
})

test('project navigation finds the latest messaged terminal in its existing tab', () => {
  state().navigateExperience('terminals', 'mba')
  state().addTab('mba-2')
  useStore.setState({ sessions: sessions.map((session) => session.id === 'mba-2' ? { ...session, lastPromptAt: 50 } : session) })
  const selected = state().activeTabId
  state().navigateExperience('overview')
  assert.equal(state().activeTabId, selected)
  state().navigateExperience('overview', 'workbench')
  state().navigateExperience('terminals', 'mba')
  assert.equal(state().activeTabId, selected)
  assert.deepEqual(shown(), ['mba-2'])
})

test('empty projects and closing the final project tab never fall back to MBA', () => {
  state().navigateExperience('terminals', 'empty')
  assert.deepEqual(shown(), [])
  state().navigateExperience('terminals', 'workbench')
  state().closeTab(state().activeTabId)
  assert.deepEqual(shown(), [])
  assert.equal(state().activeTab().sessionProjectId, 'workbench')
  assert.ok(state().tabs.some((tab) => sessionIdsIn(tab.layout).includes('mba-1')))
})

test('All terminals restores its selection, and mixed-project splits stay available there', () => {
  state().split('h', 'wb-1')
  const originalTab = state().activeTabId
  const originalLayout = state().activeTab().layout
  state().navigateExperience('terminals', 'workbench')
  assert.deepEqual(shown(), ['wb-2'])
  state().navigateExperience('terminals', null)
  assert.equal(state().activeTabId, originalTab)
  assert.equal(state().activeTab().layout, originalLayout)
})

test('opening a cross-project conversation follows its owner instead of mixing panes', () => {
  state().navigateExperience('terminals', 'mba')
  state().assignSession(state().activeTab().activePaneId, 'wb-1')
  assert.equal(state().experienceProjectId, 'workbench')
  assert.deepEqual(shown(), ['wb-1'])
  state().revealSession('unfiled')
  assert.equal(state().experienceProjectId, null)
  assert.deepEqual(shown(), ['unfiled'])
})

test('refiling a session clears its previous project pane and does not retain its artifact', () => {
  state().navigateExperience('terminals', 'mba')
  state().setPaneView(state().activeTab().activePaneId, 'visual')
  state().setVisualArtifact('mba-1', '/tmp/fixture.html')
  const moved = sessions.map((session) => session.id === 'mba-1' ? { ...session, sessionProjectId: 'workbench' } : session)
  state().applyState({ ...state(), sessions: moved })
  assert.deepEqual(shown(), [])
  assert.equal(state().activeTab().layout.artifact, undefined)
  assert.equal(reconcileProjectTabs(state().tabs, moved), state().tabs, 'unchanged snapshots keep tab identity')
  state().revealSession('mba-1')
  assert.equal(state().experienceProjectId, 'workbench')
  assert.deepEqual(shown(), ['mba-1'])
})

test('project tabs persist alongside other workspaces and survive initial state hydration', () => {
  state().navigateExperience('terminals', 'mba')
  state().navigateExperience('terminals', 'workbench')
  const persisted = asTabs(JSON.parse(JSON.stringify(saves.at(-1))))
  assert.equal(persisted.tabs.length, 2)
  assert.deepEqual(persisted.tabs.map((tab) => tab.sessionProjectId), ['mba', 'workbench'])
  const snapshot = { ...state(), ...persisted }
  useStore.setState(useStore.getInitialState(), true)
  state().applyState(snapshot)
  state().navigateExperience('terminals', 'mba')
  assert.deepEqual(shown(), ['mba-1'])
})

test('first project visit skips archived conversations and prefers a live terminal', () => {
  useStore.setState({ experience: { ...state().experience, archivedIds: ['wb-2'] } })
  state().navigateExperience('terminals', 'workbench')
  assert.deepEqual(shown(), ['wb-1'])
})

test('revealing a saved split moves zoom to the requested terminal', () => {
  state().navigateExperience('terminals', 'mba')
  state().split('h', 'mba-2')
  state().toggleZoom()
  state().revealSession('mba-1')
  assert.equal(state().activeTab().zoomedPaneId, state().activeTab().activePaneId)
  assert.equal(state().activeTab().layout.children[0].id, state().activeTab().zoomedPaneId)
})

test('removing or refiling a minimized session clears only its former project chip', () => {
  state().navigateExperience('terminals', 'mba')
  state().minimizePane(state().activeTab().activePaneId)
  assert.deepEqual(state().activeTab().minimized, ['mba-1'])
  const removed = sessions.filter((session) => session.id !== 'mba-1')
  state().applyState({ ...state(), sessions: removed })
  assert.deepEqual(state().activeTab().minimized, [])
  assert.deepEqual(shown(), [])
})

test('project clicks always open Terminals, including from Overview, Outputs and the same project', () => {
  for (const view of ['overview', 'outputs', 'scheduled', 'context']) {
    state().navigateExperience(view, 'mba')
    state().openProject('workbench')
    assert.equal(state().experienceView, 'terminals')
    assert.equal(focused(), 'wb-2')
    state().navigateExperience(view)
    state().openProject('workbench')
    assert.equal(state().experienceView, 'terminals')
    assert.equal(focused(), 'wb-2')
  }
  state().openProject('empty')
  assert.equal(state().experienceView, 'terminals')
  assert.deepEqual(shown(), [])
})

test('waiting, failed and review outrank ordinary activity, pins and archived terminals', () => {
  const candidates = [
    { id: 'waiting', status: 'waiting', lastPromptAt: 1 },
    { id: 'failed', status: 'failed', alive: false, lastPromptAt: 20 },
    { id: 'review', status: 'review', lastPromptAt: 30 },
    { id: 'busy', status: 'working', lastPromptAt: 40, pinned: true },
    { id: 'other', sessionProjectId: 'mba', status: 'waiting', lastPromptAt: 100 }
  ].map((session) => ({ sessionProjectId: 'workbench', alive: true, lastActivityAt: 1000, ...session }))
  assert.equal(priorityProjectSession(candidates, 'workbench', []).id, 'waiting')
  assert.equal(priorityProjectSession(candidates, 'workbench', ['waiting']).id, 'failed')
  assert.equal(priorityProjectSession(candidates, 'workbench', ['waiting', 'failed']).id, 'review')
  assert.equal(priorityProjectSession(candidates, 'workbench', ['waiting', 'failed', 'review']).id, 'busy')
  assert.equal(priorityProjectSession(candidates, 'empty', []), undefined)
})

test('latest submitted prompt wins over streaming output and manual focus', () => {
  useStore.setState({ sessions: sessions.map((session) => ({ ...session, status: 'idle',
    ...(session.id === 'wb-1' ? { lastPromptAt: 200, lastActivityAt: 200 } : {}),
    ...(session.id === 'wb-2' ? { lastPromptAt: 100, lastActivityAt: 99999 } : {}) })) })
  state().openProject('workbench')
  assert.equal(focused(), 'wb-1')
  state().revealSession('wb-2')
  state().openProject('mba')
  state().openProject('workbench')
  assert.equal(focused(), 'wb-1')
})

test('returning to a project reevaluates urgency and focuses a zoom-hidden split atomically', () => {
  state().openProject('mba')
  state().split('h', 'mba-2')
  const layout = state().activeTab().layout
  state().toggleZoom()
  state().openProject('workbench')
  useStore.setState({ sessions: sessions.map((session) => session.id === 'mba-1' ? { ...session, status: 'waiting' } : session) })
  const frames = []
  const off = useStore.subscribe((snapshot) => frames.push({ project: snapshot.experienceProjectId, session: focused() }))
  state().openProject('mba')
  off()
  assert.deepEqual(frames, [{ project: 'mba', session: 'mba-1' }])
  assert.equal(state().activeTab().layout, layout)
  assert.equal(state().activeTab().zoomedPaneId, state().activeTab().activePaneId)
})

test('project entry restores a minimized waiting terminal and snapshots do not steal focus', () => {
  state().openProject('mba')
  state().minimizePane(state().activeTab().activePaneId)
  state().openProject('workbench')
  useStore.setState({ sessions: sessions.map((session) => session.id === 'mba-1' ? { ...session, status: 'waiting' } : session) })
  state().openProject('mba')
  assert.equal(focused(), 'mba-1')
  assert.deepEqual(state().activeTab().minimized, [])
  state().revealSession('mba-2')
  state().applyState({ ...state(), sessions: state().sessions })
  assert.equal(focused(), 'mba-2')
})
