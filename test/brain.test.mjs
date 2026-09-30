import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readBrainContext } from '../scripts/brain.mjs'

function fixture(t, names = ['Exports/preferences.md']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-reader-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'Exports'))
  fs.writeFileSync(path.join(root, 'brain.manifest.json'), JSON.stringify({ version: 1, context: { workbench: names } }))
  fs.writeFileSync(path.join(root, 'Exports/preferences.md'), 'Visual first.\n')
  fs.writeFileSync(path.join(root, 'private.md'), 'Do not expose this private fixture.')
  return root
}

test('brain exports only selected notes, never nearby private context', t => {
  const root = fixture(t)
  const result = readBrainContext(root, 'workbench')
  assert.match(result, /Visual first/)
  assert.doesNotMatch(result, /private fixture/)
  assert.throws(() => readBrainContext(root, 'other'), /No approved/)
})

test('brain refuses traversal and root-private notes in a manifest', t => {
  for (const name of ['../private.md', 'private.md', 'Exports/../private.md', 'Exports/sub/note.md']) {
    assert.throws(() => readBrainContext(fixture(t, [name]), 'workbench'), /directly in Exports/)
  }
})

test('brain refuses symlinks from exports into private notes', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t, ['Exports/link.md'])
  fs.symlinkSync(path.join(root, 'private.md'), path.join(root, 'Exports/link.md'))
  assert.throws(() => readBrainContext(root, 'workbench'), /outside Exports/)
})

test('brain caps individual and combined context before returning text', t => {
  const root = fixture(t, ['Exports/preferences.md', 'Exports/extra.md'])
  fs.writeFileSync(path.join(root, 'Exports/preferences.md'), 'a'.repeat(9000))
  fs.writeFileSync(path.join(root, 'Exports/extra.md'), 'b'.repeat(9000))
  assert.throws(() => readBrainContext(root, 'workbench'), /Combined context/)
  fs.writeFileSync(path.join(root, 'Exports/extra.md'), 'b'.repeat(16001))
  assert.throws(() => readBrainContext(root, 'workbench'), /small regular file/)
})
