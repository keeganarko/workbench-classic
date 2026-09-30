import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Experience } from '../src/main/experience.js'
import { filterOutputs, filterSessions, folderLocation, nextOccurrence, validateTask, withProjectContext } from '../src/shared/experience.js'
import { tempDir, persistedSession } from './helpers.mjs'

const input = (patch = {}) => ({ name: 'Weekly briefing', prompt: 'Write a briefing', projectId: 'project_test',
  agent: 'codex', cadence: 'weekdays', time: '09:00', weekday: 1, enabled: false, ...patch })

test('recent work distinguishes sessions that share a company role in search', () => {
  const sessions = [persistedSession({ id: 'a', title: 'Software Engineer', lastTask: 'Fixed the scheduler' }),
    persistedSession({ id: 'b', title: 'Software Engineer', lastTask: 'Added session descriptions' })]
  const filter = { projectId: null, query: 'scheduler', agent: '', status: '', archived: false }
  assert.deepEqual(filterSessions(sessions, [], filter).map((s) => s.id), ['a'])
  assert.deepEqual(filterSessions(sessions, ['a'], filter), [])
})
function harness(overrides = {}) {
  let now = new Date(2026, 8, 4, 8).getTime()
  const sessions = new Map(), calls = []
  let project = { id: 'project_test', name: 'A project', defaultCwd: '/tmp' }
  const deps = {
    directory: tempDir('workbench-experience-'), now: () => now,
    project: (id) => project?.id === id ? project : undefined, session: (id) => sessions.get(id), changed: () => {},
    launch: async (options) => { calls.push(options); const session = persistedSession({ id: `session_${calls.length}`, status: 'idle', alive: true }); sessions.set(session.id, session); return session },
    ...overrides
  }
  return { service: new Experience(deps), deps, sessions, calls, time: (value) => { now = value }, removeProject: () => { project = undefined } }
}

