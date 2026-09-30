import { test } from 'node:test'
import assert from 'node:assert/strict'
import { focusArtwork } from '../src/shared/focusArtwork.ts'

test('Focus art uses the current task before the session role', () => {
  assert.equal(focusArtwork({ id: 'one', title: 'Financial Analyst', task: 'Fix the clipped icon and Focus layout' }).kind, 'design')
  assert.equal(focusArtwork({ id: 'two', title: 'Software Engineer', task: 'Reconcile card spending' }).kind, 'finance')
  assert.equal(focusArtwork({ id: 'three', title: 'Content Writer', task: 'Plan work', summary: 'Packaged the release' }).kind, 'shipping')
})

test('different tasks have different shapes even in the same lifecycle', () => {
  const tasks = ['Reconcile spending', 'Design the interface', 'Research evidence', 'Write the essay', 'Review security', 'Package the release', 'Build the brain', 'Coordinate milestones', 'Implement backend']
  assert.equal(new Set(tasks.map(task => focusArtwork({ id: 'same', title: 'Agent', task }).kind)).size, tasks.length)
})

test('unknown work stays neutral and notification envelopes do not become a topic', () => {
  assert.equal(focusArtwork({ id: 'a', title: 'Agent', task: '<task-notification><task-id>security-review</task-id></task-notification>' }).kind, 'desk')
  assert.equal(focusArtwork({ id: 'b', title: 'Agent' }).kind, 'desk')
})

test('composition is stable per terminal and varies within a discipline', () => {
  const input = { id: 'terminal-a', title: 'Engineer', task: 'Build API' }
  assert.deepEqual(focusArtwork(input), focusArtwork(input))
  assert.equal(new Set(['a', 'b', 'c'].map(id => focusArtwork({ ...input, id }).variant)).size, 3)
})
