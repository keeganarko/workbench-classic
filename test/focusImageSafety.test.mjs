import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tempDir } from './helpers.mjs'

test('Focus rejects named pipes without blocking the main process', { skip: process.platform === 'win32' }, () => {
  const root = tempDir('focus-image-pipe-'), file = path.join(root, 'report.svg')
  execFileSync('mkfifo', [file])
  // Exercise both a pipe already present and a regular file swapped for a pipe
  // between the pathname stat and open. A subprocess bounds a regression so
  // the test runner cannot freeze along with the application's sync reader.
  const loader = fileURLToPath(new URL('./ts-resolve.mjs', import.meta.url))
  const module = new URL('../src/main/focusImages.ts', import.meta.url).href
  for (const race of [false, true]) {
    const child = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', `
      import fs from 'node:fs'; import assert from 'node:assert/strict';
      import { snapshotFocusImage } from ${JSON.stringify(module)};
      const original = fs.statSync;
      if (${race}) fs.statSync = (...args) => args[0] === ${JSON.stringify(file)} ? { isFile: () => true } : original(...args);
      assert.throws(() => snapshotFocusImage(${JSON.stringify(root)}, 'fixture', ${JSON.stringify(root)}, ${JSON.stringify(file)}), /regular files|must be files/);
    `], { encoding: 'utf8', timeout: 5000 })
    assert.equal(child.error, undefined, `Image validation blocked: ${child.error}`)
    assert.equal(child.status, 0, child.stderr)
  }
})
