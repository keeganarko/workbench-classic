import { test } from 'node:test'
import assert from 'node:assert/strict'
import { focusSessions, focusStatus, focusOutputs, focusText, parseFocusEvents, updateFocusEvents, FOCUS_TOTAL_CAP, FOCUS_EVENT_CAP } from '../src/shared/focusJournal.js'
import { persistedSession } from './helpers.mjs'
import { activeFocusProjects, projectFocus } from '../src/shared/focusProjects.js'
const session = (id, projectId = 'p', patch = {}) => persistedSession({ id, title: 'Software Engineer', agent: 'codex',
  sessionProjectId: projectId, createdAt: 10, lastStatusChangeAt: 20, lastEventAt: 20,
  lastPromptAt: 15, alive: true, status: 'working', lastTask: 'Build the Focus view', ...patch })
const output = (sessionId, projectId, patch = {}) => ({ sessionId, projectId, path: '/work/report.md',
  name: 'Report.md', kind: 'markdown', mtimeMs: Date.now(), size: 100, seen: false, ...patch })

test('project overview retains archived authored history but excludes moved and removed authors', () => {
  const sessions = [session('active'), session('closed'), session('moved', 'other')]
  const reports = ['active', 'closed', 'moved', 'removed'].map((sessionId, i) => ({ id: sessionId, sessionId, projectId: 'p', at: 10 + i, kind: 'milestone', summary: sessionId }))
  const pulse = projectFocus('p', sessions, reports, ['closed'])
  assert.deepEqual(pulse.workers.map(s => s.id), ['active'])
  assert.deepEqual(pulse.reports.map(r => r.sessionId), ['closed', 'active'])
  assert.equal(pulse.latest.summary, 'closed')
  assert.equal(pulse.current.id, 'active')
  const archived = projectFocus('p', sessions, reports, ['active', 'closed'])
  assert.equal(archived.current, undefined)
  assert.ok(archived.lastKnown)
  assert.equal(archived.workers.length, 0)
  assert.equal(archived.latest.summary, 'closed')
  assert.equal(projectFocus('other', sessions, reports, []).reports.length, 0)
})
test('project overview bounds history, preserves source arrays and does not infer milestones from activity', () => {
  const sessions = [session('a', 'p', { lastActivityAt: 999999 }), session('b', 'p', { lastPromptAt: 30, status: 'waiting' })]
  const reports = Array.from({ length: 15 }, (_, i) => ({ id: String(i), sessionId: 'a', projectId: 'p', at: i, kind: 'update', summary: 'A report' }))
  const before = structuredClone({ sessions, reports }), pulse = projectFocus('p', sessions, reports, [])
  assert.equal(pulse.reports.length, 6); assert.equal(pulse.latest.at, 14)
  assert.equal(pulse.current.id, 'b'); assert.equal(pulse.needsAttention, 1)
  assert.deepEqual({ sessions, reports }, before)
  assert.equal(projectFocus('empty', sessions, reports, []).latest, undefined)
})

