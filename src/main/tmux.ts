/**
 * tmux backend.
 *
 * Every Workbench session is a real tmux session living on a private tmux socket
 * (`-L terminal`). That is what buys us the tmux selling points for free:
 *   - agents keep running when Workbench is closed, and reattach on relaunch
 *   - `tmux -L terminal attach -t <name>` works from iTerm2 or any terminal
 *   - scrollback, copy mode and pane plumbing are tmux's problem, not ours
 *
 * The private socket keeps our sessions out of the user's default tmux server so
 * we never disturb their own tmux work.
 */

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

import { hostKind, hostSpawn, hostSpawnEnv, toHostPath } from './host.js'

const execFileAsync = promisify(execFile)

/**
 * These two names are load-bearing, and neither follows the app's name.
 *
 * They are how a session that outlived the app is found again: sessions live on
 * this socket, and we adopt the ones whose name carries this prefix. Renaming
 * either — to match a new product name, say — makes every session that is
 * running at that moment invisible to us forever. They keep running, holding
 * their working trees, with nothing left that knows how to reach them.
 *
 * Nobody sees these strings, so there is no reason to ever change them.
 */
export const TMUX_SOCKET = 'terminal'

/**
 * Carries the pane's PATH past tmux, which will not let `-e` set PATH itself.
 *
 * Deliberately not a name anything else reads: the pane exports it over PATH
 * and unsets it before the agent starts, so it exists for one line of shell.
 */
export const PANE_PATH_VAR = 'WORKBENCH_PANE_PATH'

/**
 * Prefix marking a tmux session as ours.
 *
 * A constant rather than a literal because two things depend on it agreeing
 * with itself: we only adopt orphaned sessions whose name starts with it, and
 * we recover the session id by cutting it back off. A hand-written offset gets
 * these out of step the moment the prefix changes length, and the symptom —
 * sessions silently not adopted after a restart — looks nothing like the cause.
 */
export const TMUX_PREFIX = 'term_'

/** The tmux session name for one of our sessions. */
export function tmuxNameFor(sessionId: string): string {
  return `${TMUX_PREFIX}${sessionId}`
}

/** The session id inside one of our tmux names, or null if it is not ours. */
export function sessionIdFromTmuxName(name: string): string | null {
  return name.startsWith(TMUX_PREFIX) ? name.slice(TMUX_PREFIX.length) : null
}

/**
 * Field separator for `-F` format strings.
 *
 * Must be *printable*. tmux sanitises non-printable bytes in format output when
 * it is not in UTF-8 mode, rewriting them to "_" — and a GUI-launched macOS app
 * inherits no locale at all. A control-character separator (we used \x1f) then
 * comes back mangled, every field of every pane fuses into one string, and the
 * liveness poll concludes that every running session has exited. Printable
 * ASCII survives any locale, and this token cannot realistically occur in a
 * path or a command name.
 */
const SEP = '<|wb|>'

export interface TmuxPaneInfo {
  sessionName: string
  windowId: string
  paneId: string
  pid: number
  dead: boolean
  deadStatus: number | null
  width: number
  height: number
  currentPath: string
  currentCommand: string
  activityAt: number
}

/** The `-F` fields every pane query requests, in the order `paneFromFields` reads them. */
const PANE_FIELDS = [
  '#{session_name}',
  '#{window_id}',
  '#{pane_id}',
  '#{pane_pid}',
  '#{pane_dead}',
  '#{pane_dead_status}',
  '#{pane_width}',
  '#{pane_height}',
  '#{pane_current_path}',
  '#{pane_current_command}',
  '#{session_activity}'
]

function paneFromFields(f: string[]): TmuxPaneInfo {
  return {
    sessionName: f[0],
    windowId: f[1],
    paneId: f[2],
    pid: Number(f[3]) || 0,
    dead: f[4] === '1',
    deadStatus: f[5] === '' ? null : Number(f[5]),
    width: Number(f[6]) || 0,
    height: Number(f[7]) || 0,
    currentPath: f[8] ?? '',
    currentCommand: f[9] ?? '',
    activityAt: (Number(f[10]) || 0) * 1000
  }
}

/**
 * tmux only emits non-printable bytes verbatim, and only renders pane content
 * correctly, when its character type is UTF-8. A GUI-launched macOS app
 * inherits no locale, so supply one unless the environment already picks UTF-8.
 */
