import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Services, serviceLaunchPlan } from '../src/main/services.js'
import { MAX_SERVICE_LOG_CHARS, validateServiceInput } from '../src/shared/services.js'

const posix = process.platform !== 'win32'
const quote = (text) => `'${text.replace(/'/g, `'"'"'`)}'`
const node = (script) => `${quote(process.execPath)} -e ${quote(script)}`
const longCommand = node("console.log('ready'); setInterval(() => {}, 1000)")

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-services-'))
  let projects = [{ id: 'project', name: 'Fixture', defaultCwd: directory, createdAt: 1 }]
  const deps = { directory, project: (id) => projects.find((p) => p.id === id), changed: () => {} }
  const manager = new Services(deps)
  t.after(async () => { await manager.shutdown(); fs.rmSync(directory, { recursive: true, force: true }) })
  const input = { name: 'Server', projectId: 'project', cwd: directory, command: longCommand, shell: 'bash', autoStart: false }
  return { directory, manager, input, deps, removeProject: () => { projects = [] } }
}

async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for service state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function live(pid) {
  try {
    // An orphan can briefly remain a zombie until the host's init reaps it. It
    // has already released its ports/files and is no longer a running server.
    if (process.platform === 'linux' && fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z')) return false
    process.kill(pid, 0)
    return true
  } catch { return false }
}

test('service validation rejects malformed input and invalid project/cwd', (t) => {
  const { manager, input } = fixture(t)
  for (const raw of [null, [], { ...input, shell: 'cmd' }, { ...input, command: '\0' }, { ...input, autoStart: 'yes' }]) {
    assert.throws(() => validateServiceInput(raw))
  }
  assert.throws(() => manager.save({ ...input, projectId: 'missing' }), /existing project/)
  assert.throws(() => manager.save({ ...input, cwd: 'relative' }), /absolute/)
})

test('only definitions persist, without touching existing experience or app state', async (t) => {
  const { directory, manager, input, deps } = fixture(t)
  for (const name of ['experience.json', 'workbench.json']) fs.writeFileSync(path.join(directory, name), 'preserve me')
  const service = manager.save(input)
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'services.json'), 'utf8'))
  assert.equal(saved.services[0].id, service.id)
  assert.equal(saved.services[0].autoStart, false)
  assert.equal('pid' in saved.services[0], false)
  assert.equal('log' in saved.services[0], false)
  const restored = new Services(deps)
  assert.equal(restored.snapshot().services[0].status, 'stopped')
  assert.equal(restored.snapshot().services[0].log, '')
  for (const name of ['experience.json', 'workbench.json']) assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), 'preserve me')
  if (posix) assert.equal(fs.statSync(path.join(directory, 'services.json')).mode & 0o777, 0o600)
  await restored.shutdown()
})

test('a corrupt or incompatible service file is preserved and mutations fail closed', (t) => {
  const { directory, input, deps } = fixture(t)
  const file = path.join(directory, 'services.json')
  for (const content of ['{broken', '{"version":99,"services":[]}']) {
    fs.writeFileSync(file, content)
    const manager = new Services(deps)
    assert.deepEqual(manager.snapshot().services, [])
    assert.match(manager.snapshot().error, /preserved/)
    assert.throws(() => manager.save(input), /preserved/)
    assert.equal(fs.readFileSync(file, 'utf8'), content)
  }
})

test('failed persistence leaves the definition and file unchanged', (t) => {
  const { directory, manager, input } = fixture(t)
  fs.mkdirSync(path.join(directory, 'services.json'))
  assert.throws(() => manager.save(input), /not saved/)
  assert.deepEqual(manager.snapshot().services, [])
  assert.match(manager.snapshot().error, /not saved/)
})

test('start is idempotent, restart replaces the owned process, and stop releases it', { skip: !posix }, async (t) => {
  const { manager, input } = fixture(t)
  const service = manager.save(input)
  const [first, duplicate] = await Promise.all([manager.start(service.id), manager.start(service.id)])
  assert.equal(first.status, 'running')
  assert.equal(first.pid, duplicate.pid)
  await until(() => manager.snapshot().services[0].log.includes('ready'))
  assert.throws(() => manager.save({ ...service, name: 'Edit live' }), /Stop/)
  const secondDefinition = manager.save({ ...input, name: 'Same command' })
  await assert.rejects(manager.start(secondDefinition.id), /already running/)
  const restarted = await manager.restart(service.id)
  assert.notEqual(restarted.pid, first.pid)
  assert.equal(live(first.pid), false)
  const stopped = await manager.stop(service.id)
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.pid, null)
  assert.equal(live(restarted.pid), false)
})

