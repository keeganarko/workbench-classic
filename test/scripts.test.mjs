import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from './helpers.mjs'
import { readScripts } from '../src/main/scripts.js'

/** A project directory holding exactly this `package.json` text. */
function project(text) {
  const dir = tempDir('scripts-')
  fs.writeFileSync(path.join(dir, 'package.json'), text)
  return dir
}

describe('reading a project’s scripts', () => {
  test('returns name and command for each one', () => {
    const dir = project(JSON.stringify({ scripts: { build: 'tsc', test: 'node --test' } }))
    assert.deepEqual(readScripts(dir), [
      { name: 'build', command: 'tsc' },
      { name: 'test', command: 'node --test' }
    ])
  })

  test('the ones you actually reach for come first', () => {
    const dir = project(
      JSON.stringify({
        scripts: { 'build:analyze': 'x', zzz: 'x', dev: 'vite', start: 'node .', apple: 'x' }
      })
    )
    // `dev` and `start` lead; everything else falls back to alphabetical, so
    // the order is stable rather than whatever the file happened to say.
    assert.deepEqual(
      readScripts(dir).map((s) => s.name),
      ['dev', 'start', 'apple', 'build:analyze', 'zzz']
    )
  })

  test('non-string commands are skipped, not rendered as objects', () => {
    const dir = project(JSON.stringify({ scripts: { ok: 'echo', bad: { nested: true }, n: 3 } }))
    assert.deepEqual(readScripts(dir), [{ name: 'ok', command: 'echo' }])
  })

  test('a very long command is cut rather than sent whole', () => {
    const dir = project(JSON.stringify({ scripts: { long: 'x'.repeat(5000) } }))
    assert.equal(readScripts(dir)[0].command.length, 400)
  })

  test('a project with no scripts field answers with nothing', () => {
    assert.deepEqual(readScripts(project(JSON.stringify({ name: 'x' }))), [])
    assert.deepEqual(readScripts(project(JSON.stringify({ scripts: null }))), [])
  })

  test('a package.json caught mid-edit is empty, not a throw', () => {
    assert.deepEqual(readScripts(project('{ "scripts": { "dev": ')), [])
  })

  test('a directory with no package.json at all is empty, not a throw', () => {
    assert.deepEqual(readScripts(tempDir('scripts-')), [])
    assert.deepEqual(readScripts('/nope/does/not/exist'), [])
  })
})