test('Focus requires a project, uses saved IDs and excludes archived or stopped sessions', () => {
  const sessions = [session('a'), session('b', 'other'), session('archived'), session('stopped', 'p', { alive: false })]
  assert.deepEqual(focusSessions(sessions, 'p', ['archived']).map(s => s.id), ['a'])
  assert.deepEqual(focusSessions(sessions, null, []), [])
  assert.equal(sessions.length, 4)
})
test('Focus projects enter and leave with live sessions, while idle and review work stays visible', () => {
  const projects = ['working', 'idle', 'review', 'waiting', 'stopped', 'archived', 'empty'].map(id => ({ id, name: 'Same name' }))
  const sessions = projects.slice(0, -1).map(project => session(project.id, project.id, {
    status: ['idle', 'review', 'waiting'].includes(project.id) ? project.id : 'working', alive: project.id !== 'stopped'
  }))
  const visible = () => activeFocusProjects(projects, sessions, ['archived']).map(p => p.id)
  assert.deepEqual(visible(), ['working', 'idle', 'review', 'waiting'])
  sessions[0].alive = false
  assert.deepEqual(visible(), ['idle', 'review', 'waiting'])
  sessions.push(session('new', 'empty'))
  assert.deepEqual(visible(), ['idle', 'review', 'waiting', 'empty'])
  assert.equal(projects.length, 7, 'hiding a project never deletes it')
})
test('card order stays stable across activity/status changes', () => {
  const before = [session('b', 'p', { createdAt: 11 }), session('a')]
  assert.deepEqual(focusSessions(before, 'p', []).map(s => s.id), ['a', 'b'])
  assert.deepEqual(focusSessions(before.map(s => ({ ...s, lastActivityAt: 999, status: 'waiting' })), 'p', []).map(s => s.id), ['a', 'b'])
})
test('app-wide Focus explicitly includes other projects and unfiled sessions while keeping archives out', () => {
  const sessions = [session('a'), session('b', 'other'), session('c', null), session('archived', 'other')]
  assert.deepEqual(focusSessions(sessions, null, ['archived'], true).map(s => s.id), ['a', 'b', 'c'])
  assert.deepEqual(focusSessions(sessions, 'p', ['archived']).map(s => s.id), ['a'])
  assert.deepEqual(sessions.map(s => s.sessionProjectId), ['p', 'other', null, 'other'])
})
test('an unfiled Focus card cannot collect the same session\'s previous project artifacts', () => {
  const files = [output('a', 'previous'), output('b', null), output('a', null, { path: '/work/unfiled.md' })]
  assert.deepEqual(focusOutputs(files, 'a', null).map(o => o.path), ['/work/unfiled.md'])
})
test('dead sessions cannot appear working or inflate needs-you counts; failures remain visible', () => {
  assert.equal(focusStatus(session('a', 'p', { alive: false })), 'exited')
  assert.equal(focusStatus(session('a', 'p', { alive: false, status: 'waiting' })), 'exited')
  assert.equal(focusStatus(session('a', 'p', { alive: false, status: 'failed' })), 'failed')
})
test('outputs require matching session and recorded project ownership after a move', () => {
  const files = [output('moved', 'old'), output('other', 'new'), output('moved', 'new', { path: '/work/new.md' })]
  assert.deepEqual(focusOutputs(files, 'moved', 'new').map(o => o.path), ['/work/new.md'])
})
test('visual output links are deduplicated, bounded and do not mutate input', () => {
  const files = Array.from({ length: 20 }, (_, i) => output('a', 'p', { path: `/work/${i}.md`, mtimeMs: 30 + i }))
  files.push(output('a', 'p', { path: '/work/19.md', mtimeMs: 99 }), output('a', 'p', { kind: 'text', mtimeMs: 100 }))
  const before = structuredClone(files), result = focusOutputs(files, 'a', 'p')
  assert.equal(result.length, 3); assert.equal(result[0].mtimeMs, 99)
  assert.equal(new Set(result.map(o => o.path)).size, 3); assert.deepEqual(files, before)
})
test('summary strips complete/incomplete command fences, shell lines and bounds long text', () => {
  assert.equal(focusText('```sh\nnpm run build\n```\nAdded project filters.'), 'Added project filters.')
  assert.equal(focusText('```sh\n' + 'x'.repeat(10000)), '')
  assert.equal(focusText('$ npm test\nFixed shared state.'), 'Fixed shared state.')
  assert.ok(focusText('Long update '.repeat(10000)).length <= 180)
  assert.equal(focusText(null), '')
})
test('hydration does not fabricate prior observed turns', () => {
  const events = []
  assert.strictEqual(updateFocusEvents(events, [], [session('a')], [output('a', 'p')]), events)
})
test('chatter preserves journal identity and never changes milestone timestamps', () => {
  const a = session('a'), review = { ...a, status: 'review', lastStatusChangeAt: 30 }
  const events = updateFocusEvents([], [a], [review], [])
  assert.equal(events.length, 1); assert.equal(events[0].label, 'Turn ready for review')
  assert.strictEqual(updateFocusEvents(events, [review], [{ ...review, lastActivityAt: 999, statusReason: 'npm build', lastMessage: 'old text' }], []), events)
  assert.equal(events[0].at, 30)
})
test('real repeated turns with identical text remain distinct, even while status stays working', () => {
  const a = session('a'), second = { ...a, lastPromptAt: 40 }, third = { ...a, lastPromptAt: 50 }
  const events = updateFocusEvents(updateFocusEvents([], [a], [second], []), [second], [third], [])
  assert.deepEqual(events.map(e => e.at), [50, 40]); assert.equal(new Set(events.map(e => e.id)).size, 2)
})
test('events keep project ownership after refiling and command reasons never become milestones', () => {
  const a = session('a', 'old'), review = { ...a, status: 'review', lastStatusChangeAt: 30, statusReason: '$ destructive command' }
  const events = updateFocusEvents([], [a], [review], [])
  const moved = { ...review, sessionProjectId: 'new' }
  const next = updateFocusEvents(events, [review], [moved], [])
  assert.equal(next[0].projectId, 'old'); assert.equal(next.filter(e => e.projectId === 'new').length, 0)
  assert.ok(!JSON.stringify(next).includes('destructive'))
})
test('documents with identical modification times retain separate identities', () => {
  const a = session('a'), at = Date.now(), files = [output('a', 'p', { mtimeMs: at }), output('a', 'p', { mtimeMs: at, path: '/work/other.md' })]
  const events = updateFocusEvents([], [a], [a], files)
  assert.equal(events.length, 2); assert.strictEqual(updateFocusEvents(events, [a], [a], files), events)
})
test('removed sessions are pruned and per-session/whole-journal bounds are enforced', () => {
  const sessions = Array.from({ length: 40 }, (_, i) => session(`s${i}`))
  const events = sessions.flatMap((s) => Array.from({ length: 12 }, (_, i) => ({ id: `${s.id}:${i}`, sessionId: s.id, projectId: 'p', kind: 'turn', at: i + 1, label: 'Turn started' })))
  const next = updateFocusEvents(events, sessions, sessions, [])
  assert.equal(next.length, FOCUS_TOTAL_CAP)
  assert.ok(sessions.every(s => next.filter(e => e.sessionId === s.id).length <= FOCUS_EVENT_CAP))
  assert.deepEqual(updateFocusEvents(next, sessions, [], []), [])
})
test('malformed/oversized persisted history degrades safely and label text is bounded', () => {
  for (const raw of ['{', '{}', 'x'.repeat(500001), '[{"kind":"__proto__"}]']) assert.deepEqual(parseFocusEvents(raw), [])
  const valid = { id: 'one', sessionId: 's', projectId: 'p', kind: 'review', at: 10, label: 'a'.repeat(1000) }
  const restored = parseFocusEvents(JSON.stringify([valid, valid, { ...valid, id: 'bad', at: -1 }]))
  assert.equal(restored.length, 1); assert.ok(restored[0].label.length <= 100)
})
test('first session after an empty initialized workspace is a real start, not hydration', () => {
  assert.equal(updateFocusEvents([], [], [session('first')], [], true)[0].kind, 'started')
})
test('finite dates beyond the JavaScript date range are rejected', () => {
  assert.deepEqual(parseFocusEvents(JSON.stringify([{id:'bad',sessionId:'s',projectId:'p',kind:'review',at:1e100,label:'Oops'}])), [])
})