/**
 * The locale fix, expressed as overrides rather than a whole environment.
 *
 * `tmuxEnv` below can hand a local spawn the entire process environment, but a
 * WSL host takes its variables as arguments, and copying hundreds of Windows
 * variables across that boundary would be both pointless and wrong.
 *
 * It returns nothing at all on a WSL host, deliberately. The problem this
 * solves is specific to macOS — a GUI-launched app inherits no locale, tmux
 * drops out of UTF-8 mode, and the printable format separator comes back
 * mangled. Inside WSL the distro's own login environment is already correct,
 * and `process.env` here is the *Windows* environment, which never carries
 * LC_*. Reading it would conclude "no UTF-8" on every call and force a locale
 * the distro may not even have generated.
 */
function tmuxLocale(): { env: Record<string, string>; unset: string[] } {
  if (hostKind() === 'wsl') return { env: {}, unset: [] }
  const env = process.env
  const utf8 = (v?: string): boolean => !!v && /utf-?8/i.test(v)
  if (utf8(env.LC_ALL) || utf8(env.LC_CTYPE) || utf8(env.LANG)) return { env: {}, unset: [] }
  return { env: { LC_CTYPE: 'en_US.UTF-8' }, unset: ['LC_ALL'] }
}

function tmuxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const utf8 = (v?: string): boolean => !!v && /utf-?8/i.test(v)
  if (utf8(env.LC_ALL) || utf8(env.LC_CTYPE) || utf8(env.LANG)) return env
  // LC_ALL outranks LC_CTYPE, so a non-UTF-8 LC_ALL has to go for it to take.
  delete env.LC_ALL
  env.LC_CTYPE = 'en_US.UTF-8'
  return env
}

export class TmuxError extends Error {
  readonly stderr: string

  constructor(message: string, stderr = '') {
    super(message)
    this.name = 'TmuxError'
    this.stderr = stderr
  }
}

/**
 * Whether a failed tmux call failed because there is no server at all.
 *
 * Worth separating from every other tmux failure because it is the one case
 * that is *evidence* rather than an outage: a tmux server holds every pane it
 * ever started, so if the server is gone, so is all of them. Any other error —
 * a timeout, a bad format, a socket we could not read — tells us nothing about
 * what is still alive, and acting on it would mark healthy sessions dead.
 *
 * tmux words this two ways depending on whether the socket file is merely
 * unattended or missing outright, so both are matched.
 */
export function serverIsGone(err: unknown): boolean {
  if (!(err instanceof TmuxError)) return false
  const text = `${err.stderr} ${err.message}`
  return text.includes('no server running') || text.includes('error connecting to')
}

export class Tmux {
  /** Absolute path to the tmux binary; resolved once at startup. */
  private bin: string
  private confPath: string
  private ready = false

  constructor(bin: string, confPath: string) {
    this.bin = bin
    this.confPath = confPath
  }

  get binary(): string {
    return this.bin
  }

  /**
   * The command a user can paste into iTerm2 to take over a session directly.
   * Surfaced in the UI because "you are not locked in" is the whole point of
   * building on tmux instead of owning the PTYs ourselves.
   *
   * On Windows the terminal the user will paste this into is PowerShell or
   * cmd, which is on the far side of the boundary from the tmux server. A bare
   * `tmux …` there is not a command at all. `hostSpawn` already knows how this
   * process crosses over, so the pasted line is the same crossing spelled out
   * — and on macOS and Linux it flattens back to exactly the string it always
   * was, because a local host adds nothing.
   */
  attachCommandFor(sessionName: string): string {
    const spawn = hostSpawn([this.bin, '-L', TMUX_SOCKET, 'attach', '-t', sessionName])
    return [spawn.file, ...spawn.args].join(' ')
  }

  /**
   * Writes the tmux.conf our private server boots with. Only read when the server
   * starts, so changes need a server restart (or `source-file`) to take effect.
   */
  writeConfig(scrollback: number): void {
    const conf = [
      '# Generated by Workbench. Edit at your own risk; regenerated on launch.',
      'set -g status off',
      'set -g mouse on',
      `set -g history-limit ${Math.max(1000, scrollback)}`,
      'set -sg escape-time 0',
      'set -g focus-events on',
      'set -g allow-passthrough on',
      // Follow the most recently active client instead of shrinking to the
      // smallest one — matters when the user also attaches from iTerm2.
      'set -g window-size latest',
      'set -g aggressive-resize on',
      // Keep dead panes around so the final output and exit code stay readable.
      'set -g remain-on-exit on',
      'set -g destroy-unattached off',
      'set -g default-terminal tmux-256color',
      "set -ga terminal-overrides ',*256col*:Tc'",
      'set -g set-titles off',
      'setw -g automatic-rename off',
      'setw -g mode-keys vi',
      ''
    ].join('\n')
    fs.mkdirSync(path.dirname(this.confPath), { recursive: true })
    fs.writeFileSync(this.confPath, conf, 'utf8')
  }

