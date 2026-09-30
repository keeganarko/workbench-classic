import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openWithSystem, savePreviewCopy } from '../src/main/fileActions.js'
import { PreviewServer } from '../src/main/preview.js'
import { tempDir } from './helpers.mjs'

function fixture() {
  const root = tempDir()
  const source = path.join(root, 'portrait.png')
  // Include NUL and non-UTF8 bytes: saving the rendered preview would corrupt
  // a real image, so assert exact file bytes, not only that a target exists.
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 254, 128, 42])
  fs.writeFileSync(source, bytes)
  const preview = new PreviewServer()
  preview.open(source)
  return { root, source, bytes, readable: (file) => preview.assertReadable(file) }
}

test('Open reports OS errors that resolve instead of rejecting', async () => {
  const calls = []
  assert.equal(await openWithSystem('/a file.png', async (file) => { calls.push(file); return '' }), '/a file.png')
  assert.deepEqual(calls, ['/a file.png'])
  await assert.rejects(openWithSystem('/a file.png', async () => 'No application can open this file'), /No application/)
})

test('Save a copy preserves binary bytes and leaves the original untouched', async () => {
  const f = fixture()
  const target = path.join(tempDir(), 'download.png')
  assert.equal(await savePreviewCopy(f.source, f.readable, async () => target), target)
  assert.deepEqual(fs.readFileSync(target), f.bytes)
  assert.deepEqual(fs.readFileSync(f.source), f.bytes)
})

test('cancelling Save makes no copy and is not an error', async () => {
  const f = fixture()
  assert.equal(await savePreviewCopy(f.source, f.readable, async () => null), null)
  assert.deepEqual(fs.readdirSync(f.root), ['portrait.png'])
  assert.deepEqual(fs.readFileSync(f.source), f.bytes)
})

test('choosing the source or a hard link to it never truncates the original', async () => {
  const f = fixture()
  const alias = path.join(f.root, 'same-file.png')
  fs.linkSync(f.source, alias)
  for (const target of [f.source, alias]) {
    assert.equal(await savePreviewCopy(f.source, f.readable, async () => target), target)
    assert.deepEqual(fs.readFileSync(f.source), f.bytes)
  }
})

test('only the dialog-selected target is replaced when saving an existing copy', async () => {
  const f = fixture()
  const target = path.join(tempDir(), 'download.png')
  fs.writeFileSync(target, 'old copy')
  await savePreviewCopy(f.source, f.readable, async () => target)
  assert.deepEqual(fs.readFileSync(target), f.bytes)
  assert.deepEqual(fs.readFileSync(f.source), f.bytes)
})

test('an unapproved file or directory is refused before showing a save dialog', async () => {
  const f = fixture()
  const other = path.join(tempDir(), 'outside.png')
  fs.writeFileSync(other, 'outside')
  let dialogs = 0
  for (const source of [other, f.root]) {
    await assert.rejects(savePreviewCopy(source, f.readable, async () => { dialogs++; return null }))
  }
  assert.equal(dialogs, 0)
})

test('a file removed during the dialog cannot leave a misleading saved copy', async () => {
  const f = fixture()
  const target = path.join(tempDir(), 'download.png')
  await assert.rejects(savePreviewCopy(f.source, f.readable, async () => {
    fs.unlinkSync(f.source)
    return target
  }), /not there any more/)
  assert.equal(fs.existsSync(target), false)
})

test('rechecks the preview boundary after the native save dialog', async () => {
  const f = fixture()
  const target = path.join(tempDir(), 'download.png')
  const outside = path.join(tempDir(), 'private.png')
  fs.writeFileSync(outside, 'private')
  await assert.rejects(savePreviewCopy(f.source, f.readable, async () => {
    fs.unlinkSync(f.source)
    fs.symlinkSync(outside, f.source)
    return target
  }), /not open in the preview/)
  assert.equal(fs.existsSync(target), false)
})
