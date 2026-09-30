import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { buildCommands, withBuildTemp } from '../scripts/build.mjs'
import { tempDir } from './helpers.mjs'

test('build children share a unique disk-staging directory and literal argv', async () => {
  const baseDir = tempDir('build-cache-')
  const output = path.join(baseDir, 'result.json')
  const literal = 'spaces ; $(should-not-run) "quotes"'
  const result = await withBuildTemp([[process.execPath, '-e', `
    require('fs').writeFileSync(process.argv[1], JSON.stringify({
      tmpdir: require('os').tmpdir(), tmp: process.env.TMP, temp: process.env.TEMP,
      marker: process.env.WORKBENCH_BUILD_TEMP, literal: process.argv[2], cwd: process.cwd()
    }))`, output, literal]], { baseDir, cwd: baseDir })
  assert.equal(result.code, 0)
  const actual = JSON.parse(await fs.readFile(output, 'utf8'))
  assert.equal(actual.tmpdir, result.directory)
  assert.equal(actual.tmp, result.directory)
  assert.equal(actual.temp, result.directory)
  assert.equal(actual.marker, result.directory)
  assert.equal(actual.literal, literal)
  // macOS exposes its temporary directory through /var while process.cwd()
  // resolves that symlink to /private/var. Compare directory identity so this
  // still catches an incorrect cwd without rejecting the platform's alias.
  assert.equal(await fs.realpath(actual.cwd), await fs.realpath(baseDir))
  await assert.rejects(fs.stat(result.directory), { code: 'ENOENT' })
})

test('a failed build retains artifacts and never runs the next step', async () => {
  const baseDir = tempDir('build-cache-failure-')
  const later = path.join(baseDir, 'must-not-exist')
  const result = await withBuildTemp([
    [process.execPath, '-e', `require('fs').writeFileSync(require('path').join(process.env.TMPDIR, 'diagnostic'), 'preserve'); process.exit(17)`],
    [process.execPath, '-e', `require('fs').writeFileSync(process.argv[1], 'wrong')`, later]
  ], { baseDir })
  assert.equal(result.code, 17)
  assert.equal(await fs.readFile(path.join(result.directory, 'diagnostic'), 'utf8'), 'preserve')
  await assert.rejects(fs.stat(later), { code: 'ENOENT' })
})

test('a successful command keeps nonempty scratch files for possible background users', async () => {
  const result = await withBuildTemp([[process.execPath, '-e',
    `require('fs').writeFileSync(require('path').join(process.env.TMPDIR, 'keep'), 'still needed')`]],
  { baseDir: tempDir('build-cache-preserve-') })
  assert.equal(await fs.readFile(path.join(result.directory, 'keep'), 'utf8'), 'still needed')
})

test('concurrent builds receive different temporary directories', async () => {
  const baseDir = tempDir('build-cache-isolated-')
  const jobs = await Promise.all([1, 2].map(() => withBuildTemp([[process.execPath, '-e', '']], { baseDir })))
  assert.notEqual(jobs[0].directory, jobs[1].directory)
})

test('missing commands fail and package flags keep their existing meaning', async () => {
  await assert.rejects(withBuildTemp([[path.join(tempDir(), 'missing-command')]], { baseDir: tempDir() }), { code: 'ENOENT' })
  const commands = buildCommands(['package', '--win', '--dir', '--x64'])
  assert.equal(commands.length, 2)
  assert.equal(commands[0][0], process.execPath)
  assert.deepEqual(commands[0].slice(2), ['build'])
  assert.deepEqual(commands[1].slice(2), ['--win', '--dir', '--x64'])
  assert.throws(() => buildCommands(['unknown']), /Expected/)
})

test('a tool exiting zero after cancellation does not continue the pipeline', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const baseDir = tempDir('build-cache-interrupt-')
  const later = path.join(baseDir, 'must-not-run')
  const worker = path.join(baseDir, 'worker.mjs')
  const script = new URL('../scripts/build.mjs', import.meta.url).href
  await fs.writeFile(worker, `import { withBuildTemp } from ${JSON.stringify(script)};
    const result = await withBuildTemp([
      [process.execPath, '-e', "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 100)"],
      [process.execPath, '-e', "require('fs').writeFileSync(process.argv[1], 'wrong')", ${JSON.stringify(later)}]
    ], { baseDir: ${JSON.stringify(baseDir)} }); process.exitCode = result.code;`)
  const child = spawn(process.execPath, [worker], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    const code = await new Promise((resolve, reject) => {
      let output = '', sent = false
      child.stdout.on('data', data => {
        output += data
        if (!sent && output.includes('ready')) { sent = true; child.kill('SIGTERM') }
      })
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.equal(code, 143)
    await assert.rejects(fs.stat(later), { code: 'ENOENT' })
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})