test('shutdown stops a server and its children while leaving an unrelated process alone', { skip: !posix }, async (t) => {
  const { manager, input, directory } = fixture(t)
  const { spawn } = await import('node:child_process')
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => unrelated.kill())
  const pidFile = path.join(directory, 'child-pid')
  const command = node(`const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(() => {},1000)`)
  const started = await manager.start(manager.save({ ...input, command }).id)
  await until(() => fs.existsSync(pidFile))
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.equal(live(childPid), true)
  await manager.shutdown()
  await until(() => !live(childPid))
  assert.equal(live(started.pid), false)
  assert.equal(live(unrelated.pid), true)
  await assert.rejects(manager.start(started.id), /shutting down/)
})

test('canceling a prepared update restores service editing and starting without restarting commands', { skip: !posix }, async (t) => {
  const { manager, input } = fixture(t)
  const definition = manager.save({ ...input, autoStart: true })
  const started = await manager.start(definition.id)
  await manager.shutdown()
  assert.equal(live(started.pid), false)
  assert.throws(() => manager.save({ ...definition, name: 'Blocked during handoff' }), /shutting down/)
  await assert.rejects(manager.start(definition.id), /shutting down/)

  manager.cancelShutdown()
  assert.equal(manager.snapshot().services[0].status, 'stopped')
  assert.equal(manager.snapshot().services[0].pid, null)
  const edited = manager.save({ ...definition, name: 'Usable after installer failure' })
  assert.equal(edited.name, 'Usable after installer failure')
  // Even an autostart definition stays stopped until the user explicitly starts
  // it or opens the app again. Canceling an update only restores the controls.
  assert.equal(edited.status, 'stopped')
  const restarted = await manager.start(definition.id)
  assert.equal(restarted.status, 'running')
  assert.notEqual(restarted.pid, started.pid)
  await manager.stop(definition.id)
})

test('normal command exit cleans remaining children and retains its exit code', { skip: !posix }, async (t) => {
  const { manager, input, directory } = fixture(t)
  const pidFile = path.join(directory, 'child-pid')
  const command = node(`const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); child.unref(); process.exitCode=7`)
  const service = manager.save({ ...input, command })
  await manager.start(service.id)
  await until(() => manager.snapshot().services[0].status === 'failed')
  const record = manager.snapshot().services[0]
  assert.equal(record.exitCode, 7)
  assert.match(record.error, /code 7/)
  await until(() => !live(Number(fs.readFileSync(pidFile, 'utf8'))))
})

test('a server that ignores TERM is killed after the grace period', { skip: !posix }, async (t) => {
  const { manager, input } = fixture(t)
  const service = manager.save({ ...input, command: node("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {},1000)") })
  const started = await manager.start(service.id)
  await until(() => manager.snapshot().services[0].log.includes('ready'))
  await manager.stop(service.id)
  assert.equal(live(started.pid), false)
  assert.equal(manager.snapshot().services[0].status, 'stopped')
})

test('failed shutdown retains ownership and permits another stop attempt', { skip: !posix }, async (t) => {
  const { manager, input } = fixture(t)
  const service = manager.save(input)
  const started = await manager.start(service.id)
  const signal = manager.signal.bind(manager)
  manager.signal = async () => { throw new Error('Simulated permission failure') }
  try {
    await assert.rejects(manager.shutdown(), /Simulated permission failure/)
    assert.equal(manager.snapshot().services[0].status, 'stopping')
    assert.equal(manager.snapshot().services[0].pid, started.pid)
    assert.equal(live(started.pid), true)
    assert.doesNotThrow(() => manager.save({ ...input, name: 'Still usable' }))
  } finally { manager.signal = signal }
  await manager.stop(service.id)
  assert.equal(live(started.pid), false)
})

test('logs stay bounded and a missing directory is a visible failure', { skip: !posix }, async (t) => {
  const { manager, input, directory } = fixture(t)
  const service = manager.save({ ...input, command: node("console.log('x'.repeat(100000)); console.error('tail'); setInterval(() => {},1000)") })
  await manager.start(service.id)
  await until(() => manager.snapshot().services[0].log.includes('tail'))
  assert.ok(manager.snapshot().services[0].log.length <= MAX_SERVICE_LOG_CHARS)
  await manager.stop(service.id)
  const missing = manager.save({ ...input, cwd: path.join(directory, 'not-created') })
  await assert.rejects(manager.start(missing.id), /ENOENT/)
  const failed = manager.snapshot().services.find((s) => s.id === missing.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /ENOENT/)
})

