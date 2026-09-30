/**
 * Agent launch plumbing: locating the CLIs, and building the argv that gives us
 * (a) status telemetry via hooks and (b) real context inheritance on fork.
 *
 * Context inheritance is not simulated here. Both CLIs support it natively:
 *   claude --resume <id> --fork-session   → branches the real conversation
 *   codex fork <id>                       → branches the real thread
 * We only have to remember each CLI's own session id, which the hook bridge
 * reports back to us.
 */

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  hostCapture,
  hostFileExists,
  hostHomeNative,
  hostKind,
  hostSpawn,
  hostSpawnEnv,
  hostUser,
  toHostPath
} from './host.js'
import type { AgentDefinition } from '../shared/agents.js'
import type { PermissionMode } from '../shared/types.js'
import { reverseTranscriptLines } from './transcriptLines.js'

const execFileAsync = promisify(execFile)

export interface AgentBinary {
  path: string | null
  version: string | null
}

/**
 * GUI apps on macOS start with a bare PATH, so a launched-from-Finder Workbench
 * would not find `claude`, `codex`, `tmux` or `node`. Ask the user's login shell
 * once for the real thing, and fall back to the usual suspects.
 */
export function resolveLoginPath(): string {
  if (hostKind() === 'wsl') return resolveHostLoginPath()
  const fallback = [
    path.join(os.homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  let shellPath = ''
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    shellPath = execFileSync(shell, ['-lic', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    /* login shell probe failed; fallback list is enough */
  }
  const merged = [
    ...shellPath.split(':').filter(Boolean),
    ...fallback,
    ...(process.env.PATH ?? '').split(':').filter(Boolean)
  ]
  return Array.from(new Set(merged)).join(':')
}

/**
 * The login PATH when the session layer lives inside WSL.
 *
 * `process.env.SHELL` is a POSIX convention and is simply absent on Windows, so
 * the local path's `SHELL || /bin/zsh` would exec a shell that does not exist
 * and fall into a catch that silently returns macOS directories — a PATH made
 * entirely of paths that cannot be reached from here. Ask the host who it is
 * instead: the passwd entry is authoritative, and it is what `login` itself
 * uses, so the PATH we get back is the one an interactive session really has.
 *
 * One command, because a WSL round trip may have to boot the VM and paying that
 * twice at startup is visible.
 */
function resolveHostLoginPath(): string {
  const script = [
    's=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)',
    '[ -x "$s" ] || s=/bin/sh',
    '"$s" -lic \'printf %s "$PATH"\' 2>/dev/null || printf %s "$PATH"'
  ].join('; ')
  const out = hostCapture(['sh', '-c', script])?.trim() ?? ''
  const home = `/home/${hostUser()}`
  const fallback = [
    `${home}/.local/bin`,
    `${home}/bin`,
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  // Only keep entries that are absolute POSIX paths. A login shell that printed
  // a banner, or a distro with a stray empty entry, must not corrupt the PATH
  // every agent is about to inherit.
  const merged = [...out.split(':'), ...fallback].filter((d) => d.startsWith('/'))
  return Array.from(new Set(merged)).join(':')
}

/** The login shell on the host — what a "shell" session actually runs. */
export function loginShell(): string {
  if (hostKind() === 'local') return process.env.SHELL || '/bin/zsh'
  const out = hostCapture(['sh', '-c', 'getent passwd "$(id -un)" | cut -d: -f7'])?.trim()
  return out && out.startsWith('/') ? out : '/bin/bash'
}

/**
 * Finds an executable by scanning the resolved PATH ourselves (no `which`).
 *
 * The PATH being scanned is always the *host's*, so it is always POSIX and
 * always colon-delimited — there is no `path.delimiter` or `PATHEXT` case to
 * handle, because the thing being searched is never a Windows PATH. What does
 * change across the boundary is how a candidate gets tested, which is why the
 * check lives in `hostFileExists` rather than here.
 */
export function findExecutable(name: string, searchPath: string): string | null {
  if (hostKind() !== 'local') return findHostExecutable(name, searchPath)
  for (const dir of searchPath.split(':')) {
    if (!dir) continue
    const candidate = path.posix.join(dir, name)
    if (hostFileExists(candidate, true)) return candidate
  }
  return null
}

/**
 * The same search, done in a single crossing by the shell that owns the PATH.
 *
 * Walking the directories ourselves means one question per entry, and each
 * question across the boundary is a `wsl.exe` round trip of roughly a tenth of
 * a second. A real login PATH here has thirty-odd entries, and `claude` sits in
 * the first while `codex` sits in the second — but `cloudflared`, or a name
 * that is simply not installed, would walk all thirty and spend three seconds
 * doing it, at startup, before the window is any use.
 *
 * `command -v` is also *more* correct than the scan, not just faster: it stands
 * on the side where a symlinked shim resolves, so it finds the agents that the
 * Windows-side test cannot see at all.
 *
 * Only an absolute answer is trusted. `command -v` reports builtins, functions
 * and aliases too, and none of those is something tmux can exec.
 */
function findHostExecutable(name: string, searchPath: string): string | null {
  const out = hostCapture(
    ['sh', '-c', 'PATH=$1 command -v -- "$2" 2>/dev/null', 'sh', searchPath, name],
    10_000
  )?.trim()
  return out && out.startsWith('/') ? out : null
}

/**
 * The version string an installed tool reports, or null if it cannot say.
 *
 * `searchPath` is not decoration. Most agent CLIs install as a script with
 * `#!/usr/bin/env node` at the top, so running one is really running *two*
 * programs, and the second is found on PATH at exec time. A GUI app's own PATH
 * is not the user's, and across the WSL boundary it is not even the same
 * machine's: `wsl.exe -e /home/u/.nvm/.../codex --version` exits 127 — not
 * because codex is missing, but because the `node` its shebang asks for is.
 * Hand it the login PATH and the shebang resolves.
 *
 * The PATH travels differently on each side, which is the whole point of the
 * pair: as an argv prefix through `hostSpawn` when there is a boundary, and as
 * this process's own child environment through `hostSpawnEnv` when there is
 * not.
 */
export async function probeVersion(
  bin: string,
  args = ['--version'],
  searchPath?: string
): Promise<string | null> {
  const spawn = hostSpawn([bin, ...args], searchPath ? { env: { PATH: searchPath } } : {})
  try {
    const { stdout } = await execFileAsync(spawn.file, spawn.args, {
      timeout: 20_000,
      windowsHide: true,
      env: searchPath ? hostSpawnEnv({ ...process.env, PATH: searchPath }) : undefined
    })
    return stdout.trim().split('\n')[0] || null
  } catch {
    return null
  }
}

export interface LaunchSpec {
  command: string[]
  /** Argv the profile always carries: hook wiring and config overrides. */
  baseArgs: string[]
  /** Argv specific to this launch: resume/fork, model, permission mode. */
  launchArgs: string[]
  /** Extra env injected into the tmux session (hook wiring lives here). */
  env: Record<string, string>
  /** The Claude session uuid we pre-assigned, when we could. */
  assignedSessionId: string | null
  /** Process-scoped lifecycle log this launch was told to write, if any. */
  lifecycleLogPath: string | null
}

export interface BuildOptions {
  /**
   * The registry row for this agent. Carries the launch strategy, so this
   * builder no longer has to know which agents exist — only how the three
   * strategies differ.
   */
  definition: AgentDefinition
  bin: string
  cwd: string
  /** Per-session Claude settings file carrying our hooks. */
  claudeSettingsPath: string
  /** Absolute path to the generated shell shim Codex calls on turn end. */
  codexNotifyShim: string
  /**
   * Where this Codex launch should write its process-scoped TUI session log.
   * Passing a unique path per launch is what lets two concurrent Codex sessions
   * be told apart — see `parseCodexSessionLog`.
   */
  codexSessionLogPath?: string | null
  /** Resume/fork source — the *CLI's* own session id, not ours. */
  resumeFrom?: string | null
  forkFromParent?: boolean
  newSessionId: string
  permissionMode?: PermissionMode
  model?: string | null
  effort?: string | null
  /**
   * Session Bus delivery, or null when the bus is switched off app-wide.
   * `claudeMcpConfig` is a config file path; Codex takes `-c` overrides instead.
   *
   * Whether a session may actually *use* the bus is not decided here — the
   * bridge checks that per call, so the user can revoke access without
   * restarting the agent.
   */
  busMcp?: { claudeMcpConfig: string; codexArgs: string[] } | null
}

/**
 * Translates our permission mode into each CLI's own flags.
 *
 * `full-access` is the "accept everything" mode: it hands the agent Claude's
 * `--dangerously-skip-permissions` or Codex's
 * `--dangerously-bypass-approvals-and-sandbox`. Both are per-invocation argv, so
 * choosing it for one session never changes the user's global config or leaks
 * into any other session.
 *
 * An agent that does not declare the `permissions` capability gets nothing —
 * not a best guess at an equivalent flag. Its session still records the mode
 * the user chose, so the pane footer stays honest about what was asked for.
 */
export function permissionArgs(definition: AgentDefinition, mode: PermissionMode): string[] {
  if (!definition.capabilities.permissions || mode === 'default') return []
  if (definition.launch === 'claude') {
    return mode === 'full-access'
      ? ['--dangerously-skip-permissions']
      : ['--permission-mode', 'acceptEdits']
  }
  if (definition.launch === 'codex') {
    return mode === 'full-access'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'workspace-write']
  }
  return []
}

/**
 * Builds the argv for a session, by strategy rather than by name.
 *
 * The three strategies are the three amounts we know about a CLI. `plain` is
 * the floor and covers both the login shell and every agent the user adds: run
 * the command with its configured arguments and nothing invented. The other two
 * encode flags this project has verified and pinned in tests.
 */
export function buildLaunchSpec(opts: BuildOptions): LaunchSpec {
  switch (opts.definition.launch) {
    case 'claude':
      return claudeSpec(opts)
    case 'codex':
      return codexSpec(opts)
    default:
      return plainSpec(opts)
  }
}

/**
 * A command and its arguments. No resume, no fork, no hook wiring.
 *
 * This is not a degraded path — it is the correct one for an agent whose
 * command line we have not read. Status for these sessions comes from the
 * text-pattern triggers, which is what they were built for.
 */
function plainSpec(opts: BuildOptions): LaunchSpec {
  const args = [...opts.definition.args]
  return {
    command: [opts.bin, ...args],
    baseArgs: args,
    launchArgs: [],
    env: {},
    assignedSessionId: null,
    lifecycleLogPath: null
  }
}

/**
 * Fresh Claude sessions get an explicit `--session-id` so we can locate their
 * transcript immediately. Forked ones must not: `--fork-session` mints its own
 * id, which we learn from the first hook payload instead.
 */
function claudeSpec(opts: BuildOptions): LaunchSpec {
  const def = opts.definition
  const mode = opts.permissionMode ?? 'default'
  const launchArgs: string[] = []
  let assigned: string | null = null

  if (opts.resumeFrom && opts.forkFromParent && def.capabilities.fork) {
    // Branch the parent's real conversation into a new one.
    launchArgs.push('--resume', opts.resumeFrom, '--fork-session')
  } else if (opts.resumeFrom && def.capabilities.resume) {
    launchArgs.push('--resume', opts.resumeFrom)
  } else {
    assigned = opts.newSessionId
    launchArgs.push('--session-id', opts.newSessionId)
  }

  if (opts.model && def.capabilities.model) launchArgs.push('--model', opts.model)
  launchArgs.push(...permissionArgs(def, mode))

  // Hooks travel in a per-session settings file so the user's own
  // ~/.claude/settings.json is never touched. The bus config is a separate
  // file for the same reason: `--mcp-config` adds to the user's own MCP
  // servers rather than replacing them, and we deliberately do not pass
  // `--strict-mcp-config`, which would silence the rest of them.
  // Both files are opened by Claude, which runs on the host, so they cross the
  // boundary here rather than at the call site — the caller keeps the native
  // spelling it needs for its own `fs` work.
  const baseArgs = [...def.args, '--settings', toHostPath(opts.claudeSettingsPath)]
  if (opts.busMcp) baseArgs.push('--mcp-config', toHostPath(opts.busMcp.claudeMcpConfig))

  return {
    command: [opts.bin, ...launchArgs, ...baseArgs],
    baseArgs,
    launchArgs,
    env: {},
    assignedSessionId: assigned,
    lifecycleLogPath: null
  }
}

function codexSpec(opts: BuildOptions): LaunchSpec {
  const def = opts.definition
  const mode = opts.permissionMode ?? 'default'
  const env: Record<string, string> = {}
  const launchArgs: string[] = []

  if (opts.resumeFrom && opts.forkFromParent && def.capabilities.fork) {
    launchArgs.push('fork', opts.resumeFrom)
  } else if (opts.resumeFrom && def.capabilities.resume) {
    launchArgs.push('resume', opts.resumeFrom)
  }

  if (opts.model && def.capabilities.model) {
    launchArgs.push('-c', `model=${JSON.stringify(opts.model)}`)
  }
  if (opts.effort && def.capabilities.effort) {
    launchArgs.push('-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`)
  }
  launchArgs.push(...permissionArgs(def, mode))

  // `-c` overrides only this invocation; the user's ~/.codex/config.toml is left alone.
  const baseArgs = [
    ...def.args,
    '-c',
    `notify=${JSON.stringify([toHostPath(opts.codexNotifyShim)])}`
  ]
  if (opts.busMcp) baseArgs.push(...opts.busMcp.codexArgs)

  // Codex writes a per-process JSONL of its own TUI traffic when asked. Giving
  // each launch its own path is the only process-scoped signal Codex offers, and
  // it is what keeps two concurrent sessions from stealing each other's events.
  //
  // The path stays native in the returned spec — we are the ones who stat and
  // tail that file — and crosses to the host only in the variable Codex reads.
  const lifecycleLogPath = opts.codexSessionLogPath ?? null
  if (lifecycleLogPath) {
    env.CODEX_TUI_RECORD_SESSION = '1'
    env.CODEX_TUI_SESSION_LOG_PATH = toHostPath(lifecycleLogPath)
  }

  return {
    command: [opts.bin, ...launchArgs, ...baseArgs],
    baseArgs,
    launchArgs,
    env,
    assignedSessionId: null,
    lifecycleLogPath
  }
}

/**
 * Locates the Claude transcript for a session id. Claude stores one JSONL per
 * session under a per-project directory whose name is the cwd with separators
 * flattened; we glob rather than reimplement that slug rule.
 */
export function findClaudeTranscript(
  sessionId: string,
  home: string = hostHomeNative()
): string | null {
  const root = path.join(home, '.claude', 'projects')
  let dirs: string[]
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return null
  }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`)
    if (fs.existsSync(p)) return p
  }
  return null
}

export interface CodexRolloutCandidate {
  file: string
  /** Codex's own session id, taken from the filename and confirmed in the header. */
  sessionId: string | null
  cwd: string | null
  startedAt: number
  mtime: number
}

/** Every Codex rollout on disk, newest first. Cheap: one stat + one header read each. */
export function listCodexRollouts(
  sinceMs = 0,
  home: string = hostHomeNative()
): CodexRolloutCandidate[] {
  const root = path.join(home, '.codex', 'sessions')
  const results: CodexRolloutCandidate[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
      let mtime: number
      try {
        mtime = fs.statSync(full).mtimeMs
      } catch {
        continue
      }
      if (mtime < sinceMs) continue
      const header = readCodexRolloutHeader(full)
      results.push({
        file: full,
        sessionId: header.sessionId ?? sessionIdFromRolloutName(e.name),
        cwd: header.cwd,
        startedAt: header.startedAt ?? mtime,
        mtime
      })
    }
  }
  walk(root, 0)
  results.sort((a, b) => b.mtime - a.mtime)
  return results
}

/** Codex names rollouts `rollout-<iso>-<session-uuid>.jsonl`. */
function sessionIdFromRolloutName(name: string): string | null {
  const m = /^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    name
  )
  return m ? m[1] : null
}

/** Reads only the first `session_meta` line — rollouts can be megabytes. */
function readCodexRolloutHeader(file: string): {
  sessionId: string | null
  cwd: string | null
  startedAt: number | null
} {
  let head = ''
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const read = fs.readSync(fd, buf, 0, buf.length, 0)
      head = buf.subarray(0, read).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { sessionId: null, cwd: null, startedAt: null }
  }
  const line = head.split('\n')[0]
  if (!line?.trim()) return { sessionId: null, cwd: null, startedAt: null }
  try {
    const obj = JSON.parse(line) as { payload?: Record<string, unknown> }
    const p = obj.payload ?? {}
    const ts = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN
    return {
      sessionId: typeof p.session_id === 'string' ? p.session_id : null,
      cwd: typeof p.cwd === 'string' ? p.cwd : null,
      startedAt: Number.isFinite(ts) ? ts : null
    }
  } catch {
    return { sessionId: null, cwd: null, startedAt: null }
  }
}

/**
 * The exact rollout for a known Codex session id. This is the only fully
 * reliable lookup, and it is available as soon as the notify hook has reported
 * the thread id for a session.
 */
export function findCodexRolloutBySessionId(
  sessionId: string,
  home: string = hostHomeNative()
): string | null {
  for (const c of listCodexRollouts(0, home)) {
    if (c.sessionId === sessionId) return c.file
  }
  return null
}

/**
 * Best-effort rollout lookup for a Codex session whose id we do not know yet.
 *
 * Deliberately *not* "the newest file in the directory": a candidate must have
 * started inside this session's own lifetime, must match its working directory,
 * and must not already be claimed by another Workbench session. If several
 * survive that filter we return null rather than guess, because a wrong
 * transcript silently corrupts export, fork and handoff.
 */
export function findCodexRolloutForLaunch(opts: {
  cwd: string
  sinceMs: number
  untilMs?: number
  claimed?: Iterable<string>
  /** Explicit transcript root for isolated tooling/tests; defaults to the agent host. */
  home?: string
}): string | null {
  const claimed = new Set(opts.claimed ?? [])
  const until = opts.untilMs ?? Date.now() + 60_000
  const matches = listCodexRollouts(opts.sinceMs, opts.home).filter((c) => {
    if (claimed.has(c.file)) return false
    if (c.sessionId && claimed.has(c.sessionId)) return false
    // `c.cwd` was written by Codex on the host, so the comparison happens in
    // host spelling; callers pass the native cwd they hold everywhere else.
    if (c.cwd !== null && c.cwd !== toHostPath(opts.cwd)) return false
    return c.startedAt >= opts.sinceMs && c.startedAt <= until
  })
  if (matches.length !== 1) return null
  return matches[0].file
}

// ── Codex process-scoped lifecycle log ──────────────────────────────────────

export type CodexLogSignal =
  | { kind: 'started'; cwd: string | null; model: string | null }
  | { kind: 'turn-start'; text: string | null }
  | { kind: 'interrupted' }
  | { kind: 'approval'; reason: string | null }
  | { kind: 'approval-resolved' }
  | { kind: 'ended' }

/**
 * `app_event` variants Codex emits when it has stopped and is waiting on a
 * human decision. Use the supported event names exactly: a substring match
 * also treats PermissionResolved or SetApprovalPolicy as an open approval,
 * which converts progress and settings changes into false human-help alerts.
 * Unknown future events are not evidence; the visible approval-dialog fallback
 * remains available until that event's meaning has been verified.
 */
const APPROVAL_VARIANTS = new Set(['FullScreenApprovalRequest', 'ExecApprovalRequest', 'PatchApprovalRequest', 'TrustDirectory'])

/**
 * Parses new bytes of a Codex TUI session log into status signals.
 *
 * The log is written by the Codex process we launched, at a path only that
 * process was given, so every signal here is unambiguously about one session —
 * which is the whole point. Returns the byte offset to resume from so the
 * caller can tail the file without re-reading it.
 */
export function parseCodexSessionLog(
  file: string,
  fromByte: number
): { signals: CodexLogSignal[]; nextByte: number } {
  let size: number
  try {
    size = fs.statSync(file).size
  } catch {
    return { signals: [], nextByte: fromByte }
  }
  // Truncated or replaced (a restart rewrites the file) — start over.
  const start = size < fromByte ? 0 : fromByte
  if (size === start) return { signals: [], nextByte: start }

  let text = ''
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      const read = fs.readSync(fd, buf, 0, buf.length, start)
      text = buf.subarray(0, read).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { signals: [], nextByte: fromByte }
  }

  // Only consume whole lines; a partial tail is re-read on the next pass.
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline < 0) return { signals: [], nextByte: start }
  const consumed = text.slice(0, lastNewline + 1)

  const signals: CodexLogSignal[] = []
  for (const line of consumed.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const signal = classifyCodexLogEntry(obj)
    if (signal) signals.push(signal)
  }
  return { signals, nextByte: start + Buffer.byteLength(consumed, 'utf8') }
}

/**
 * The prompt text of a submitted Codex turn, as the TUI recorded it.
 *
 * `UserTurn.items` is a list of typed parts; only the text ones carry anything
 * we can compare against, and images contribute nothing. Returns null rather
 * than an empty string when there is no text at all, so a caller can tell
 * "no prompt recorded" from "an empty prompt".
 */
function codexTurnText(op: unknown): string | null {
  if (!op || typeof op !== 'object') return null
  const items = (op as Record<string, unknown>).items
  if (!Array.isArray(items)) return null
  const parts: string[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const text = (item as Record<string, unknown>).text
    if (typeof text === 'string' && text) parts.push(text)
  }
  return parts.length ? parts.join('\n') : null
}

/** Maps one Codex TUI session-log entry onto a status signal, or nothing. */
export function classifyCodexLogEntry(obj: Record<string, unknown>): CodexLogSignal | null {
  const kind = typeof obj.kind === 'string' ? obj.kind : ''

  if (kind === 'session_start') {
    return {
      kind: 'started',
      cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
      model: typeof obj.model === 'string' ? obj.model : null
    }
  }
  if (kind === 'session_end') return { kind: 'ended' }

  if (kind === 'op' && obj.dir === 'from_tui') {
    // A submitted turn, however the text arrived — our composer, a raw
    // keystroke, or the user typing in iTerm2 on the same tmux session.
    const payload = obj.payload
    if (payload && typeof payload === 'object') {
      const p = payload as Record<string, unknown>
      // MCP approvals use elicitation in current Codex builds. Their response
      // resumes an existing turn, so it must not record another human prompt
      // or invalidate the original turn's completion correlation.
      // Current Codex AppCommand response variants all continue the existing
      // turn. They must clear its waiting status without creating a new prompt
      // timestamp or invalidating the completion correlation for that turn.
      if (['ResolveElicitation', 'ExecApproval', 'PatchApproval', 'UserInputAnswer', 'RequestPermissionsResponse']
        .some((key) => key in p)) return { kind: 'approval-resolved' }
      for (const key of ['UserTurn', 'UserInput']) {
        if (!(key in p)) continue
        // The prompt text comes along because it is the only thing that tells
        // this turn apart from the sub-turns Codex runs on its own account —
        // see `codexTurnText` in the session manager.
        return { kind: 'turn-start', text: codexTurnText(p[key]) }
      }
    }
    return null
  }

  if (kind === 'app_event' && obj.dir === 'to_tui') {
    const variant = typeof obj.variant === 'string' ? obj.variant : ''
    if (!variant) return null
    if (APPROVAL_VARIANTS.has(variant)) return { kind: 'approval', reason: variant }
    // `StopCommitAnimation`, `TaskComplete`, and `TurnComplete` are TUI
    // presentation events. They can occur many times while a turn is still
    // running, so only the process-scoped notify hook may mark completion.
    if (variant === 'TurnAborted') return { kind: 'interrupted' }
  }
  return null
}

/**
 * Renders a conversation into plain markdown for cross-agent handoff.
 * Reading the CLI's own JSONL beats scraping the TUI, which is full of redraws.
 */
export function transcriptToMarkdown(jsonlPath: string, maxChars = 60000): string {
  const out: string[] = []
  let length = 0
  try {
    for (const line of reverseTranscriptLines(jsonlPath)) {
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const rendered = renderTranscriptEntry(obj)
      if (!rendered) continue
      length += rendered.length + (out.length ? 2 : 0)
      out.push(rendered)
      // Once the rendered tail exceeds the existing character limit, older
      // turns cannot change the result. Keep one extra character's evidence of
      // trimming so an exactly-full export still receives the correct marker
      // when an earlier rendered turn exists. Reverse/join only once, avoiding
      // repeated copies as we walk backwards through a long conversation.
      if (length > maxChars) break
    }
  } catch {
    return ''
  }
  let text = out.reverse().join('\n\n')
  if (text.length > maxChars) {
    // Keep the tail: the end of a conversation carries the live context.
    text = `…(earlier turns trimmed)…\n\n${text.slice(text.length - maxChars)}`
  }
  return text
}

/** Handles both Claude's and Codex's JSONL shapes without special-casing callers. */
function renderTranscriptEntry(obj: Record<string, unknown>): string | null {
  const type = String(obj.type ?? '')
  if (type === 'summary' || type === 'system') return null

  // Claude: { type: 'user'|'assistant', message: { role, content } }
  const message = obj.message as { role?: string; content?: unknown } | undefined
  if (message && typeof message === 'object') {
    const role = message.role ?? type
    const body = extractContent(message.content)
    if (!body.trim()) return null
    return `### ${role}\n${body.trim()}`
  }

  // Codex rollout: { type: 'response_item'|'event_msg', payload: {...} }
  const payload = obj.payload as { type?: string; role?: string; content?: unknown } | undefined
  if (payload && typeof payload === 'object') {
    if (payload.type === 'message' && payload.role) {
      const body = extractContent(payload.content)
      if (!body.trim()) return null
      return `### ${payload.role}\n${body.trim()}`
    }
  }
  return null
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    const t = String(b.type ?? '')
    if (t === 'text' || t === 'input_text' || t === 'output_text') {
      parts.push(String(b.text ?? ''))
    } else if (t === 'tool_use') {
      parts.push(`_[tool: ${String(b.name ?? 'unknown')}]_`)
    } else if (t === 'tool_result') {
      const inner = extractContent(b.content)
      if (inner) parts.push(`_[tool result]_\n${inner.slice(0, 2000)}`)
    } else if (t === 'thinking') {
      /* omit reasoning from handoffs */
    }
  }
  return parts.join('\n')
}

/**
 * The last thing the agent *said*, as opposed to did.
 *
 * A relay hands this straight to another agent as its prompt, so tool calls and
 * results are deliberately skipped: the caller asked a question and needs the
 * answer, not a replay of how it was reached. Reads the file backwards because
 * a long session's transcript is megabytes and only the tail matters.
 */
export function lastAssistantMessage(jsonlPath: string): string | null {
  try {
    for (const line of reverseTranscriptLines(jsonlPath)) {
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const body = assistantBody(obj)
      if (body) return body
    }
  } catch {
    return null
  }
  return null
}

/** Assistant prose from one transcript entry, in either CLI's shape. */
function assistantBody(obj: Record<string, unknown>): string | null {
  const message = obj.message as { role?: string; content?: unknown } | undefined
  if (message && typeof message === 'object' && message.role === 'assistant') {
    const text = extractContent(message.content)
    return textOnly(text)
  }
  const payload = obj.payload as { type?: string; role?: string; content?: unknown } | undefined
  if (payload && typeof payload === 'object' && payload.type === 'message') {
    if (payload.role === 'assistant') return textOnly(extractContent(payload.content))
  }
  return null
}

/**
 * Rejects an entry whose only content was a tool call.
 *
 * `extractContent` renders those as `_[tool: Bash]_` placeholders, which are
 * true but useless as an answer — returning one would end a relay with the
 * sender being told its question was answered with "_[tool: Read]_".
 */
function textOnly(text: string): string | null {
  const stripped = text
    .replace(/^_\[tool:[^\]]*\]_$/gm, '')
    .replace(/^_\[tool result\]_$/gm, '')
    .trim()
  return stripped ? stripped : null
}