  private baseArgs(): string[] {
    // The conf path is written by us and read by tmux, so it is one of the few
    // strings that has to exist in both spellings — native above, host here.
    return ['-L', TMUX_SOCKET, '-f', toHostPath(this.confPath)]
  }

  /** Run a tmux command against our private server. */
  async run(args: string[]): Promise<string> {
    const locale = tmuxLocale()
    const spawn = hostSpawn([this.bin, ...this.baseArgs(), ...args], {
      env: locale.env,
      unsetEnv: locale.unset
    })
    try {
      const { stdout } = await execFileAsync(spawn.file, spawn.args, {
        maxBuffer: 32 * 1024 * 1024,
        env: hostSpawnEnv(tmuxEnv()),
        windowsHide: true
      })
      return stdout
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string }
      throw new TmuxError(
        `tmux ${args.join(' ')} failed: ${e.stderr?.trim() || e.message || 'unknown error'}`,
        e.stderr ?? ''
      )
    }
  }

  /** Same as run(), but swallows failures — for best-effort cleanup paths. */
  async tryRun(args: string[]): Promise<string | null> {
    try {
      return await this.run(args)
    } catch {
      return null
    }
  }

  async version(): Promise<string | null> {
    const spawn = hostSpawn([this.bin, '-V'])
    try {
      const { stdout } = await execFileAsync(spawn.file, spawn.args, { windowsHide: true })
      return stdout.trim()
    } catch {
      return null
    }
  }

  /** Boots the server if it is not already up, and applies our config. */
  async ensureServer(): Promise<void> {
    if (this.ready) return
    const running = await this.tryRun(['list-sessions', '-F', '#{session_name}'])
    if (running === null) {
      // No server yet. `start-server` reads our -f config file.
      await this.tryRun(['start-server'])
    }
    this.ready = true
  }

  async hasSession(name: string): Promise<boolean> {
    const out = await this.tryRun(['has-session', '-t', `=${name}`])
    return out !== null
  }

  async listSessionNames(): Promise<string[]> {
    const out = await this.tryRun(['list-sessions', '-F', '#{session_name}'])
    if (!out) return []
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  /**
   * Creates a detached tmux session running `command`.
   * `env` is injected with `-e`, which is how the CLI hook scripts learn which
   * Workbench session they belong to and where to phone home.
   */
  async createSession(opts: CreateSessionArgs): Promise<void> {
    await this.ensureServer()
    await this.run(createSessionArgs(opts))
  }

  /**
   * Streams the pane's raw output to a file. This is our session log (the iTerm2
   * "automatic session logging" feature) and the input to regex triggers.
   * `-o` toggles off if already piping, so we stop first to stay idempotent.
   */
  async startPipePane(name: string, logPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    await this.tryRun(['pipe-pane', '-t', `${name}.0`])
    // Quote for the shell tmux spawns to run this command. The redirect target
    // is opened by that shell, on the host, so it is the host spelling — we
    // created the directory a line above through the native one.
    const target = toHostPath(logPath)
    await this.tryRun(['pipe-pane', '-t', `${name}.0`, `cat >> '${target.replace(/'/g, "'\\''")}'`])
  }

  async stopPipePane(name: string): Promise<void> {
    await this.tryRun(['pipe-pane', '-t', `${name}.0`])
  }

  /** Plain-text scrollback — used for transcript fallback and status heuristics. */
  async capturePane(name: string, lines = 2000): Promise<string> {
    const out = await this.tryRun([
      'capture-pane',
      '-p',
      '-J',
      '-S',
      `-${Math.max(1, lines)}`,
      '-t',
      `${name}.0`
    ])
    return out ?? ''
  }

  /** The last `n` non-empty lines currently on screen. */
  async captureTail(name: string, n = 40): Promise<string> {
    const text = await this.capturePane(name, 200)
    const lines = text.split('\n')
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    return lines.slice(-n).join('\n')
  }

  async paneInfo(name: string): Promise<TmuxPaneInfo | null> {
    const out = await this.tryRun(['list-panes', '-t', `=${name}`, '-F', PANE_FIELDS.join(SEP)])
    if (!out) return null
    const line = out.split('\n').find((l) => l.trim())
    if (!line) return null
    const f = line.split(SEP)
    if (f.length < PANE_FIELDS.length) return null
    return paneFromFields(f)
  }

  /**
   * One round-trip snapshot of every pane, so polling stays cheap.
   *
   * Throws rather than returning an empty map when tmux cannot be queried or
   * its output cannot be parsed. An empty map means "no panes exist", which the
   * caller reads as "everything died" — so a failed query must never be able to
   * masquerade as one.
   */
  async allPaneInfo(): Promise<Map<string, TmuxPaneInfo>> {
    const out = await this.run(['list-panes', '-a', '-F', PANE_FIELDS.join(SEP)])
    const map = new Map<string, TmuxPaneInfo>()
    let seen = 0
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      seen++
      const f = line.split(SEP)
      if (f.length < PANE_FIELDS.length) continue
      if (map.has(f[0])) continue // first pane of each session wins
      map.set(f[0], paneFromFields(f))
    }
    if (seen > 0 && map.size === 0) {
      throw new TmuxError(`list-panes returned ${seen} unparseable line(s)`, '')
    }
    return map
  }

  /**
   * Drops a pane out of copy mode before we type into it.
   *
   * `mouse on` means a scroll wheel over a pane puts tmux into copy mode, and
   * copy mode consumes keys as its own commands instead of passing them to the
   * program underneath. A prompt sent to a pane in copy mode is therefore eaten
   * — the agent never sees a character of it.
   *
   * The reason this is worth a round trip on every send: `send-keys` still
   * exits 0, so nothing upstream can tell the difference. The composer clears,
   * the session goes to `working`, and the turn simply never happens. That is
   * indistinguishable from the agent ignoring you, and the only clue the user
   * gets is tmux's own copy-mode indicator sitting in the corner of the pane.
   *
   * `if-shell -F` evaluates the format inside the server, so this is one exec
   * that does nothing at all on a pane that was never in a mode. Cancelling is
   * also what the user meant: they scrolled up to read, and are now typing.
   *
   * Best-effort by design — `tryRun` keeps a failure here from masking the real
   * error that the `send-keys` below is about to report on a dead pane.
   */
  private async leaveCopyMode(name: string): Promise<void> {
    await this.tryRun([
      'if-shell',
      '-F',
      '-t',
      `${name}.0`,
      '#{pane_in_mode}',
      `send-keys -t ${name}.0 -X cancel`
    ])
  }

  /**
   * Types text into a pane without going through our attached client.
   * `-l` sends the text literally so prompt content is never interpreted as keys.
   */
  async sendText(name: string, text: string): Promise<void> {
    if (text.length === 0) return
    await this.leaveCopyMode(name)
    await this.run(['send-keys', '-t', `${name}.0`, '-l', '--', text])
  }

  /**
   * Sends named keys (Enter, C-c, Escape, …).
   *
   * Cancels copy mode for the same reason `sendText` does, and not only because
   * `submitPrompt` already did: the wheel is faster than the beat between the
   * text and its Enter, so a scroll landing in that gap would strand a prompt
   * that is already typed into the pane.
   */
  async sendKeys(name: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return
    await this.leaveCopyMode(name)
    await this.run(['send-keys', '-t', `${name}.0`, ...keys])
  }

  /** Paste-safe submit: literal text, a beat, then Enter. */
  async submitPrompt(name: string, text: string, delayMs = 40): Promise<void> {
    await this.sendText(name, text)
    await new Promise((r) => setTimeout(r, delayMs))
    await this.sendKeys(name, ['Enter'])
  }

  async resize(name: string, cols: number, rows: number): Promise<void> {
    await this.tryRun([
      'resize-window',
      '-t',
      `=${name}`,
      '-x',
      String(Math.max(20, cols)),
      '-y',
      String(Math.max(5, rows))
    ])
  }

  /** Restart a dead pane in place, preserving the session and its name. */
  async respawn(name: string, command: string[], cwd: string): Promise<void> {
    await this.run([
      'respawn-pane',
      '-k',
      '-t',
      `${name}.0`,
      '-c',
      toHostPath(cwd),
      '--',
      ...command
    ])
  }

  async killSession(name: string): Promise<void> {
    await this.tryRun(['kill-session', '-t', `=${name}`])
  }

  async killServer(): Promise<void> {
    await this.tryRun(['kill-server'])
  }
}