test('next occurrence is local wall time, strictly future, and skips weekends', () => {
  const friday = new Date(2026, 8, 4, 9).getTime()
  assert.equal(nextOccurrence(input(), friday), new Date(2026, 8, 7, 9).getTime())
  assert.equal(nextOccurrence(input({ cadence: 'daily' }), friday), new Date(2026, 8, 5, 9).getTime())
  assert.equal(nextOccurrence(input({ cadence: 'weekly', weekday: 0 }), friday), new Date(2026, 8, 6, 9).getTime())
})
test('task validation refuses shell execution, malformed clocks and oversized prompts', () => {
  assert.equal(validateTask(input()).agent, 'codex')
  for (const patch of [{ agent: 'shell' }, { time: '24:00' }, { time: '9:00' }, { weekday: 7 },
    { weekday: 1.5 }, { enabled: 'yes' }, { cadence: 'every-second' }, { prompt: '' }, { prompt: 'x'.repeat(12001) }, { id: 7 }]) {
    assert.throws(() => validateTask(input(patch)))
  }
})
test('saving and reloading preserves tasks without launching anything', () => {
  const h = harness()
  const saved = h.service.saveTask(input())
  const restored = new Experience(h.deps)
  assert.deepEqual(restored.snapshot().tasks, [saved])
  assert.equal(h.calls.length, 0)
  assert.equal(restored.snapshot().tasks[0].enabled, false)
})
test('a run uses project context, default approvals, and records launched rather than completed', async () => {
  const h = harness()
  h.service.setProjectDetails('project_test', { description: 'Purpose', instructions: 'Do not edit code.' })
  const task = h.service.saveTask(input())
  const run = await h.service.runTask(task.id)
  assert.equal(run.status, 'launched')
  assert.equal(h.calls[0].permissionMode, 'default')
  assert.equal(h.calls[0].sessionProjectId, 'project_test')
  assert.equal(h.calls[0].cwd, '/tmp')
  assert.match(h.calls[0].initialPrompt, /Do not edit code/)
  h.service.syncRuns()
  assert.equal(h.service.snapshot().runs[0].status, 'launched', 'an initial idle terminal is not a completion')
  h.sessions.get(run.sessionId).status = 'working'; h.service.syncRuns()
  assert.equal(h.service.snapshot().runs[0].status, 'working')
  h.sessions.get(run.sessionId).status = 'waiting'; h.service.syncRuns()
  assert.equal(h.service.snapshot().runs[0].status, 'waiting')
  h.sessions.get(run.sessionId).status = 'review'; h.service.syncRuns()
  assert.equal(h.service.snapshot().runs[0].status, 'review')
})
test('concurrent clicks and a later tick cannot overlap an active run', async () => {
  let release
  const h = harness({ launch: () => new Promise((resolve) => { release = resolve }) })
  const task = h.service.saveTask(input({ enabled: true }))
  const first = h.service.runTask(task.id)
  await assert.rejects(h.service.runTask(task.id), /active run/)
  await assert.rejects(async () => h.service.removeTask(task.id), /active/)
  release(persistedSession({ id: 'active', alive: true }))
  await first
  await assert.rejects(h.service.runTask(task.id), /active run/)
})
test('missed times coalesce into one run and the next time is in the future', async () => {
  const h = harness()
  h.service.saveTask(input({ enabled: true }))
  const now = new Date(2026, 8, 14, 14).getTime(); h.time(now)
  await h.service.tick(); await h.service.tick()
  assert.equal(h.calls.length, 1)
  assert.ok(h.service.snapshot().tasks[0].nextRunAt > now)
})
test('a launch failure or removed project pauses recurring work with an explanation', async () => {
  const h = harness({ launch: async () => { throw new Error('Agent unavailable') } })
  const task = h.service.saveTask(input({ enabled: true }))
  const run = await h.service.runTask(task.id)
  assert.equal(run.status, 'failed'); assert.match(run.error, /Agent unavailable/)
  assert.equal(h.service.snapshot().tasks[0].enabled, false)
  const other = harness(), saved = other.service.saveTask(input({ enabled: true }))
  other.removeProject()
  assert.match((await other.service.runTask(saved.id)).error, /Project was removed/)
  assert.equal(other.calls.length, 0)
})
test('restart reconciles an interrupted reservation without relaunching it', async (t) => {
  const h = harness(), task = h.service.saveTask(input({ enabled: true }))
  await h.service.runTask(task.id)
  h.sessions.clear()
  const reloaded = new Experience(h.deps); t.after(() => reloaded.stop()); reloaded.start()
  assert.equal(reloaded.snapshot().runs[0].status, 'interrupted')
  assert.equal(reloaded.snapshot().tasks[0].enabled, false)
  assert.equal(h.calls.length, 1)
})
test('a reservation is durable before an agent launches; failed persistence launches nothing', async () => {
  const h = harness()
  const task = h.service.saveTask(input())
  fs.unlinkSync(path.join(h.deps.directory, 'experience.json'))
  fs.mkdirSync(path.join(h.deps.directory, 'experience.json.tmp'))
  await assert.rejects(h.service.runTask(task.id), /not saved/)
  assert.equal(h.calls.length, 0)
})
test('unreadable prototype data is preserved rather than overwritten by an empty state', () => {
  const directory = tempDir('workbench-experience-corrupt-'), file = path.join(directory, 'experience.json')
  fs.writeFileSync(file, 'invalid json')
  const h = harness({ directory })
  assert.match(h.service.snapshot().error, /could not be loaded/)
  assert.throws(() => h.service.saveTask(input()), /preserved/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'invalid json')
})
test('archive changes filing only; output history retains the source and acknowledgment', () => {
  const h = harness(), s = persistedSession({ id: 'aaa', sessionProjectId: 'project_test', alive: true })
  h.sessions.set('aaa', s); h.service.archive('aaa', true)
  assert.deepEqual(h.service.snapshot().archivedIds, ['aaa']); assert.equal(s.alive, true)
  h.service.archive('aaa', false); assert.deepEqual(h.service.snapshot().archivedIds, [])
  const entry = { path: '/tmp/report.html', name: 'report.html', kind: 'html', mtimeMs: 100, size: 12 }
  h.service.recordOutput('aaa', entry); h.service.acknowledgeOutput('aaa', entry.path)
  assert.equal(h.service.snapshot().outputs[0].seen, true)
  h.service.recordOutput('aaa', { ...entry, mtimeMs: 200 })
  assert.equal(h.service.snapshot().outputs.length, 1); assert.equal(h.service.snapshot().outputs[0].seen, false)
  assert.equal(new Experience(h.deps).snapshot().outputs[0].projectId, 'project_test')
})
test('filters compose without changing the session list', () => {
  const sessions = [persistedSession({ id: 'a', agent: 'codex', title: 'Review launch', status: 'waiting', sessionProjectId: 'p' }),
    persistedSession({ id: 'b', agent: 'claude', title: 'Review launch', status: 'working', sessionProjectId: 'p' })]
  const filter = { projectId: 'p', query: 'launch', agent: 'codex', status: 'attention', archived: false }
  assert.deepEqual(filterSessions(sessions, [], filter).map((s) => s.id), ['a'])
  assert.deepEqual(filterSessions(sessions, ['a'], filter), [])
  assert.equal(filterSessions(sessions, ['a'], { ...filter, archived: true })[0].id, 'a')
  assert.equal(sessions.length, 2)
})

