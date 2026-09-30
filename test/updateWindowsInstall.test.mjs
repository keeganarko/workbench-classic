import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { launchWindowsInstaller, powershellEnv, powershellPath, windowsInstallerTrust, windowsSignature, WINDOWS_INSTALL_SCRIPT } from '../src/main/updateWindows.js'

const signer = 'A'.repeat(40), otherSigner = 'B'.repeat(40)
const unsigned = { status: 'NotSigned', signer: null }
const signed = { status: 'Valid', signer }

test('Windows Beta trust allows explicitly unsigned pairs or the same verified publisher', () => {
  assert.equal(windowsInstallerTrust(unsigned, unsigned, null), true)
  assert.equal(windowsInstallerTrust(signed, signed, signer), true)
  assert.equal(windowsInstallerTrust({ ...signed, signer: signer.toLowerCase() }, signed, signer), true)
  for (const [current, next, expected] of [
    [signed, unsigned, signer], [unsigned, signed, signer], [signed, signed, null],
    [unsigned, unsigned, signer], [signed, { ...signed, signer: otherSigner }, signer],
    [{ ...signed, signer: otherSigner }, signed, signer], [signed, signed, otherSigner],
    [{ ...unsigned, signer }, unsigned, null], [unsigned, { ...unsigned, signer }, null],
    [signed, signed, 'malformed']
  ]) assert.equal(windowsInstallerTrust(current, next, expected), false)
})

test('Authenticode failures never count as unsigned bootstrap builds', () => {
  for (const status of ['UnknownError', 'HashMismatch', 'NotTrusted', 'NotSupportedFileFormat', 'Incompatible', '', 'Valid']) {
    assert.equal(windowsInstallerTrust({ status, signer: null }, unsigned, null), false, status)
    assert.equal(windowsInstallerTrust(unsigned, { status, signer: null }, null), false, status)
    assert.equal(windowsInstallerTrust(signed, { status, signer }, signer), status === 'Valid', status)
  }
})

// Native integration uses only a newly compiled, harmless fixture in the OS
// temp directory. It does not execute NSIS, launch installed Workbench, or
// terminate an existing agent. Run with Windows Node to exercise PowerShell.
const fixtureSource = String.raw`
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
public class UpdateFixture {
  public static int Main(string[] args) {
    string directory = AppDomain.CurrentDomain.BaseDirectory;
    if (args.Length == 2 && args[0] == "--hold") {
      File.WriteAllText(args[1] + ".started", Process.GetCurrentProcess().Id.ToString());
      while (!File.Exists(args[1] + ".release")) Thread.Sleep(50);
      return 0;
    }
    if (Array.IndexOf(args, "/S") >= 0) {
      File.WriteAllText(Path.Combine(directory, "installer-command.txt"), Environment.CommandLine);
      string remove = Path.Combine(directory, "delete-app.txt");
      if (File.Exists(remove)) File.Delete(File.ReadAllText(remove));
      string code = Path.Combine(directory, "exitcode.txt");
      return File.Exists(code) ? Int32.Parse(File.ReadAllText(code)) : 0;
    }
    File.AppendAllText(Path.Combine(directory, "relaunch.txt"), "launched\n");
    return 0;
  }
}`