/**
 * Locates tmux on the host.
 *
 * Asking a login shell is the only approach that finds every real install:
 * the hardcoded list below knows about Homebrew and the system prefix, and
 * knows nothing about nix, linuxbrew, asdf, pkgsrc or a hand-built tmux in
 * ~/bin. It is kept as a fallback for the case where the probe itself cannot
 * run, which is a different failure from tmux being absent.
 *
 * On a WSL host there is no fallback list worth having — a POSIX path tested
 * against the *Windows* filesystem is meaningless, and `X_OK` does not
 * discriminate there anyway (Node degrades it to `F_OK`). If the login shell
 * cannot answer, the honest result is "not found".
 */
export function resolveTmuxBinary(): string | null {
  try {
    const { file, args } = hostSpawn(['sh', '-lc', 'command -v tmux 2>/dev/null'])
    const out = execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    // A login shell is entitled to print a banner first; take the last line
    // that looks like an absolute path rather than assuming clean output.
    const hit = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/'))
      .pop()
    if (hit) return hit
  } catch {
    /* fall through to the fixed candidates */
  }
  if (hostKind() === 'wsl') return null
  const candidates = [
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
    '/opt/local/bin/tmux'
  ]
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {
      /* keep looking */
    }
  }
  return null
}


export interface CreateSessionArgs {
  name: string
  cwd: string
  command: string[]
  env: Record<string, string>
  cols: number
  rows: number
}

