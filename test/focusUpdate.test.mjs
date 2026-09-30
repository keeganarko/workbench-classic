import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boundFocusUpdates, parseFocusUpdates, validateFocusUpdateInput,
  FOCUS_UPDATE_LIMIT, FOCUS_UPDATES_PER_SESSION } from '../src/shared/focusUpdate.js'

const input = (patch = {}) => ({ kind: 'milestone', summary: 'Backend validation passed',
  next: 'Review the integration', visual: { kind: 'steps', items: [
    { label: 'Validate', state: 'done' }, { label: 'Review', state: 'active' },
    { label: 'Package', state: 'pending' }
  ] }, ...patch })
const saved = (patch = {}) => ({ ...input(), id: 'report_1', sessionId: 'session_a', projectId: 'project_a', at: 123, ...patch })

test('Focus reports accept bounded steps or string metrics without retaining input references', () => {
  const raw = input({ summary: '  Backend validation passed  ' }), parsed = validateFocusUpdateInput(raw)
  assert.equal(parsed.summary, 'Backend validation passed')
  raw.visual.items[0].label = 'changed'
  assert.equal(parsed.visual.items[0].label, 'Validate')
  assert.deepEqual(validateFocusUpdateInput({ kind: 'update', summary: 'x'.repeat(180), next: 'n'.repeat(140),
    visual: { kind: 'metrics', items: [{ label: 'l'.repeat(48), value: 'v'.repeat(32) }] } }).visual.kind, 'metrics')
  assert.deepEqual(validateFocusUpdateInput({ kind: 'decision', summary: 'Keep the existing interface' }),
    { kind: 'decision', summary: 'Keep the existing interface' })
})

test('Focus input refuses supplied ownership, authority, unknown and malformed nested fields', () => {
  const invalid = [null, [], 'text', { ...input(), kind: 'success' },
    ...['id', 'sessionId', 'session_id', 'projectId', 'project_id', 'at', 'bus', 'status', 'source'].map((key) => input({ [key]: 'forged' })),
    input({ next: undefined }), input({ visual: undefined }), input({ visual: null }),
    input({ visual: { kind: 'steps', items: [] } }),
    input({ visual: { kind: 'steps', items: Array(5).fill({ label: 'Step', state: 'done' }) } }),
    input({ visual: { kind: 'steps', items: new Array(2) } }),
    input({ visual: { kind: 'steps', items: [{ label: 'Step', state: 'complete' }] } }),
    input({ visual: { kind: 'steps', items: [null] } }),
    input({ visual: { kind: 'steps', items: [{ label: 'Step', state: 'done', url: '/embed' }] } }),
    input({ visual: { kind: 'metrics', items: [{ label: 'Passed', value: 12 }] } }),
    input({ visual: { kind: 'metrics', items: [{ label: 'Passed', value: { text: '12' } }] } }),
    input({ visual: { kind: 'html', items: [{ label: 'Step', state: 'done' }] } }),
    input({ visual: { kind: 'steps', items: [{ label: 'Step', state: 'done' }], html: '<svg/>' } }),
    Object.assign(Object.create({ hidden: 'unexpected' }), input()),
    JSON.parse('{"kind":"update","summary":"A report","__proto__":{"polluted":true}}')]
  for (const value of invalid) assert.throws(() => validateFocusUpdateInput(value), JSON.stringify(value))
  assert.equal({}.polluted, undefined)
})

test('Focus text bounds reject markup, executable links, controls and oversize in every text field', () => {
  const unsafe = ['', ' ', '<svg onload="alert(1)">', 'See https://example.com', 'javascript:alert(1)',
    'data:image/svg+xml,test', 'www.example.com', '//example.com', '[report](file:///tmp/report.html)', 'First\nSecond', '\u001b[31mred']
  for (const text of unsafe) {
    for (const raw of [input({ summary: text }), input({ next: text }),
      input({ visual: { kind: 'steps', items: [{ label: text, state: 'done' }] } }),
      input({ visual: { kind: 'metrics', items: [{ label: 'Value', value: text }] } })]) {
      assert.throws(() => validateFocusUpdateInput(raw), JSON.stringify(raw))
    }
  }
  for (const raw of [input({ summary: 'x'.repeat(181) }), input({ next: 'x'.repeat(141) }),
    input({ visual: { kind: 'steps', items: [{ label: 'x'.repeat(49), state: 'done' }] } }),
    input({ visual: { kind: 'metrics', items: [{ label: 'Value', value: 'x'.repeat(33) }] } })]) {
    assert.throws(() => validateFocusUpdateInput(raw))
  }
})

test('Focus reload is backward compatible and drops malformed records without accepting hidden authority', () => {
  assert.deepEqual(parseFocusUpdates(undefined), [])
  assert.deepEqual(parseFocusUpdates({}), [])
  assert.deepEqual(parseFocusUpdates([saved(), saved({ id: 'report_2', at: -1 }), saved({ id: 'report_3', at: 1.5 }),
    saved({ id: 'report_4', projectId: '' }), saved({ id: 'report_5', bus: 'manager' }),
    saved({ id: 'report_6', summary: '<iframe/>' }), saved({ id: 'report_7', sessionId: {} }),
    saved({ id: 'report_8', at: 8.64e15 + 1 }), saved({ id: 'report_9', at: Infinity })]), [saved()])
  assert.equal(parseFocusUpdates([saved({ at: 8.64e15 })])[0].at, 8.64e15)
})

test('Focus history keeps six reports per session and 240 total, deduplicates IDs and bounds reload work', () => {
  const same = Array.from({ length: 20 }, (_, i) => saved({ id: `same_${i}` }))
  assert.equal(boundFocusUpdates(same).length, FOCUS_UPDATES_PER_SESSION)
  assert.deepEqual(boundFocusUpdates([same[0], same[0]]), [same[0]])
  const many = Array.from({ length: 300 }, (_, i) => saved({ id: `many_${i}`, sessionId: `session_${i}` }))
  assert.equal(boundFocusUpdates(many).length, FOCUS_UPDATE_LIMIT)
  assert.equal(parseFocusUpdates(many).length, FOCUS_UPDATE_LIMIT)
  assert.deepEqual(boundFocusUpdates(many, (report) => report.sessionId === 'session_20'), [many[20]])
  assert.equal(parseFocusUpdates([...Array(240).fill(null), saved()]).length, 0)
})
