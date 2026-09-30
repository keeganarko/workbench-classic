import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { hostSpawn, toHostPath, toNativePath, probeWsl, findNativeExecutable, type HostSpawn } from './host.js'
import type { SessionProject } from '../shared/types.js'
import {
  MAX_SERVICE_LOG_CHARS, MAX_SERVICES, validateServiceInput,
  type ServiceDefinition, type ServiceRecord, type ServicesState
} from '../shared/services.js'

interface Dependencies {
  directory: string
  project: (id: string) => SessionProject | undefined
  changed: () => void
}

interface LaunchPlan extends HostSpawn {
  detached: boolean
  ownership: 'posix' | 'wsl' | 'windows'
}

/**
 * The PowerShell process joins an unnamed Windows Job before running the user's
 * command. Closing its last handle kills every descendant, including a server
 * whose immediate parent exits first. A taskkill tree alone loses those children
 * when the parent exits; the job makes normal completion and app shutdown agree.
 * This stays entirely inside the owned shell and never adopts an existing task.
 */
const WINDOWS_JOB = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WorkbenchServiceJob {
  [StructLayout(LayoutKind.Sequential)] public struct Basic {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr Minimum, Maximum; public uint ActiveProcesses;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Io {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Extended {
    public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static IntPtr Own() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    Extended info = new Extended(); info.Basic.Flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(info)) || !AssignProcessToJobObject(job, GetCurrentProcess()))
      throw new System.ComponentModel.Win32Exception();
    return job;
  }
}
'@
$workbenchServiceJob = [WorkbenchServiceJob]::Own()
`

/** Pure planning seam: Windows argv can be checked on Linux without starting WSL. */
export function serviceLaunchPlan(
  definition: ServiceDefinition,
  token: string,
  platform: NodeJS.Platform,
  nativeCwd: string,
  hostCwd: string,
  host: (argv: string[], options: { cwd: string }) => HostSpawn,
  powershell = 'powershell.exe'
): LaunchPlan {
  if (definition.shell === 'powershell') {
    const quotedCwd = nativeCwd.replace(/'/g, "''")
    // EncodedCommand preserves literal quotes, dollars and newlines across WSL
    // interop. The token is random runtime metadata, never a saved command.
    const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::Out.WriteLine('${token}OWNED:' + $PID)
try {
${WINDOWS_JOB}
Set-Location -LiteralPath '${quotedCwd}'
[Console]::Out.WriteLine('${token}READY:' + $PID)
$global:LASTEXITCODE = 0
& {
${definition.command}
}
if (-not $?) { exit 1 }
exit $LASTEXITCODE
} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }
`
    return {
      file: powershell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      ...(platform === 'win32' ? { cwd: nativeCwd } : {}),
      detached: false, ownership: 'windows'
    }
  }
  const script = `printf '%s%s\\n' '${token}' "$$"; exec bash -lc "$1"`
  const argv = ['bash', '-c', script, 'workbench-service', definition.command]
  // A Windows wsl.exe PID cannot name a Linux process group. setsid creates the
  // group inside WSL, and the shell reports that group's actual ID on stdout.
  const spec = host(platform === 'win32' ? ['setsid', '--wait', ...argv] : argv, { cwd: hostCwd })
  return { ...spec, detached: platform !== 'win32', ownership: platform === 'win32' ? 'wsl' : 'posix' }
}

interface Running {
  child: ChildProcess
  plan: LaunchPlan
  pid: number | null
  stopping: boolean
  finishing: boolean
  exited?: { code: number | null; error?: Error }
  done: Promise<void>
  resolveDone: () => void
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const fresh = (definition: ServiceDefinition): ServiceRecord => ({
  ...definition, status: 'stopped', pid: null, startedAt: null, exitCode: null, error: null, log: ''
})
function waitFor(done: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    void done.then(() => { clearTimeout(timer); resolve() })
  })
}

/**
 * Services belong to this Workbench process. Only definitions survive restart:
 * logs and PIDs are memory-only, so a stale PID from a previous boot can never
 * become a kill target. Per-service queues serialize rapid Start/Stop/Restart
 * clicks, while separate services can run independently.
 */
