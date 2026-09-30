import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { canReplaceMacApplication, prepareMacUpdate, macInstallScript } from '../src/main/updateMac.js'

const exec = promisify(execFile)
// Shell handoff tests run on macOS and Linux; Windows has no /bin/sh.
const macTest = (name, run) => test(name, { skip: process.platform === 'win32' }, run)
const version = '1.0.3-beta.1', previousVersion = '1.0.2-beta.1'
const image = Buffer.from('verified disk image fixture')
const metadata = (v = version) => ({ CFBundleIdentifier: 'com.keeganarko.workbench', CFBundleExecutable: 'Workbench', CFBundleShortVersionString: v })
async function makeBundle(bundle, v = version) {
  await fs.mkdir(path.join(bundle, 'Contents/MacOS'), { recursive: true })
  await fs.writeFile(path.join(bundle, 'Contents/Info.plist'), JSON.stringify(metadata(v)))
  await fs.writeFile(path.join(bundle, 'Contents/MacOS/Workbench'), 'application executable')
}
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-mac-update-')))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const home = path.join(directory, "User's home"), destination = path.join(home, 'Applications/Workbench.app')
  await makeBundle(destination, previousVersion)
  const executable = path.join(destination, 'Contents/MacOS/Workbench'), file = path.join(directory, 'download.dmg')
  await fs.writeFile(file, image)
  const asset = { platform: 'darwin', arch: 'arm64', url: `https://github.com/keeganarko/workbench-classic/releases/download/v${version}/Workbench.dmg`,
    size: image.length, sha512: crypto.createHash('sha512').update(image).digest('hex'), signer: null }
  const calls = [], controls = { mutateSource: async () => {}, signature: 'Signature=adhoc\nTeamIdentifier=not set\n', architecture: 'arm64' }
  const run = async (tool, args) => {
    calls.push({ tool, args })
    if (tool.endsWith('/hdiutil') && args[0] === 'attach') {
      const source = path.join(args[args.indexOf('-mountpoint') + 1], 'Workbench.app')
      await makeBundle(source); await controls.mutateSource(source)
    } else if (tool.endsWith('/ditto')) await fs.cp(args.at(-2), args.at(-1), { recursive: true, verbatimSymlinks: true })
    else if (tool.endsWith('/plutil')) return { stdout: JSON.parse(await fs.readFile(args.at(-1), 'utf8'))[args[1]], stderr: '' }
    else if (tool.endsWith('/codesign')) {
      if (args[0] === '--verify' && await fs.access(path.join(args.at(-1), 'bad-signature')).then(() => true, () => false)) throw new Error('code signature invalid')
      return { stdout: '', stderr: controls.signature }
    } else if (tool.endsWith('/lipo')) return { stdout: controls.architecture, stderr: '' }
    else if (tool.endsWith('/ps')) return { stdout: 'Sat Sep 5 10:00:00 2026\n', stderr: '' }
    return { stdout: '', stderr: '' }
  }
  return { directory, home, destination, executable, file, asset, calls, controls, options: { file, asset, executable, pid: process.pid, logDirectory: directory }, dependencies: { run, homeDirectory: home } }
}

macTest('Mac preparation stages a verified bundle, preserves extended attributes, and detaches before handoff', async (t) => {
  const f = await fixture(t)
  assert.equal(await canReplaceMacApplication(f.executable, f.home), true)
  const prepared = await prepareMacUpdate(f.options, f.dependencies)
  const [folder] = (await fs.readdir(path.dirname(f.destination))).filter((name) => name.startsWith('.workbench-update-'))
  const work = path.join(path.dirname(f.destination), folder)
  const staged = JSON.parse(await fs.readFile(path.join(work, 'Workbench.app/Contents/Info.plist'), 'utf8'))
  assert.equal(staged.CFBundleShortVersionString, version)
  assert.equal((await fs.stat(work)).mode & 0o777, 0o700)
  assert.ok(f.calls.find(({ tool, args }) => tool.endsWith('/ditto') && args.includes('--extattr')))
  assert.deepEqual(f.calls.filter(({ tool }) => tool.endsWith('/hdiutil')).map(({ args }) => args[0]), ['attach', 'detach'])
  await exec('/bin/sh', ['-n', path.join(work, 'install.sh')])
  await prepared.cleanup()
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['Workbench.app'])
})

macTest('Mac preparation rejects a changed download before mounting or executing any bundle', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.file, Buffer.alloc(image.length))
  await assert.rejects(() => prepareMacUpdate(f.options, f.dependencies), /verification/)
  assert.deepEqual(f.calls, [])
})

