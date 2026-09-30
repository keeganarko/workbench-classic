/**
 * The sidebar's file tree and project search.
 *
 * The two panels are read-only, which narrows what is worth pinning down to
 * three things: they never read outside the session's own folder, they never
 * walk into the machine-written half of a project, and the excerpt a match
 * comes back in points at the right characters. The last one is where a
 * highlight quietly lands on the wrong word.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { listDir, resolveInside, searchFiles } from '../src/main/files.js'
import { compareEntries, excerpt, treeMarks } from '../src/shared/files.js'
import { tempDir } from './helpers.mjs'

/** A small project with one of everything the sweep has an opinion about. */
function project() {
  const root = tempDir()
  fs.mkdirSync(path.join(root, 'src'))
  fs.mkdirSync(path.join(root, 'src', 'deep'))
  fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true })
  fs.mkdirSync(path.join(root, 'dist'))
  fs.writeFileSync(path.join(root, 'README.md'), '# hello\nthe needle is here\n')
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const needle = 1\nconst other = 2\n')
  fs.writeFileSync(path.join(root, 'src', 'deep', 'nested.ts'), 'NEEDLE upper\n')
  fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'needle needle\n')
  fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'needle\n')
  return root
}

describe('listDir', () => {
  test('folders come before files, and both sort naturally', () => {
    const rows = [
      { name: 'item10.ts', dir: false },
      { name: 'item2.ts', dir: false },
      { name: 'Zed', dir: true },
      { name: 'alpha', dir: true }
    ].sort(compareEntries)
    assert.deepEqual(
      rows.map((r) => r.name),
      ['alpha', 'Zed', 'item2.ts', 'item10.ts']
    )
  })

  test('lists a folder and hides the generated ones', async () => {
    const root = project()
    const names = (await listDir(root, '')).map((e) => e.name)
    assert.deepEqual(names, ['src', 'README.md'])
  })

  test('a subfolder is addressed by its relative path', async () => {
    const root = project()
    const rows = await listDir(root, 'src')
    assert.deepEqual(
      rows.map((r) => r.rel),
      ['src/deep', 'src/app.ts']
    )
    assert.equal(rows[1].path, path.join(fs.realpathSync.native(root), 'src', 'app.ts'))
  })

  test('refuses to climb out of the session folder', async () => {
    const root = project()
    await assert.rejects(() => listDir(root, '..'), /outside the session/)
    await assert.rejects(() => listDir(root, 'src/../..'), /outside the session/)
    await assert.rejects(() => listDir(root, '/etc'), /relative to the session folder/)
  })

  test('a symlink out of the folder is not a way out of it', async () => {
    const root = project()
    const outside = tempDir()
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope')
    fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')

    // Not reachable by name...
    await assert.rejects(() => resolveInside(root, 'escape'), /outside the session/)
    // ...and not listed either, since the tree drops links rather than follow them.
    const names = (await listDir(root, '')).map((e) => e.name)
    assert.ok(!names.includes('escape'), `expected no link in ${names.join(', ')}`)
  })
})

describe('searchFiles', () => {
  test('finds matches and reports where they are', async () => {
    const root = project()
    const res = await searchFiles(root, 'needle')

    const rels = res.hits.map((h) => h.rel)
    assert.deepEqual(rels, ['README.md', 'src/app.ts', 'src/deep/nested.ts'])

    const readme = res.hits[0]
    assert.equal(readme.line, 2)
    assert.equal(readme.text, 'the needle is here')
    assert.equal(readme.text.slice(readme.offset, readme.offset + 6), 'needle')
  })

  test('never reads node_modules or build output', async () => {
    const root = project()
    const res = await searchFiles(root, 'needle')
    assert.ok(
      !res.hits.some((h) => h.rel.includes('node_modules') || h.rel.startsWith('dist/')),
      'the sweep walked into a generated folder'
    )
  })

  test('case-insensitive by default, exact when asked', async () => {
    const root = project()
    const loose = await searchFiles(root, 'needle')
    assert.ok(loose.hits.some((h) => h.rel === 'src/deep/nested.ts'))

    const strict = await searchFiles(root, 'needle', { caseSensitive: true })
    assert.ok(!strict.hits.some((h) => h.rel === 'src/deep/nested.ts'))
  })

  test('binary files are skipped rather than split into nonsense', async () => {
    const root = tempDir()
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x6e, 0x00, 0x6e, 0x6f]))
    fs.writeFileSync(path.join(root, 'plain.txt'), 'no here\n')
    const res = await searchFiles(root, 'no')
    assert.deepEqual(
      res.hits.map((h) => h.rel),
      ['plain.txt']
    )
  })

  test('an empty query searches nothing at all', async () => {
    const root = project()
    const res = await searchFiles(root, '')
    assert.deepEqual(res, { hits: [], truncated: false, scanned: 0 })
  })

  test('one file cannot fill the whole result', async () => {
    const root = tempDir()
    fs.writeFileSync(path.join(root, 'noisy.txt'), 'needle\n'.repeat(500))
    const res = await searchFiles(root, 'needle')
    assert.ok(res.hits.length <= 20, `got ${res.hits.length} hits from one file`)
  })
})

describe('excerpt', () => {
  test('a short line survives intact, offset unchanged', () => {
    assert.deepEqual(excerpt('const needle = 1', 6), { text: 'const needle = 1', offset: 6 })
  })

  test('a long line is windowed around the match, not the start', () => {
    const line = 'x'.repeat(4000) + 'needle' + 'y'.repeat(4000)
    const out = excerpt(line, 4000, 100)
    assert.ok(out.text.length <= 102, `excerpt was ${out.text.length} long`)
    assert.equal(out.text.slice(out.offset, out.offset + 6), 'needle')
  })

  test('a match near the start does not get a leading ellipsis', () => {
    const out = excerpt('needle' + 'y'.repeat(400), 0, 100)
    assert.equal(out.offset, 0)
    assert.ok(out.text.startsWith('needle'))
  })

  test('the trailing carriage return of a Windows file is dropped', () => {
    assert.equal(excerpt('needle\r', 0).text, 'needle')
  })
})

describe('treeMarks', () => {
  const files = [
    { path: 'src/app.ts', staged: null, unstaged: 'modified', from: null },
    { path: 'src/deep/new.ts', staged: 'added', unstaged: null, from: null },
    { path: 'README.md', staged: 'modified', unstaged: 'deleted', from: null }
  ]

  test('marks files and every folder above them', () => {
    const marks = treeMarks('', files)
    assert.equal(marks.files.get('src/app.ts'), 'M')
    assert.equal(marks.files.get('src/deep/new.ts'), 'A')
    // The working tree is the newer fact, so it wins over the index.
    assert.equal(marks.files.get('README.md'), 'D')
    assert.deepEqual([...marks.dirs].sort(), ['src', 'src/deep'])
  })

  test('a session started below the repository root sees its own paths', () => {
    const marks = treeMarks('src', files)
    assert.deepEqual([...marks.files.keys()].sort(), ['app.ts', 'deep/new.ts'])
    assert.deepEqual([...marks.dirs], ['deep'])
  })

  test('changes above the session folder are not in its tree', () => {
    const marks = treeMarks('src/deep', files)
    assert.deepEqual([...marks.files.keys()], ['new.ts'])
    assert.equal(marks.dirs.size, 0)
  })
})
