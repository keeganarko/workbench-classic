import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inboxMessage, selectInboxSessions } from '../src/shared/inbox.js'

const session = (id, status, project = 'a', extra = {}) => ({
  id, status, sessionProjectId: project, lastStatusChangeAt: 100,
  lastMessage: null, statusReason: null, ...extra
})

test('inbox scope, badges and sections share active project ownership and archive filtering', () => {
  const entries = [session('ask', 'waiting'), session('review', 'review'), session('crash', 'failed'),
    session('working', 'working'), session('other', 'waiting', 'b'), session('archived', 'waiting'), session('unfiled', 'review', null)]
  assert.deepEqual(selectInboxSessions(entries, ['archived'], 'a').map((s) => s.id), ['ask', 'crash', 'review'])
  assert.deepEqual(selectInboxSessions(entries, ['archived'], null).map((s) => s.id), ['ask', 'other', 'crash', 'review', 'unfiled'])
  assert.deepEqual(selectInboxSessions(entries, [], 'missing'), [])
})

test('inbox prioritizes current requests and sorts each category by event time', () => {
  const entries = [session('old', 'waiting'), session('new', 'waiting', 'a', { lastStatusChangeAt: 900 }), session('review', 'review', 'a', { lastStatusChangeAt: 999 })]
  assert.deepEqual(selectInboxSessions(entries, [], 'a').map((s) => s.id), ['new', 'old', 'review'])
  assert.deepEqual(entries.map((s) => s.id), ['old', 'new', 'review'], 'selecting must not reorder the shared store')
})

test('input cards show the current request, never an old response or original task', () => {
  const entry = session('ask', 'waiting', 'a', { statusReason: 'Which project should receive the report?', lastMessage: 'An unrelated old answer', lastTask: 'Build a report' })
  assert.deepEqual(inboxMessage(entry), { label: 'Input request', text: 'Which project should receive the report?', isFallback: false })
  entry.statusReason = null
  assert.equal(inboxMessage(entry).isFallback, true)
  assert.doesNotMatch(inboxMessage(entry).text, /unrelated|Build a report/)
})

test('a captured trigger fragment discloses that the full question is missing', () => {
  for (const statusReason of ['Please confirm', 'Please choose', 'Would you like', 'Which approach']) {
    assert.equal(inboxMessage(session('ask', 'waiting', 'a', { statusReason })).isFallback, true)
  }
})

test('review shows a captured reply without claiming the requested task was completed', () => {
  assert.equal(inboxMessage(session('review', 'review', 'a', { lastMessage: 'Implemented the settings view.' })).text, 'Implemented the settings view.')
  const missing = inboxMessage(session('review', 'review', 'a', { lastTask: 'Finish the whole project' }))
  assert.equal(missing.isFallback, true)
  assert.match(missing.text, /response was not captured/)
  assert.doesNotMatch(missing.text, /Finish the whole project/)
})

test('failure details cannot be mistaken for a question', () => {
  assert.deepEqual(inboxMessage(session('crash', 'failed', 'a', { statusReason: 'Exited with code 2' })), {
    label: 'Problem reported', text: 'Exited with code 2', isFallback: false
  })
})

test('terminal controls are removed, content stays literal, and card messages are bounded', () => {
  const cleaned = inboxMessage(session('review', 'review', 'a', { lastMessage: '\u001b[31mRed\u001b[0m\n<script>example</script>\u0007' }))
  assert.equal(cleaned.text, 'Red\n<script>example</script>')
  assert.equal(inboxMessage(session('review', 'review', 'a', { lastMessage: 'a'.repeat(3000) })).text.length, 1600)
})