macTest('Mac destination capability rejects mounted, unexpected, and linked application paths', async (t) => {
  const f = await fixture(t)
  assert.equal(await canReplaceMacApplication('/Volumes/Workbench/Workbench.app/Contents/MacOS/Workbench', f.home), false)
  assert.equal(await canReplaceMacApplication(path.join(f.directory, 'Workbench.app/Contents/MacOS/Workbench'), f.home), false)
  await fs.rename(f.destination, path.join(f.home, 'Moved.app'))
  await fs.symlink(path.join(f.home, 'Moved.app'), f.destination)
  assert.equal(await canReplaceMacApplication(f.executable, f.home), false)
  await assert.rejects(() => prepareMacUpdate(f.options, f.dependencies), /symbolic links/)
  assert.deepEqual(f.calls, [])
})

macTest('Mac preparation refuses wrong bundle identity, release version, processor, and damaged signatures', async (t) => {
  for (const [key, value, message] of [
    ['CFBundleIdentifier', 'com.other.app', /not Workbench/],
    ['CFBundleExecutable', 'Other', /not Workbench/],
    ['CFBundleShortVersionString', previousVersion, /version or publisher/],
    ['signature', null, /signature invalid/],
    ['processor', 'x86_64', /Mac processor/]
  ]) {
    const f = await fixture(t)
    f.controls.mutateSource = async (source) => {
      if (key === 'signature') await fs.writeFile(path.join(source, 'bad-signature'), '')
      else if (key === 'processor') f.controls.architecture = value
      else await fs.writeFile(path.join(source, 'Contents/Info.plist'), JSON.stringify({ ...metadata(), [key]: value }))
    }
    await assert.rejects(() => prepareMacUpdate(f.options, f.dependencies), message)
    assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['Workbench.app'])
    assert.equal(f.calls.filter(({ tool, args }) => tool.endsWith('/hdiutil') && args[0] === 'detach').length, 1)
  }
})

macTest('Mac preparation rejects a linked source bundle or linked bundle metadata', async (t) => {
  for (const relative of ['', 'Contents/Info.plist', 'Contents/MacOS/Workbench']) {
    const f = await fixture(t)
    f.controls.mutateSource = async (source) => {
      const target = relative ? path.join(source, relative) : source
      const outside = path.join(f.directory, 'outside')
      await fs.rename(target, outside); await fs.symlink(outside, target)
    }
    await assert.rejects(() => prepareMacUpdate(f.options, f.dependencies), /regular|symbolic link/)
    assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['Workbench.app'])
  }
})

macTest('Mac preparation never downgrades a Developer ID installation to ad-hoc signing', async (t) => {
  const f = await fixture(t)
  f.controls.signature = 'Authority=Developer ID Application: Example\nTeamIdentifier=ABCDE12345\n'
  await assert.rejects(() => prepareMacUpdate(f.options, f.dependencies), /publisher does not match/)
  assert.equal(f.calls.some(({ tool }) => tool.endsWith('/hdiutil')), false)
})

async function helperFixture(t, { failure = '', pid = 2147483647, processStart = 'absent' } = {}) {
  const f = await fixture(t), work = path.join(path.dirname(f.destination), '.workbench-update-fixture')
  await fs.mkdir(work, { mode: 0o700 })
  const staged = path.join(work, 'Workbench.app')
  await makeBundle(staged)
  const tools = path.join(f.directory, 'tools'), launches = path.join(f.directory, 'launches.jsonl')
  await fs.mkdir(tools)
  // These executable fakes exercise the actual shell replacement and rollback
  // control flow on Linux too. Filesystem renames and symlink checks are real;
  // only macOS signature/metadata/launch tools use fixture implementations.
  const implementation = `#!${process.execPath}
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const tool = path.basename(process.argv[1]), args = process.argv.slice(2)
const failure = ${JSON.stringify(failure)}, destination = ${JSON.stringify(f.destination)}, work = ${JSON.stringify(work)}
if (tool === 'stat') { const s = fs.lstatSync(args.at(-1)); console.log(s.dev + ':' + s.ino) }
else if (tool === 'plutil') console.log(JSON.parse(fs.readFileSync(args.at(-1), 'utf8'))[args[1]])
else if (tool === 'codesign') {
  if (args[0] === '--verify') {
    if (fs.existsSync(path.join(args.at(-1), 'bad-signature')) || (failure === 'installed-signature' && args.at(-1) === destination)) process.exit(1)
  } else console.error('Signature=adhoc\\nTeamIdentifier=not set')
} else if (tool === 'open') {
  const v = JSON.parse(fs.readFileSync(path.join(args.at(-1), 'Contents/Info.plist'), 'utf8')).CFBundleShortVersionString
  fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ path: args.at(-1), version: v }) + '\\n')
  if (failure === 'launch' && v === ${JSON.stringify(version)}) { console.error('Launch Services refused update'); process.exit(1) }
} else if (tool === 'mv') {
  if (failure === 'replace' && args[0] === path.join(work, 'Workbench.app')) { console.error('Replacement move failed'); process.exit(1) }
  const result = spawnSync('/bin/mv', args, { stdio: 'inherit' }); process.exit(result.status ?? 1)
} else if (tool === 'ps') console.log(${JSON.stringify(processStart)})
else if (tool === 'sleep') { /* immediate timeout tests */ }
`
  const commands = {}
  for (const name of ['stat', 'plutil', 'codesign', 'open', 'mv', 'ps', 'sleep']) {
    const file = path.join(tools, name)
    await fs.writeFile(file, implementation, { mode: 0o700 })
    commands[name] = file
  }
  const d = await fs.stat(f.destination), s = await fs.stat(staged)
  const config = { destination: f.destination, work, pid, processStart, version, signer: null,
    destinationIdentity: `${d.dev}:${d.ino}`, stagedIdentity: `${s.dev}:${s.ino}`, log: path.join(f.directory, 'install-error.log') }
  const script = path.join(work, 'install.sh')
  await fs.writeFile(script, macInstallScript(config, commands), { mode: 0o700 })
  return { ...f, work, staged, script, config, launches, commands,
    run: () => exec('/bin/sh', [script]),
    installedVersion: async () => JSON.parse(await fs.readFile(path.join(f.destination, 'Contents/Info.plist'), 'utf8')).CFBundleShortVersionString,
    launchedVersions: async () => (await fs.readFile(launches, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).version) }
}