test('output project filters separate projects and unfiled documents while the inbox spans projects', () => {
  const outputs = [
    { path: '/mba/report.md', projectId: 'mba', seen: false },
    { path: '/mba/notes.md', projectId: 'mba', seen: true },
    { path: '/workbench/report.md', projectId: 'workbench', seen: false },
    { path: '/loose.md', projectId: null, seen: false }
  ]
  assert.deepEqual(filterOutputs(outputs, 'mba').map((output) => output.path), ['/mba/report.md', '/mba/notes.md'])
  assert.deepEqual(filterOutputs(outputs, 'workbench').map((output) => output.path), ['/workbench/report.md'])
  assert.deepEqual(filterOutputs(outputs, null).map((output) => output.path), ['/loose.md'])
  assert.deepEqual(filterOutputs(outputs, 'mba', true).map((output) => output.path), ['/mba/report.md'])
  assert.equal(filterOutputs(outputs, undefined, true).length, 3)
  assert.deepEqual(filterOutputs(outputs, 'empty'), [])
  assert.equal(outputs.length, 4)
})

test('output attribution survives moving and deleting its source terminal', () => {
  const h = harness(), session = persistedSession({ id: 'source', sessionProjectId: 'project_test' })
  h.sessions.set(session.id, session)
  h.service.recordOutput(session.id, { path: '/tmp/report.md', name: 'report.md', kind: 'markdown', mtimeMs: 100, size: 12 })
  session.sessionProjectId = 'other'
  h.sessions.delete(session.id)
  const outputs = new Experience(h.deps).snapshot().outputs
  assert.equal(filterOutputs(outputs, 'project_test')[0].sessionId, 'source')
  assert.deepEqual(filterOutputs(outputs, 'other'), [])
})
test('context does not invent work for a blank initial prompt; folder guidance separates the roots', () => {
  assert.equal(withProjectContext(undefined, { description: '', instructions: 'A rule' }), undefined)
  assert.equal(withProjectContext('A task'), 'A task')
  assert.equal(folderLocation('/home/person/dev/project').warning, true)
  assert.equal(folderLocation('/home/person/Dev/project').warning, false)
  assert.equal(folderLocation('C:\\Users\\person\\Dev').label, 'Windows files')
  assert.equal(folderLocation('\\\\wsl.localhost\\Ubuntu\\home\\person\\Dev').label, 'Ubuntu / Linux files')
})

test('Focus publication derives ownership and persists without changing live lifecycle or permissions', () => {
  const h = harness(), session = persistedSession({ id: 'reporter', alive: true,
    sessionProjectId: 'project_test', status: 'working', bus: 'read' })
  h.sessions.set(session.id, session)
  const before = structuredClone(session)
  const published = h.service.publishFocusUpdate(session.id, { kind: 'blocked', summary: 'Waiting for the integration build',
    next: 'Review it when ready', visual: { kind: 'metrics', items: [{ label: 'Checks passed', value: '12' }] } })
  assert.equal(published.sessionId, session.id)
  assert.equal(published.projectId, 'project_test')
  assert.equal(published.at, h.deps.now())
  assert.match(published.id, /^[a-f0-9-]{36}$/)
  assert.deepEqual(new Experience(h.deps).snapshot().focusUpdates, [published])
  assert.deepEqual(session, before)
  assert.deepEqual(h.service.snapshot().runs, [])
  assert.equal(h.calls.length, 0)
  published.visual.items[0].value = 'forged'
  assert.equal(h.service.snapshot().focusUpdates[0].visual.items[0].value, '12')
})

