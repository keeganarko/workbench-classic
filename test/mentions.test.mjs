import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  slugify,
  findMentionAt,
  rankMentions,
  resolveMention,
  extractMentions
} from '../src/shared/mentions.ts'

const S = (id, title, agent = 'claude', alive = true) => ({ id, title, agent, alive })

const ROSTER = [
  S('a1b2c3d4', 'Reviewer'),
  S('e5f6a7b8', 'Review pass 2', 'codex'),
  S('c9d0e1f2', 'Builder', 'codex'),
  S('99887766', 'Old reviewer', 'claude', false)
]

test('slugify makes titles typeable', () => {
  assert.equal(slugify('Review pass 2'), 'review-pass-2')
  assert.equal(slugify('  Spaced  Out  '), 'spaced-out')
  assert.equal(slugify('C++ / Rust!'), 'c-rust')
  assert.equal(slugify('!!!'), '')
})

test('findMentionAt only fires at a word start', () => {
  assert.deepEqual(findMentionAt('@rev', 4), { start: 0, end: 4, query: 'rev' })
  assert.deepEqual(findMentionAt('hi @rev', 7), { start: 3, end: 7, query: 'rev' })
  // An email is not a mention, which is the whole reason for the word-start rule.
  assert.equal(findMentionAt('me@example.com', 14), null)
  assert.equal(findMentionAt('no mention here', 8), null)
})

test('findMentionAt tracks the caret, not the end of the text', () => {
  const text = '@reviewer and more'
  assert.deepEqual(findMentionAt(text, 4), { start: 0, end: 4, query: 'rev' })
  // Caret past the token: the mention is complete and no longer being typed.
  assert.equal(findMentionAt(text, 12), null)
})

test('an empty query lists everyone, live sessions first', () => {
  const out = rankMentions('', ROSTER)
  assert.equal(out.length, 4)
  assert.equal(out.at(-1).title, 'Old reviewer', 'dead sessions sort last')
})

test('exact slug beats prefix beats substring', () => {
  const out = rankMentions('reviewer', ROSTER)
  assert.equal(out[0].title, 'Reviewer')
})

test('a word-boundary hit outranks one buried mid-word', () => {
  const roster = [S('x', 'alpha-pass'), S('y', 'passenger')]
  const out = rankMentions('pass', roster)
  assert.equal(out[0].title, 'passenger', 'prefix wins outright')
  const only = rankMentions('-pass', roster)
  assert.equal(only[0].title, 'alpha-pass')
})

test('agent kind is a usable mention', () => {
  const out = rankMentions('codex', ROSTER)
  assert.ok(out.some((s) => s.title === 'Builder'))
})

test('resolveMention picks the exact match over near ones', () => {
  const hit = resolveMention('reviewer', ROSTER)
  assert.equal(hit.target?.title, 'Reviewer')
  assert.equal(hit.reason, null)
})

test('resolveMention refuses to guess between equals', () => {
  const twins = [S('x', 'Reviewer'), S('y', 'reviewer')]
  const hit = resolveMention('reviewer', twins)
  assert.equal(hit.target, null)
  assert.equal(hit.reason, 'ambiguous')
  assert.equal(hit.candidates.length, 2)
})

test('an unknown name resolves to nothing, not to the closest thing', () => {
  const hit = resolveMention('zzz', ROSTER)
  assert.equal(hit.target, null)
  assert.equal(hit.reason, 'unknown')
})

test('a dead session is reachable only when nothing live matches', () => {
  const hit = resolveMention('old-reviewer', ROSTER)
  assert.equal(hit.target?.title, 'Old reviewer')
})

test('a unique id prefix resolves', () => {
  const hit = resolveMention('c9d0', ROSTER)
  assert.equal(hit.target?.title, 'Builder')
})

test('extractMentions finds every token with its span', () => {
  const out = extractMentions('ask @rev and @builder please')
  assert.deepEqual(
    out.map((m) => m.token),
    ['rev', 'builder']
  )
  assert.equal(out[0].start, 4)
})

test('extractMentions ignores an @ inside a word', () => {
  assert.deepEqual(extractMentions('mail me@example.com now'), [])
})