test('autostart runs only enabled services with existing projects and reports missing projects', { skip: !posix }, async (t) => {
  const { manager, input, deps, removeProject } = fixture(t)
  const enabled = manager.save({ ...input, autoStart: true })
  manager.save({ ...input, name: 'Manual' })
  const restored = new Services(deps)
  t.after(() => restored.shutdown())
  await restored.autoStart()
  assert.equal(restored.snapshot().services.find((s) => s.id === enabled.id).status, 'running')
  assert.equal(restored.snapshot().services.find((s) => s.id !== enabled.id).status, 'stopped')
  await restored.shutdown()
  removeProject()
  const orphan = new Services(deps)
  await orphan.autoStart()
  assert.equal(orphan.snapshot().services[0].status, 'failed')
  assert.match(orphan.snapshot().services[0].error, /project no longer exists/)
  await orphan.shutdown()
})

test('Windows Bash planning creates and reports a Linux group inside the selected WSL host', () => {
  const command = 'printf "%s" "literal $HOME"\nnode server.js'
  const calls = []
  const plan = serviceLaunchPlan({ shell: 'bash', command }, 'TOKEN:', 'win32', 'C:\\Code Space', '/mnt/c/Code Space', (argv, options) => {
    calls.push({ argv, options })
    return { file: 'wsl.exe', args: ['-d', 'TestDistro', '--cd', options.cwd, '-e', ...argv] }
  })
  assert.equal(plan.file, 'wsl.exe')
  assert.equal(plan.ownership, 'wsl')
  assert.equal(plan.detached, false)
  assert.deepEqual(calls[0].argv.slice(0, 3), ['setsid', '--wait', 'bash'])
  assert.equal(calls[0].argv.at(-1), command)
  assert.equal(calls[0].options.cwd, '/mnt/c/Code Space')
  assert.match(calls[0].argv[4], /TOKEN:/)
})

test('PowerShell planning uses native encoded script, literal cwd and a kill-on-close Windows job', () => {
  const command = 'Write-Output "$literal"\n& .\\server.ps1'
  const cwd = "C:\\Code's directory"
  const plan = serviceLaunchPlan({ shell: 'powershell', command }, 'TOKEN:', 'win32', cwd, '/unused', () => { throw new Error('PowerShell must not use WSL') })
  assert.equal(plan.file, 'powershell.exe')
  assert.equal(plan.cwd, cwd)
  assert.equal(plan.ownership, 'windows')
  const script = Buffer.from(plan.args.at(-1), 'base64').toString('utf16le')
  assert.ok(script.includes(command))
  assert.ok(script.includes("Set-Location -LiteralPath 'C:\\Code''s directory'"))
  assert.match(script, /AssignProcessToJobObject/)
  assert.match(script, /Flags = 0x2000/)
  assert.match(script, /'TOKEN:OWNED:' \+ \$PID/)
  assert.ok(script.indexOf("'TOKEN:READY:'") > script.indexOf('Set-Location'))
})

test('native PowerShell job cleans children on stop and on ordinary completion', { skip: process.platform !== 'win32' }, async (t) => {
  const { manager, input } = fixture(t)
  const { execFile } = await import('node:child_process')
  const exists = (pid) => new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' }`], { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout.includes('alive'))))
  const spawnChild = "$child = Start-Process powershell.exe -ArgumentList '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120' -WindowStyle Hidden -PassThru; Write-Output ('child=' + $child.Id)"
  const service = manager.save({ ...input, shell: 'powershell', command: `${spawnChild}; while ($true) { Start-Sleep -Seconds 1 }` })
  const started = await manager.start(service.id)
  await until(() => /child=\d+/.test(manager.snapshot().services[0].log), 15000)
  const childPid = Number(/child=(\d+)/.exec(manager.snapshot().services[0].log)[1])
  assert.equal(await exists(childPid), true)
  await manager.stop(service.id)
  assert.equal(await exists(started.pid), false)
  assert.equal(await exists(childPid), false)
  const complete = manager.save({ ...service, command: `${spawnChild}; Start-Sleep -Milliseconds 200; exit 7` })
  await manager.start(complete.id)
  await until(() => manager.snapshot().services[0].status === 'failed', 15000)
  const exited = manager.snapshot().services[0]
  assert.equal(exited.exitCode, 7)
  assert.equal(await exists(Number(/child=(\d+)/.exec(exited.log)[1])), false)
})