test('Focus publication rejects forged payload identity and requires a live session in an existing project', () => {
  const h = harness(), session = persistedSession({ id: 'reporter', alive: true, sessionProjectId: 'project_test' })
  h.sessions.set(session.id, session)
  const report = { kind: 'update', summary: 'Validation is underway' }
  for (const key of ['id', 'sessionId', 'session_id', 'projectId', 'project_id', 'at', 'status', 'bus']) {
    assert.throws(() => h.service.publishFocusUpdate(session.id, { ...report, [key]: 'forged' }))
  }
  assert.throws(() => h.service.publishFocusUpdate('missing', report), /no longer running/)
  session.alive = false
  assert.throws(() => h.service.publishFocusUpdate(session.id, report), /no longer running/)
  session.alive = true; session.sessionProjectId = null
  assert.throws(() => h.service.publishFocusUpdate(session.id, report), /existing Workbench project/)
  session.sessionProjectId = 'missing'
  assert.throws(() => h.service.publishFocusUpdate(session.id, report), /existing Workbench project/)
  assert.deepEqual(h.service.snapshot().focusUpdates, [])
})

test('Focus reports retain their original project on moves and prune removed sessions durably', () => {
  const projects = ['project_test', 'other'].map((id) => ({ id, name: id, defaultCwd: '/tmp' }))
  const h = harness({ project: (id) => projects.find((project) => project.id === id) })
  const session = persistedSession({ id: 'reporter', alive: true, sessionProjectId: 'project_test' })
  h.sessions.set(session.id, session)
  const report = { kind: 'update', summary: 'Working in this project' }
  h.service.publishFocusUpdate(session.id, report)
  session.sessionProjectId = 'other'
  h.service.syncRuns()
  h.service.publishFocusUpdate(session.id, report)
  assert.deepEqual(h.service.snapshot().focusUpdates.map((update) => update.projectId), ['other', 'project_test'])
  h.sessions.delete(session.id)
  h.service.syncRuns()
  assert.deepEqual(new Experience(h.deps).snapshot().focusUpdates, [])
})

test('Focus retention stays bounded across commits and old Experience data still loads', () => {
  let changes = 0
  const h = harness({ changed: () => { changes++ } }), session = persistedSession({ id: 'reporter', alive: true, sessionProjectId: 'project_test' })
  h.sessions.set(session.id, session)
  const task = h.service.saveTask(input())
  const file = path.join(h.deps.directory, 'experience.json'), old = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete old.focusUpdates
  fs.writeFileSync(file, JSON.stringify(old))
  const restored = new Experience(h.deps)
  assert.deepEqual(restored.snapshot().focusUpdates, [])
  assert.deepEqual(restored.snapshot().tasks, [task])
  for (let i = 0; i < 12; i++) restored.publishFocusUpdate(session.id, { kind: 'milestone', summary: `Milestone ${i}` })
  assert.deepEqual(new Experience(h.deps).snapshot().focusUpdates.map((report) => report.summary),
    ['Milestone 11', 'Milestone 10', 'Milestone 9', 'Milestone 8', 'Milestone 7', 'Milestone 6'])
  const before = changes
  restored.syncRuns(); restored.syncRuns()
  assert.equal(changes, before, 'lifecycle chatter without changes creates no extra persistence or reports')
  restored.removeProject('project_test')
  assert.deepEqual(new Experience(h.deps).snapshot().focusUpdates, [])
})

test('failed Focus persistence leaves the previous durable report intact and never changes the session', () => {
  const h = harness(), session = persistedSession({ id: 'reporter', alive: true, sessionProjectId: 'project_test', status: 'working' })
  h.sessions.set(session.id, session)
  const first = h.service.publishFocusUpdate(session.id, { kind: 'update', summary: 'First saved report' })
  const before = structuredClone(session)
  fs.mkdirSync(path.join(h.deps.directory, 'experience.json.tmp'))
  assert.throws(() => h.service.publishFocusUpdate(session.id, { kind: 'milestone', summary: 'Unsaved report' }), /not saved/)
  assert.deepEqual(h.service.snapshot().focusUpdates, [first])
  assert.deepEqual(new Experience(h.deps).snapshot().focusUpdates, [first])
  assert.deepEqual(session, before)
})