export class Services {
  private readonly deps: Dependencies
  private readonly file: string
  private state: ServicesState = { services: [], error: null }
  private readOnly = false
  private closing = false
  private readonly running = new Map<string, Running>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private changeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: Dependencies) {
    this.deps = deps
    this.file = path.join(deps.directory, 'services.json')
    if (!fs.existsSync(this.file)) return
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw?.version !== 1 || !Array.isArray(raw.services) || raw.services.length > MAX_SERVICES) throw new Error('Invalid saved services')
      const ids = new Set<string>()
      const definitions = raw.services.map((entry: ServiceDefinition) => {
        const input = validateServiceInput(entry)
        if (!input.id || ids.has(input.id) || !Number.isFinite(entry.createdAt) || entry.createdAt < 0) throw new Error('Invalid saved service')
        ids.add(input.id)
        return fresh({ ...input, id: input.id, createdAt: entry.createdAt })
      })
      this.state.services = definitions
    } catch (error) {
      this.readOnly = true
      this.state.error = `Services could not be loaded; the original file is preserved at ${this.file}: ${message(error)}`
    }
  }

  snapshot(): ServicesState { return structuredClone(this.state) }

  private changed(immediate = true): void {
    if (!immediate) {
      // A noisy server must not flood IPC or React with one update per chunk.
      if (!this.changeTimer) this.changeTimer = setTimeout(() => { this.changeTimer = null; this.deps.changed() }, 100)
      return
    }
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = null
    this.deps.changed()
  }

  private record(id: string): ServiceRecord {
    const record = this.state.services.find((service) => service.id === id)
    if (!record) throw new Error('That service no longer exists')
    return record
  }

  private persist(records: ServiceRecord[]): void {
    if (this.readOnly) throw new Error(this.state.error ?? 'Services are read-only')
    const definitions = records.map(({ id, name, projectId, cwd, command, shell, autoStart, createdAt }) =>
      ({ id, name, projectId, cwd, command, shell, autoStart, createdAt }))
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, services: definitions }, null, 2), { mode: 0o600 })
      fs.renameSync(temporary, this.file)
    } catch (error) {
      try { fs.unlinkSync(temporary) } catch { /* A failed write may not have created it. */ }
      this.state.error = `Services were not saved: ${message(error)}`
      this.changed()
      throw new Error(this.state.error)
    }
    this.state.services = records
    this.state.error = null
    this.changed()
  }

  save(raw: unknown): ServiceRecord {
    if (this.closing) throw new Error('Workbench is shutting down')
    const input = validateServiceInput(raw)
    if (!this.deps.project(input.projectId)) throw new Error('Choose an existing project')
    if (!path.isAbsolute(input.cwd) && !path.win32.isAbsolute(input.cwd)) throw new Error('Use an absolute working directory')
    const previous = input.id ? this.record(input.id) : undefined
    if (previous && (this.running.has(previous.id) || this.queues.has(previous.id))) throw new Error('Stop the service before editing it')
    if (!previous && this.state.services.length >= MAX_SERVICES) throw new Error(`Limit of ${MAX_SERVICES} services reached`)
    const definition = { ...input, id: previous?.id ?? crypto.randomUUID(), createdAt: previous?.createdAt ?? Date.now() }
    const record = previous ? { ...previous, ...definition } : fresh(definition)
    this.persist(previous ? this.state.services.map((s) => s.id === record.id ? record : s) : [...this.state.services, record])
    return structuredClone(record)
  }

  private queue<T>(id: string, action: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
    this.queues.set(id, pending)
    void pending.finally(() => { if (this.queues.get(id) === pending) this.queues.delete(id) }).catch(() => {})
    return pending
  }

  start(id: string): Promise<ServiceRecord> { return this.queue(id, () => this.startNow(id)) }
  stop(id: string): Promise<ServiceRecord> { return this.queue(id, () => this.stopNow(id)) }
  restart(id: string): Promise<ServiceRecord> {
    return this.queue(id, async () => { await this.stopNow(id); return this.startNow(id) })
  }

  remove(id: string): Promise<void> {
    return this.queue(id, async () => {
      await this.stopNow(id)
      this.persist(this.state.services.filter((service) => service.id !== id))
    })
  }

  private launchPlan(record: ServiceRecord, token: string): LaunchPlan {
    let nativeCwd = process.platform === 'win32' ? toNativePath(record.cwd) : record.cwd
    let powershell = 'powershell.exe'
    if (record.shell === 'powershell' && process.platform !== 'win32') {
      // WSLg can also host Workbench. Its Linux interop PID is not PowerShell's
      // Windows PID; the same ownership handshake is used on both installations.
      powershell = findNativeExecutable('powershell.exe') ?? ''
      if (process.platform !== 'linux' || !powershell) throw new Error('Windows PowerShell is available only on Windows or a WSL host with Windows interop')
      nativeCwd = execFileSync('wslpath', ['-w', record.cwd], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    }
    const filesystemCwd = process.platform === 'win32' ? nativeCwd : record.cwd
    if (!fs.statSync(filesystemCwd).isDirectory()) throw new Error('The working directory is not a directory')
    if (record.shell === 'bash' && process.platform === 'win32' && !probeWsl()) throw new Error('WSL is unavailable; Bash service was not started')
    return serviceLaunchPlan(record, token, process.platform, nativeCwd, toHostPath(record.cwd), hostSpawn, powershell)
  }

  private append(record: ServiceRecord, text: string): void {
    // Strip terminal controls except newline/tab/CR before placing output into
    // the plain-text log. ANSI cursor movement has no meaning outside a terminal.
    const cleaned = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    record.log = (record.log + cleaned).slice(-MAX_SERVICE_LOG_CHARS)
    this.changed(false)
  }

  private async startNow(id: string): Promise<ServiceRecord> {
    const record = this.record(id)
    if (this.closing) throw new Error('Workbench is shutting down')
    if (this.running.has(id)) return structuredClone(record)
    let plan: LaunchPlan
    const token = `__WORKBENCH_SERVICE_${crypto.randomUUID().replace(/-/g, '')}__:`
    try {
      if (!this.deps.project(record.projectId)) throw new Error('This service’s project no longer exists')
      const duplicate = this.state.services.find((other) => other.id !== id && this.running.has(other.id) &&
        other.shell === record.shell && other.cwd === record.cwd && other.command === record.command)
      if (duplicate) throw new Error(`This command is already running as ${duplicate.name}`)
      plan = this.launchPlan(record, token)
    } catch (error) {
      record.status = 'failed'; record.error = message(error); record.pid = null
      this.changed()
      throw error
    }
    Object.assign(record, { status: 'starting', pid: null, startedAt: Date.now(), exitCode: null, error: null, log: '' })
    this.changed()
    const child = spawn(plan.file, plan.args, { cwd: plan.cwd, detached: plan.detached, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const live: Running = { child, plan, pid: plan.ownership === 'posix' ? child.pid ?? null : null, stopping: false, finishing: false, done, resolveDone }
    this.running.set(id, live)
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    let pending = ''
    let identified = false
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (identified) { this.append(record, chunk); return }
      pending += chunk
      while (!identified) {
        const newline = pending.indexOf('\n')
        if (newline < 0 && pending.length <= 4096) return
        const line = pending.slice(0, newline >= 0 ? newline : pending.length).trim()
        const payload = line.startsWith(token) ? line.slice(token.length) : ''
        const ownershipOnly = payload.startsWith('OWNED:')
        const pid = Number(payload.replace(/^(?:OWNED|READY):/, ''))
        if (!payload || !Number.isSafeInteger(pid) || pid < 2) {
          rejectReady(new Error('The service shell did not report a valid owned process'))
          this.append(record, pending); pending = ''; return
        }
        pending = newline >= 0 ? pending.slice(newline + 1) : ''
        live.pid = pid; record.pid = pid
        if (ownershipOnly) { this.changed(); continue }
        identified = true; record.status = 'running'
        this.append(record, pending)
        pending = ''; this.changed(); resolveReady()
      }
    })
    child.stderr?.on('data', (chunk: string) => this.append(record, chunk))
    child.once('error', (error) => { rejectReady(error); void this.finish(record, live, null, error) })
    child.once('exit', (code, signal) => {
      if (!identified) rejectReady(new Error(`The service shell exited before startup${code === null ? '' : ` (code ${code})`}`))
      void this.finish(record, live, code, signal && !live.stopping ? new Error(`Service exited on ${signal}`) : undefined)
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([ready, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Service shell startup timed out')), 15_000) })])
    } catch (error) {
      record.error = message(error)
      await this.stopNow(id).catch((cleanup) => { record.error += `; cleanup failed: ${message(cleanup)}` })
      record.status = this.running.has(id) ? 'stopping' : 'failed'
      this.changed()
      throw error
    } finally { if (timeout) clearTimeout(timeout) }
    return structuredClone(record)
  }

  private async signal(live: Running, force: boolean): Promise<void> {
    if (live.plan.ownership === 'posix') {
      if (!live.pid) return
      try { process.kill(-live.pid, force ? 'SIGKILL' : 'SIGTERM') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      return
    }
    if (live.plan.ownership === 'wsl') {
      if (!live.pid) { live.child.kill(); return }
      const spec = hostSpawn(['bash', '-c', 'kill -"$1" -- -"$2" 2>/dev/null || ! kill -0 -- -"$2" 2>/dev/null', 'workbench-stop', force ? 'KILL' : 'TERM', String(live.pid)])
      await this.run(spec.file, spec.args)
      return
    }
    const pid = live.pid ?? (process.platform === 'win32' ? live.child.pid : undefined)
    if (!pid) throw new Error('Windows shell has not reported its process ID; cleanup could not be verified')
    // Windows console processes have no POSIX TERM signal. Kill the owned tree;
    // its job also closes children, and app quit waits for the exit notification.
    await this.run('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch((error) => {
      if (live.child.exitCode === null && live.child.signalCode === null) throw error
    })
  }

  private run(file: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 5000, maxBuffer: 32_000 }, (error) => error ? reject(error) : resolve()))
  }

  private async finish(record: ServiceRecord, live: Running, code: number | null, error?: Error): Promise<void> {
    if (live.finishing) return
    live.finishing = true
    live.exited = { code, error }
    // A foreground shell may exit while one of its children still owns stdout.
    // Clean the group at exit, rather than waiting indefinitely for stream close.
    if (live.plan.ownership !== 'windows') {
      try { await this.signal(live, true) } catch (cleanup) {
        // Keep ownership if cleanup could not be confirmed. A failed group kill
        // must leave a usable Stop button, not forget a server that may remain.
        live.finishing = false
        record.status = 'stopping'
        record.error = `Could not finish service cleanup: ${message(cleanup)}`
        this.changed()
        return
      }
    }
    if (this.running.get(record.id) === live) this.running.delete(record.id)
    record.pid = null; record.exitCode = code
    record.status = error ? 'failed' : live.stopping ? 'stopped' : code === 0 ? 'exited' : 'failed'
    if (error) record.error = error.message
    else if (!live.stopping && code !== 0) record.error = `Command exited with code ${code ?? 'unknown'}`
    live.resolveDone()
    this.changed()
  }

  private async stopNow(id: string): Promise<ServiceRecord> {
    const record = this.record(id)
    const live = this.running.get(id)
    if (!live) return structuredClone(record)
    live.stopping = true; record.status = 'stopping'; this.changed()
    try {
      if (!live.finishing) await this.signal(live, false)
      if (live.exited && !live.finishing) await this.finish(record, live, live.exited.code, live.exited.error)
      await waitFor(live.done, 1200)
      if (this.running.get(id) === live) await this.signal(live, true)
      await waitFor(live.done, 5000)
      if (this.running.get(id) === live) throw new Error('The service has not exited; its process is still tracked')
    } catch (error) {
      record.status = 'stopping'; record.error = `Could not stop service: ${message(error)}`; this.changed()
      throw error
    }
    return structuredClone(record)
  }

  async autoStart(): Promise<void> {
    await Promise.all(this.state.services.filter((service) => service.autoStart).map(async (service) => {
      try { await this.start(service.id) } catch { /* start records the actionable failure on its own row. */ }
    }))
  }

  /** A prepared update can still fail before its installer starts. Restore
   * normal controls after that completed shutdown, without silently restarting
   * commands the user did not ask to run again. The updater calls this only
   * after shutdown has settled; it does not cancel an in-flight process stop. */
  cancelShutdown(): void { this.closing = false }

  async shutdown(): Promise<void> {
    this.closing = true
    const outcomes = await Promise.allSettled(this.state.services.map((service) => this.stop(service.id)))
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = null
    const failure = outcomes.find((outcome) => outcome.status === 'rejected')
    if (failure?.status === 'rejected') {
      // before-quit can keep the window open after a failed stop. Restore normal
      // operations so the user can correct the command or retry owned cleanup.
      this.closing = false
      throw failure.reason
    }
  }
}