async function until(check, description) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(75)
  }
  assert.fail(`Timed out waiting for ${description}`)
}
async function read(file) {
  try { return await fs.readFile(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error; return '' }
}

test('native Windows installer handoff waits, verifies, protects bridges, and relaunches', { skip: process.platform !== 'win32', timeout: 180000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-helper-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const fixture = path.join(root, 'fixture.exe')
  await promisify(execFile)(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition $env:WORKBENCH_TEST_SOURCE -OutputAssembly $env:WORKBENCH_TEST_OUTPUT -OutputType ConsoleApplication"],
  { env: { ...powershellEnv(), WORKBENCH_TEST_SOURCE: fixtureSource, WORKBENCH_TEST_OUTPUT: fixture }, windowsHide: true, timeout: 30000 })

  async function makeCase(t) {
    const folder = await fs.mkdtemp(path.join(root, 'case-'))
    const installed = path.join(folder, 'Original install path'), directory = path.join(folder, 'download')
    await fs.mkdir(installed); await fs.mkdir(directory)
    const executable = path.join(installed, 'Workbench-fixture.exe'), installer = path.join(directory, 'Setup-fixture.exe')
    await fs.copyFile(fixture, executable); await fs.copyFile(fixture, installer)
    const userState = path.join(folder, 'saved-workspace.json')
    await fs.writeFile(userState, '{"draft":"keep this unsent"}')
    const holds = []
    const hold = async (file = executable) => {
      const marker = path.join(folder, `hold-${holds.length}`)
      const child = spawn(file, ['--hold', marker], { stdio: 'ignore', windowsHide: true })
      child.on('error', () => {})
      holds.push({ child, marker })
      await until(() => read(marker + '.started'), 'fixture process to start')
      return child
    }
    const parent = await hold()
    t.after(async () => {
      for (const { child, marker } of holds) {
        await fs.writeFile(marker + '.release', '')
        if (child.exitCode === null) {
          await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(1000)])
          if (child.exitCode === null) child.kill()
        }
      }
      // A failed assertion may leave the helper waiting for our fixture. Give
      // it the opportunity to finish before removing its private test files.
      const ready = await read(path.join(directory, 'install-ready.json'))
      if (ready) {
        const helperPid = JSON.parse(ready).pid
        await until(() => { try { process.kill(helperPid, 0); return false } catch { return true } }, 'test helper to exit')
      }
    })
    const sha512 = crypto.createHash('sha512').update(await fs.readFile(installer)).digest('hex')
    return {
      config: { directory, installer, executable, pid: parent.pid, sha512, signer: null }, parent, hold, installed, userState,
      closeParent: () => fs.writeFile(holds[0].marker + '.release', ''),
      command: () => read(path.join(directory, 'installer-command.txt')),
      error: () => read(path.join(directory, 'install-error.log')),
      relaunched: () => read(path.join(installed, 'relaunch.txt'))
    }
  }

  await t.test('unsigned fixture signature is explicitly NotSigned and missing file fails closed', async () => {
    assert.deepEqual(await windowsSignature(fixture), unsigned)
    await assert.rejects(() => windowsSignature(path.join(root, 'missing.exe')))
  })

  await t.test('starts only after exact parent exits, targets its existing path, relaunches once', async (t) => {
    const c = await makeCase(t)
    await launchWindowsInstaller(c.config)
    assert.equal(await c.command(), '')
    assert.equal(c.parent.exitCode, null)
    await c.closeParent()
    const command = await until(c.command, 'installer launch')
    assert.ok(command.endsWith(`/S --updated /D=${c.installed}`), command)
    await until(c.relaunched, 'Workbench relaunch')
    assert.equal(await c.relaunched(), 'launched\n')
    assert.equal(await c.error(), '')
    assert.equal(await fs.readFile(c.userState, 'utf8'), '{"draft":"keep this unsent"}')
  })

  await t.test('checksum failure before readiness keeps the app open', async (t) => {
    const c = await makeCase(t)
    await assert.rejects(() => launchWindowsInstaller({ ...c.config, sha512: '0'.repeat(128) }), /checksum changed/)
    assert.equal(c.parent.exitCode, null)
    assert.equal(await c.command(), '')
    assert.equal(await c.relaunched(), '')
  })

  await t.test('helper survives the Node process that launched it exiting', async (t) => {
    const c = await makeCase(t)
    const moduleURL = new URL('../src/main/updateWindows.ts', import.meta.url).href
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `const { launchWindowsInstaller } = await import(${JSON.stringify(moduleURL)}); await launchWindowsInstaller(JSON.parse(process.env.WORKBENCH_TEST_CONFIG));`],
    { env: { ...process.env, WORKBENCH_TEST_CONFIG: JSON.stringify(c.config) }, windowsHide: true, timeout: 30000 })
    assert.equal(await c.command(), '')
    await c.closeParent()
    await until(c.relaunched, 'relaunch after launcher Node exits')
    assert.equal(await c.error(), '')
  })

  await t.test('a ready helper cannot install until the app acknowledges its handoff', async (t) => {
    const c = await makeCase(t), token = crypto.randomUUID()
    const configFile = path.join(c.config.directory, 'install.json')
    await fs.writeFile(configFile, JSON.stringify({ ...c.config, token }))
    const running = promisify(execFile)(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_INSTALL_SCRIPT, 'utf16le').toString('base64')],
      { env: { ...powershellEnv(), WORKBENCH_UPDATE_CONFIG: configFile }, windowsHide: true, timeout: 30000 })
    await until(() => read(path.join(c.config.directory, 'install-ready.json')), 'unacknowledged readiness')
    await c.closeParent()
    await delay(500)
    assert.equal(await c.command(), '')
    await fs.writeFile(path.join(c.config.directory, 'install-acknowledged.json'), JSON.stringify({ token }))
    await running
    await until(c.relaunched, 'relaunch after acknowledged handoff')
    assert.equal(await c.error(), '')
  })

  await t.test('checksum is checked again after the app exits and failure relaunches old app', async (t) => {
    const c = await makeCase(t)
    await launchWindowsInstaller(c.config)
    await fs.appendFile(c.config.installer, 'changed after readiness')
    await c.closeParent()
    assert.match(await until(c.error, 'integrity failure log'), /checksum changed/)
    await until(c.relaunched, 'original app relaunch')
    assert.equal(await c.command(), '')
  })

  await t.test('signed expectation refuses unsigned executable and installer before shutdown', async (t) => {
    const c = await makeCase(t)
    await assert.rejects(() => launchWindowsInstaller({ ...c.config, signer }), /publisher does not match/)
    assert.equal(c.parent.exitCode, null)
    assert.equal(await c.command(), '')
  })

  for (const embedded of [false, true]) await t.test(`active ${embedded ? 'embedded executable' : 'Workbench'} bridge blocks handoff and stays alive`, async (t) => {
    const c = await makeCase(t)
    let bridgeFile = c.config.executable
    if (embedded) {
      bridgeFile = path.join(c.installed, 'bridge.exe')
      await fs.copyFile(fixture, bridgeFile)
    }
    const bridge = await c.hold(bridgeFile)
    await assert.rejects(() => launchWindowsInstaller(c.config), /Active agent connections/)
    assert.equal(bridge.exitCode, null)
    assert.equal(c.parent.exitCode, null)
    assert.doesNotThrow(() => process.kill(bridge.pid, 0))
    assert.equal(await c.command(), '')
  })

  await t.test('bridge starting after readiness blocks NSIS without being terminated', async (t) => {
    const c = await makeCase(t)
    await launchWindowsInstaller(c.config)
    const bridge = await c.hold()
    await c.closeParent()
    assert.match(await until(c.error, 'agent guard error log'), /Agent connections are still using/)
    await until(c.relaunched, 'original app relaunch after guard')
    assert.equal(bridge.exitCode, null)
    assert.doesNotThrow(() => process.kill(bridge.pid, 0))
    assert.equal(await c.command(), '')
  })

  await t.test('installer error survives relaunch for the app to report', async (t) => {
    const c = await makeCase(t)
    await fs.writeFile(path.join(c.config.directory, 'exitcode.txt'), '7')
    await launchWindowsInstaller(c.config)
    await c.closeParent()
    assert.match(await until(c.error, 'installer error log'), /Installer exited with code 7/)
    await until(c.relaunched, 'original app relaunch after install failure')
  })

  await t.test('failed relaunch leaves a readable recovery error', async (t) => {
    const c = await makeCase(t)
    await fs.writeFile(path.join(c.config.directory, 'delete-app.txt'), c.config.executable)
    await launchWindowsInstaller(c.config)
    await c.closeParent()
    assert.match(await until(c.error, 'relaunch error log'), /executable is missing/)
    assert.equal(await c.relaunched(), '')
  })

  await t.test('failed PowerShell spawn rejects without closing the app', async (t) => {
    const c = await makeCase(t), original = process.env.SystemRoot
    try {
      process.env.SystemRoot = path.join(root, 'missing-windows')
      await assert.rejects(() => launchWindowsInstaller(c.config), /ENOENT/)
    } finally { process.env.SystemRoot = original }
    assert.equal(c.parent.exitCode, null)
    assert.equal(await c.command(), '')
  })
})