macTest('Mac helper replaces the app by rename and relaunches the full new bundle', async (t) => {
  const f = await helperFixture(t)
  await f.run()
  assert.equal(await f.installedVersion(), version)
  assert.deepEqual(await f.launchedVersions(), [version])
  await assert.rejects(() => fs.access(f.work), { code: 'ENOENT' })
  await assert.rejects(() => fs.access(f.config.log), { code: 'ENOENT' })
})

macTest('Mac helper restores and relaunches the previous app if replacement, verification, or launch fails', async (t) => {
  for (const failure of ['replace', 'installed-signature', 'launch']) {
    const f = await helperFixture(t, { failure })
    await assert.rejects(f.run)
    assert.equal(await f.installedVersion(), previousVersion)
    assert.equal((await f.launchedVersions()).at(-1), previousVersion)
    assert.match(await fs.readFile(f.config.log, 'utf8'), /Workbench update failed \(step:/)
  }
})

macTest('Mac helper rejects tampering and preserves the installed bundle without replacing it', async (t) => {
  for (const mutate of [
    async (f) => fs.writeFile(path.join(f.staged, 'bad-signature'), ''),
    async (f) => { await fs.rename(f.staged, path.join(f.directory, 'redirected')); await fs.symlink(path.join(f.directory, 'redirected'), f.staged) },
    async (f) => { await fs.rename(f.destination, path.join(f.directory, 'previous-original')); await makeBundle(f.destination, previousVersion) }
  ]) {
    const f = await helperFixture(t)
    await mutate(f)
    await assert.rejects(f.run)
    assert.equal(await f.installedVersion(), previousVersion)
    await assert.rejects(() => fs.access(path.join(f.work, 'previous.app')), { code: 'ENOENT' })
  }
})

macTest('Mac helper times out without replacing or reopening an app that has not finished closing', async (t) => {
  const f = await helperFixture(t, { pid: process.pid, processStart: 'still running' })
  await assert.rejects(f.run)
  assert.equal(await f.installedVersion(), previousVersion)
  await assert.rejects(() => fs.access(f.launches), { code: 'ENOENT' })
  assert.match(await fs.readFile(f.config.log, 'utf8'), /waiting for Workbench to finish closing/)
})

macTest('Mac helper readiness precedes a real graceful process exit and replacement', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => child.kill())
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const f = await helperFixture(t, { pid: child.pid, processStart: 'running child' })
  // A real wait for this test prevents the accelerated timeout mock completing
  // before we can observe readiness and ask the fixture process to close.
  await fs.writeFile(f.script, macInstallScript(f.config, { ...f.commands, sleep: '/bin/sleep' }))
  const install = f.run()
  for (let tries = 0; ; tries++) {
    if (await fs.access(path.join(f.work, 'ready')).then(() => true, () => false)) break
    if (tries > 200) assert.fail('helper did not become ready')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(await f.installedVersion(), previousVersion)
  child.kill('SIGTERM')
  await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve) })
  await install
  assert.equal(await f.installedVersion(), version)
})

test('Mac preparation keeps the app running when the detached helper cannot initialize', { skip: process.platform !== 'linux' }, async (t) => {
  // Linux has no macOS codesign/plutil pair. This deliberately uses the real
  // launch method after mocked staging, so a successful shell spawn alone
  // must not authorize quitting the running application.
  const f = await fixture(t)
  const prepared = await prepareMacUpdate(f.options, f.dependencies)
  await assert.rejects(() => prepared.launch(), /helper stopped|helper did not become ready/)
  assert.doesNotThrow(() => process.kill(process.pid, 0))
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination, 'Contents/Info.plist'), 'utf8')).CFBundleShortVersionString, previousVersion)
  await prepared.cleanup()
})
