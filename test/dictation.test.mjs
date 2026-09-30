/**
 * Dictation is an external text source. Preserve the user's draft and selection,
 * require real project paths, and never pick between duplicate filenames for
 * them. No test launches Flow, reads an account token, or records microphone
 * input; installation detection was also checked separately on the WSL host.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findFileReferences, replaceFileReference, insertTranscript, isReferencePath } from '../src/shared/dictation.js'
import { dictationFiles, flowPlatform } from '../src/main/dictation.js'

test('spoken names, camel case, and explicit references resolve to real project files', () => {
  const files = ['src/index.tsx', 'src/myParser.ts', 'src/cursorFormatting.ts', 'docs/writing.md']
  const result = findFileReferences('Fix index dot tsx; review tag my parser and cursor formatting dot ts; see @writing.md.', files)
  assert.deepEqual(result.map(r => r.files), [['src/index.tsx'], ['src/myParser.ts'], ['src/cursorFormatting.ts'], ['docs/writing.md']])
  assert.equal(result[3].spoken, '@writing.md')
  assert.equal(findFileReferences('unknown dot tsx', files).length, 0)
})
test('longest file phrase wins over a shorter trigger and ambiguous basenames require a choice', () => {
  const text = 'Look at index dot tsx and tag parser'
  const references = findFileReferences(text, ['src/index.tsx', 'test/index.tsx', 'src/parser.ts'])
  assert.equal(references[0].spoken, 'index dot tsx')
  assert.deepEqual(references[0].files, ['src/index.tsx', 'test/index.tsx'])
  assert.equal(replaceFileReference(text, references[0], 'test/index.tsx'), 'Look at `test/index.tsx` and tag parser')
  assert.equal(replaceFileReference(text, references[0], 'invented.tsx'), null)
})
test('an explicit full path narrows ambiguity and existing code spans remain untouched', () => {
  const files = ['src/index.tsx', 'test/index.tsx']
  const result = findFileReferences('Use src/index.tsx and keep `test/index.tsx` as written.', files)
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].files, ['src/index.tsx'])
  assert.equal(findFileReferences('preindex.tsx and index.tsxBackup', files).length, 0)
})
test('reference replacement refuses stale text ranges and invalid project paths', () => {
  const text = 'fix index.tsx'
  const reference = findFileReferences(text, ['src/index.tsx'])[0]
  assert.equal(replaceFileReference('the draft changed', reference, 'src/index.tsx'), null)
  for (const file of ['../secret.md', '/etc/passwd', 'C:\\keys.md', '.env.md', 'src/../file.md', 'src/`file`.ts']) assert.equal(isReferencePath(file), false)
  assert.equal(findFileReferences('secret dot md', ['../secret.md']).length, 0)
})
test('clipboard transcript replaces only the selected range and never submits', () => {
  const draft = 'Before OLD after'
  const result = insertTranscript(draft, draft, 7, 10, 'first line\nsecond line')
  assert.deepEqual(result, { text: 'Before first line\nsecond line after', caret: 29 })
  assert.equal(insertTranscript('typed meanwhile', draft, 7, 10, 'voice'), null)
  assert.equal(insertTranscript(draft, draft, -1, 3, 'voice'), null)
  assert.equal(insertTranscript(draft, draft, 5, 3, 'voice'), null)
  assert.equal(insertTranscript(draft, draft, 0, 0, ''), null)
  assert.equal(insertTranscript(draft, draft, 0, 0, 'x'.repeat(50001)), null)
})
test('file discovery stays in the session folder and excludes credentials, hidden paths, and links', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-dictation-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const docs = { 'src/index.tsx': 'source', 'src/myParser.ts': 'source', 'src/secret.json': 'private', '.env.md': 'hidden', 'vault/record.md': 'private', 'artifacts/demo.md': 'generated', 'node_modules/lib/index.ts': 'dependency' }
  for (const [file, content] of Object.entries(docs)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), content)
  }
  await fs.symlink(os.tmpdir(), path.join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  const listing = await dictationFiles(root)
  assert.deepEqual(listing.files, ['src/index.tsx', 'src/myParser.ts'])
  assert.equal(listing.truncated, false)
})
test('desktop support distinguishes native Windows from WSLg without mislabeling Linux', () => {
  assert.equal(flowPlatform('win32', true), 'windows')
  assert.equal(flowPlatform('darwin', false), 'mac')
  assert.equal(flowPlatform('linux', true), 'wsl')
  assert.equal(flowPlatform('linux', false), 'unsupported')
})