/**
 * Builds the `new-session` argv. Pure, so the PATH handling below can be
 * tested without a tmux server.
 *
 * PATH is the one variable `-e` cannot deliver, and it fails silently, which is
 * what made this expensive to find. tmux stores the value in the session
 * environment — `show-environment` prints back exactly the PATH you asked for —
 * and then ignores it when spawning the pane. Measured on tmux 3.7c:
 *
 *   client PATH   -e PATH      pane PATH
 *   bare          (none)       bare
 *   bare          full         bare      <- -e had no effect
 *   full          (none)       full
 *   full          bare         full      <- -e had no effect
 *
 * The pane copies PATH from the *client* process that ran `new-session`, and
 * our client is Electron. An app opened from the Dock is started by launchd,
 * which hands it `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — no
 * Homebrew. (Open the same app from a terminal and it inherits that shell's
 * PATH instead, so this breaks only for the way people actually launch it.)
 *
 * A binary launched by absolute path does not care, which is why `claude`, a
 * Mach-O executable, was always fine. `codex` is a `#!/usr/bin/env node`
 * script, so `env` searched that stunted PATH, found no node, and the pane died
 * with `env: node: No such file or directory` and status 127 — indistinguishable
 * from a broken Codex install. Every child an agent spawns by name had the same
 * problem for the same reason: `docker` for an MCP server, `git`, `rg`.
 *
 * So the PATH rides in under a name tmux does not police, and a one line `sh`
 * prologue puts it back before handing over. Fixing Electron's own PATH would
 * also work, but only until something else spawns a client; this holds
 * regardless of what environment the `new-session` call is made from.
 *
 * `exec` means no extra process and no swallowed exit status: the pane still
 * reports exactly what the agent returned.
 */
export function createSessionArgs(opts: CreateSessionArgs): string[] {
  const panePath = opts.env.PATH
  const envArgs: string[] = []
  for (const [k, v] of Object.entries(opts.env)) {
    envArgs.push('-e', `${k}=${v}`)
  }

  let command = opts.command
  if (panePath) {
    // Kept alongside the -e PATH above: that one is inert for the pane but
    // still what a manually opened window in this session inherits.
    envArgs.push('-e', `${PANE_PATH_VAR}=${panePath}`)
    command = [
      '/bin/sh',
      '-c',
      `export PATH="$${PANE_PATH_VAR}"; unset ${PANE_PATH_VAR}; exec "$@"`,
      // $0 for the prologue. Never used, but sh needs it before "$@" starts.
      'workbench',
      ...opts.command
    ]
  }

  return [
    'new-session',
    '-d',
    '-s',
    opts.name,
    '-x',
    String(Math.max(20, opts.cols)),
    '-y',
    String(Math.max(5, opts.rows)),
    '-c',
    toHostPath(opts.cwd),
    ...envArgs,
    '--',
    ...command
  ]
}
