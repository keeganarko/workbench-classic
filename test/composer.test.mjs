import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composerMention, resolveRecipients } from '../src/shared/composer.js'

const sessions = [
  { id: 'a', title: 'Writer', agent: 'codex', alive: true, sessionProjectId: 'one', cwd: '/same' },
  { id: 'b', title: 'Reviewer', agent: 'claude', alive: true, sessionProjectId: 'one', cwd: '/other' },
  { id: 'c', title: 'Reviewer', agent: 'codex', alive: true, sessionProjectId: 'two', cwd: '/same' },
  { id: 'd', title: 'Shell', agent: 'shell', alive: true, sessionProjectId: 'one' },
  { id: 'e', title: 'Exited', agent: 'codex', alive: false, sessionProjectId: 'one' },
  { id: 'f', title: 'Custom', agent: 'custom-agent', alive: true, sessionProjectId: null }
]
const ids = (scope, focused, project, targets = {}) => resolveRecipients(sessions, scope, focused, project, targets).map(s => s.id)
test('project scope follows Workbench membership across repositories and panes', () => {
  assert.deepEqual(ids('project', 'c', 'one'), ['a', 'b'])
  assert.deepEqual(ids('project', 'a', 'two'), ['c'])
  assert.deepEqual(ids('project', 'a', null), [])
})
test('broadcast skips shells and dead sessions, honors toggles, and includes running custom agents', () => {
  assert.deepEqual(ids('all', 'a', null), ['a', 'b', 'c', 'f'])
  assert.deepEqual(ids('project', 'a', 'one', { codex: false }), ['b'])
})
test('an explicit pane wins over agent toggles but never targets a dead pane', () => {
  assert.deepEqual(ids('pane', 'a', 'two', { codex: false }), ['a'])
  assert.deepEqual(ids('pane', 'd', 'one'), ['d'])
  assert.deepEqual(ids('pane', 'e', 'one'), [])
  assert.deepEqual(ids('pane', null, 'one'), [])
})
test('ambiguous or multiple resolved mentions fail closed for button and Enter', () => {
  assert.match(composerMention('@reviewer check this', sessions).error, /more than one/)
  assert.match(composerMention('@a @b check this', sessions).error, /several sessions/)
})
test('unique session IDs disambiguate titles and repeated addresses send only once', () => {
  assert.equal(composerMention('@b check this', sessions).target.id, 'b')
  assert.equal(composerMention('@writer please @writer check this', sessions).target.id, 'a')
  assert.equal(composerMention('@writer please @writer check this', sessions).error, null)
})
test('an exited mention cannot be sent and unrelated package tokens remain text', () => {
  assert.match(composerMention('@exited hello', sessions).error, /has exited/)
  assert.deepEqual(composerMention('Install @types/node', sessions), { target: null, error: null })
})
