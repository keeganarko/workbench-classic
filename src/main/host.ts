/**
 * Where session work actually runs.
 *
 * On macOS and Linux the answer is "here". tmux, the agents, the hook shims and
 * the MCP bus all live in the same filesystem Workbench does, "run a command"
 * means spawn it, and this module is a pass-through that costs nothing.
 *
 * On Windows the answer is "inside WSL", and that is a deliberate architectural
 * choice rather than a fallback. `docs/windows-native-audit.md` walks the
 * alternative: tmux is not an implementation detail in this app, it is the
 * substrate. Session creation, adoption after a restart, scrollback, per-session
 * logging, keystroke injection, resize and the PTY the renderer draws all route
 * through it, and every one of those properties exists *because* the agent is
 * parented by a server that outlives the app. Reimplement the session layer on
 * ConPTY and you have not ported Workbench, you have written a worse one: the
 * agents die with the window, and `tmux attach` from another terminal — the
 * escape hatch that makes the whole model trustworthy — stops meaning anything.
 *
 * So Windows does not get a different session layer. It gets the *same* session
 * layer, running where it already works, driven across the interop boundary.
 * The visible half of the app is a real Win32 process with a real taskbar
 * button, a real tray icon and real toasts; everything from tmux down stays on
 * the Linux side, next to the `claude` and `codex` installs that are already
 * there and already authenticated.
 *
 * That leaves this module with exactly three questions to answer:
 *
 *   1. How do I turn an argv meant for the host into something spawnable here?
 *   2. What does a path look like on the other side of the boundary?
 *   3. Which of the two filesystems does a given artifact belong in?
 *
 * The third is the one that bites. Two facts about this boundary, both measured
 * on a stock WSL 2 install rather than assumed, decide the layout:
 *
 *   - **WSL cannot write into the Windows user profile.** `C:\Users\<user>`
 *     and everything under it, `AppData` included, comes back EACCES. So
 *     anything the host has to *execute* — hook shims, the bus script, the
 *     generated tmux.conf — cannot live in Electron's `userData`.
 *   - **Windows can read and write the WSL filesystem** over
 *     `\\wsl.localhost\<distro>\…`: read, write, mkdir and stat all work.
 *     Only `fs.watch` on a directory fails (EISDIR, the 9p driver has no
 *     directory change notifications) — which costs us nothing, because the
 *     preview pane already polls with `watchFile` by design.
 *
 * Those two together give one rule: **host-executable artifacts live on the
 * host, and Windows reaches them over UNC.** Everything else — the store, the
 * crash log, attachment blobs, anything only the Electron process ever opens —
 * stays in `userData` where Electron put it.
 *
 * One more consequence worth stating plainly, because it removes a whole
 * section of the audit: the host is POSIX on every platform. The `/bin/sh`
 * pane prologue, the `#!/bin/sh` shims, `chmod 0755`, colon-joined PATH and
 * POSIX quoting in `pipe-pane` were never Windows bugs. They were only bugs
 * under the assumption that the session layer runs on Win32, and it does not.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type HostKind = 'local' | 'wsl'

/**
 * Escape hatch for a machine with several distros, or one where the default is
 * not the one holding the agents. Read once, at first use.
 */
const DISTRO_OVERRIDE = 'WORKBENCH_WSL_DISTRO'

/** Where the host is, relative to the process asking. */
export function hostKind(): HostKind {
  return process.platform === 'win32' ? 'wsl' : 'local'
}

/**
 * Details of the WSL side, learned once and cached.
 *
 * Both fields have to come from inside the distro. The name is needed to build
 * `\\wsl.localhost\<name>\…` UNC paths, and it must be the name of whichever
 * distro we are actually going to run in — so we ask that distro what it is
 * called rather than parsing `wsl.exe -l`, whose output is UTF-16 with a
 * "(Default)" marker that is localised. The drive mount root is `/mnt` on a
 * stock install but `/etc/wsl.conf` can move it, and every Windows-path
 * translation depends on knowing it.
 */
export interface WslInfo {
  distro: string
  mountRoot: string
}

let cachedInfo: WslInfo | null = null
let probeFailed: string | null = null

/**
 * Asks the distro about itself.
 *
 * Deliberately one call: `wsl.exe` startup is the expensive part (it may have
 * to boot the VM), and two probes would pay it twice on a cold machine.
 */
export function probeWsl(): WslInfo | null {
  if (cachedInfo) return cachedInfo
  if (probeFailed !== null) return null
  try {
    const argv = ['-e', 'sh', '-c', 'printf %s "$WSL_DISTRO_NAME"; printf "\\n"; wslpath -u "C:\\\\"']
    const distroArg = process.env[DISTRO_OVERRIDE]
    if (distroArg) argv.unshift('-d', distroArg)
    const out = execFileSync('wsl.exe', argv, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const [name, cRoot] = out.split('\n').map((l) => l.trim())
    if (!name) throw new Error('the distro did not report a name')
    // `wslpath -u 'C:\'` answers "/mnt/c/"; the mount root is its parent.
    const mountRoot = cRoot ? path.posix.dirname(cRoot.replace(/\/+$/, '')) : '/mnt'
    cachedInfo = { distro: distroArg || name, mountRoot: mountRoot || '/mnt' }
    return cachedInfo
  } catch (err) {
    probeFailed = err instanceof Error ? err.message : String(err)
    return null
  }
}

/** Why the WSL probe failed, for an error the user can act on. */
export function wslProbeError(): string | null {
  return probeFailed
}

/** The distro sessions run in, or null when the host is this machine. */
export function hostDistro(): string | null {
  return hostKind() === 'wsl' ? (probeWsl()?.distro ?? null) : null
}

// ── path translation ───────────────────────────────────────────────────────
//
// Pure functions taking their configuration explicitly, so the mapping can be
// tested without a WSL install and without shelling out. `wslpath` is the
// reference implementation of exactly this, but calling it is a subprocess per
// path, and paths get translated on every session poll.

/** A Windows path as the host sees it. Absolute input, absolute POSIX output. */
export function windowsToHostPath(p: string, info: WslInfo): string {
  const win = p.replace(/\//g, '\\')
  // \\wsl.localhost\Distro\home\x and the older \\wsl$\Distro\home\x both name
  // a path that is already native to the host — strip the prefix, do not mount.
  const unc = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\?(.*)$/i.exec(win)
  if (unc) return '/' + unc[2].replace(/\\/g, '/')
  const drive = /^([A-Za-z]):\\?(.*)$/.exec(win)
  if (drive) {
    const rest = drive[2].replace(/\\/g, '/')
    return path.posix.join(info.mountRoot, drive[1].toLowerCase(), rest)
  }
  // Already POSIX-shaped (or relative): hand it back untouched rather than
  // inventing a mount point for it.
  return p.replace(/\\/g, '/')
}

/** A host path as Windows sees it. */
export function hostToWindowsPath(p: string, info: WslInfo): string {
  // Idempotent on anything already Windows-shaped, because one caller — the
  // `/preview/show` route — takes its argument from a CLI that may have
  // resolved it on either side of the boundary. Without this guard a UNC path
  // normalises to a leading-slash string, misses the mount-root test below,
  // and gets the UNC prefix stapled on a second time.
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) return p
  const posix = p.replace(/\\/g, '/')
  const mounted = new RegExp(`^${escapeRe(info.mountRoot)}/([a-zA-Z])(?:/(.*))?$`).exec(posix)
  if (mounted) {
    const rest = (mounted[2] ?? '').replace(/\//g, '\\')
    return `${mounted[1].toUpperCase()}:\\${rest}`
  }
  if (!posix.startsWith('/')) return p
  return `\\\\wsl.localhost\\${info.distro}\\${posix.slice(1).replace(/\//g, '\\')}`
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * Every path held in JavaScript is a *native* path: the spelling this process
 * can hand to `fs`. On macOS and Linux that is the only spelling there is. On
 * Windows it is `C:\…` for a Windows directory and
 * `\\wsl.localhost\<distro>\…` for one inside the distro.
 *
 * Convert with `toHostPath()` at the exact moment a path crosses into the host
 * — a tmux argv, a `pipe-pane` redirect, a hook command written into an agent's
 * config, a trust-record key. Never convert on the way back in; a path that
 * came from the host gets `toNativePath()` once, at the boundary, and is native
 * from then on.
 *
 * Both directions are the identity function when the host is local, so the rule
 * costs nothing on the platforms where there is no boundary.
 */
export function toHostPath(p: string): string {
  if (hostKind() === 'local') return p
  const info = probeWsl()
  return info ? windowsToHostPath(p, info) : p
}

/** A host path, as this process should open it. */
export function toNativePath(p: string): string {
  if (hostKind() === 'local') return p
  const info = probeWsl()
  return info ? hostToWindowsPath(p, info) : p
}

// ── running commands ───────────────────────────────────────────────────────

export interface HostSpawn {
  file: string
  args: string[]
  /** Only ever set on a local host; WSL takes its cwd as an argument instead. */
  cwd?: string
}

export interface HostSpawnOptions {
  /** Working directory, given as a *host* path. */
  cwd?: string
  /**
   * Environment for the command, on the host side.
   *
   * This cannot be done with the spawn options on Windows: the WSL boundary
   * does not forward the parent environment (that needs WSLENV, which is a
   * colon-delimited list of names and a second thing to keep in sync). Passing
   * `env K=V -- cmd` puts the variables where they are actually read, with no
   * shell in the path to requote anything.
   */
  env?: Record<string, string>
  /** Host variables to remove before the command runs. */
  unsetEnv?: string[]
}

/**
 * Turns an argv meant for the host into something spawnable from this process.
 *
 * `wsl.exe -e` is an exec, not a shell: the arguments after it are the child's
 * argv, passed through verbatim. That fidelity was measured rather than assumed
 * — spaces, double quotes, backslashes, `$`, backticks, semicolons, the
 * `export PATH="$WORKBENCH_PANE_PATH"; exec "$@"` pane prologue and tmux
 * `#{pane_in_mode}` format strings all survive the round trip byte for byte —
 * which is why nothing here has to smuggle payloads through base64 or quote
 * for a shell that is not there.
 */
export function hostSpawn(argv: string[], opts: HostSpawnOptions = {}): HostSpawn {
  const sets = Object.entries(opts.env ?? {})
  const unsets = opts.unsetEnv ?? []
  const withEnv = sets.length > 0 || unsets.length > 0
  if (hostKind() === 'local') {
    return { file: argv[0], args: argv.slice(1), cwd: opts.cwd }
  }
  const pre: string[] = []
  const distro = hostDistro()
  if (distro) pre.push('-d', distro)
  if (opts.cwd) pre.push('--cd', opts.cwd)
  const cmd = withEnv
    ? [
        'env',
        ...unsets.flatMap((k) => ['-u', k]),
        ...sets.map(([k, v]) => `${k}=${v}`),
        ...argv
      ]
    : argv
  return { file: 'wsl.exe', args: [...pre, '-e', ...cmd] }
}

/**
 * The environment a *locally* spawned child should get.
 *
 * On a WSL host the caller's POSIX-shaped environment is meaningless to
 * `wsl.exe` and must not be smeared onto it — the variables travel as arguments
 * (see `hostSpawn`) instead. Everything the Windows process itself needs is
 * already inherited.
 */
export function hostSpawnEnv(
  hostEnv: Record<string, string | undefined>
): Record<string, string | undefined> {
  return hostKind() === 'local' ? hostEnv : process.env
}

// ── where things live ──────────────────────────────────────────────────────

/**
 * The host-side directory for artifacts the host must read or execute.
 *
 * On a local host this is `userData` and nothing moves. On Windows it has to be
 * inside the distro, because WSL cannot write to `%APPDATA%` at all — so it
 * follows the XDG convention the agents themselves use, and Windows reaches it
 * over UNC when it needs to write a shim.
 *
 * Returned as a *native* path — the spelling this process hands to `fs` — in
 * keeping with the rule above. Call `toHostPath` on anything derived from it
 * that the host itself has to open.
 */
export function hostDataDir(userData: string): string {
  if (hostKind() === 'local') return userData
  const info = probeWsl()
  // No distro to put it in. `%APPDATA%` is wrong for anything the host has to
  // execute, but the app has bigger problems at that point and a data dir it
  // can write beats refusing to start.
  if (!info) return userData
  return hostToWindowsPath(`/home/${hostUser()}/.config/Workbench`, info)
}

let cachedUser: string | null = null

/** The account name on the host side. */
export function hostUser(): string {
  if (hostKind() === 'local') return os.userInfo().username
  if (cachedUser) return cachedUser
  try {
    const { file, args } = hostSpawn(['sh', '-c', 'printf %s "$(id -un)"'])
    cachedUser = execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    }).trim()
    return cachedUser || 'user'
  } catch {
    return 'user'
  }
}

/**
 * What to tell the user when the host is not usable.
 *
 * The old text said `brew install tmux` on every platform that was not Linux,
 * which is the first thing a Windows launch would have shown. What a Windows
 * user actually needs is either "turn on WSL" or "install tmux in the distro
 * you already have", and those are different sentences.
 */
export function installHint(tool: string): string {
  if (hostKind() === 'wsl') {
    if (!probeWsl()) {
      return `Workbench runs its sessions inside WSL. Open PowerShell as Administrator and run:\n\n    wsl --install\n\nthen restart Windows and start Workbench again.`
    }
    const distro = hostDistro() ?? 'your distro'
    return `${tool} is not installed in ${distro}. Open it and run:\n\n    sudo apt install ${tool}`
  }
  if (process.platform === 'linux') return `sudo apt install ${tool}`
  return `brew install ${tool}`
}

/**
 * A binary on *this* process's PATH, rather than the host's.
 *
 * Nearly everything Workbench runs belongs on the host, and `findExecutable` in
 * `agents.ts` is the function for that. This is the exception, and there is
 * only one: `cloudflared` has to dial the share server's `127.0.0.1` listener,
 * and that listener belongs to this process. WSL 2 is NAT'd by default, so
 * loopback is not shared between the two sides — a cloudflared started inside
 * the distro would connect to a port that is not there and the share link would
 * hang forever on a tunnel that never reaches anything.
 */
export function findNativeExecutable(name: string): string | null {
  const win = process.platform === 'win32'
  // PATHEXT is why a bare `cloudflared` runs at a Windows prompt but is invisible
  // to `existsSync`: the extension is implied by the shell, never typed.
  const exts = win ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        // `X_OK` is a real question on POSIX and a no-op on Windows, where Node
        // silently degrades it to `F_OK`. Asking it there would make every
        // readable file look like a binary, so the extension list carries that
        // weight instead.
        fs.accessSync(candidate, win ? fs.constants.F_OK : fs.constants.X_OK)
        return candidate
      } catch {
        /* next candidate */
      }
    }
  }
  return null
}

/**
 * Whether a host path names an existing file, optionally an executable one.
 *
 * The check this replaces was `accessSync(p, X_OK)`. That is exactly right on
 * POSIX and meaningless anywhere else: Node cannot ask NTFS "is this
 * executable" and quietly degrades `X_OK` to `F_OK`, so the test would pass
 * for every readable file and the caller would believe it had found a binary.
 *
 * Across the WSL boundary we cannot ask either — the 9p view of the distro does
 * not carry a mode we can trust. Existence in a directory that is already on
 * the host's PATH is the honest test there, and it reaches the same conclusion
 * `command -v` would.
 */
export function hostFileExists(p: string, requireExec = false): boolean {
  if (hostKind() !== 'local') return hostTest(p, requireExec)
  try {
    if (requireExec) fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * The same question, asked of the host instead of answered through the share.
 *
 * Stat'ing a distro path through `\\wsl.localhost` is a trap. The 9P redirector
 * serves regular files faithfully — `\\wsl.localhost\Ubuntu\usr\bin\tmux` stats
 * fine — but a symlink *created inside Linux* comes back ENOENT, target and
 * all, because Windows cannot follow a reparse tag it does not understand. And
 * a symlink is exactly what the binaries this function is usually asked about
 * are: `~/.local/bin/claude` points into a versions directory, and every npm or
 * nvm shim points at `../lib/node_modules/...`. Answering from the Windows side
 * reported both agents this app exists to run as not installed.
 *
 * `test` also settles executability, which Windows cannot answer at all: Node
 * degrades `X_OK` to `F_OK` there, so the local branch's `accessSync` would say
 * yes to a text file. `-f` follows the link and is false for a directory, which
 * together with `-x` is precisely the old `isFile() && X_OK` pair.
 *
 * A crossing costs about a tenth of a second, so this is for one-off questions
 * — a configured absolute path, a shim we are about to write. Anything that
 * would ask it in a loop should ask the host one question instead; see
 * `findExecutable`.
 */
function hostTest(p: string, requireExec: boolean): boolean {
  const script = '[ -f "$1" ] && { [ "$2" != x ] || [ -x "$1" ]; } && echo y'
  const out = hostCapture(['sh', '-c', script, 'sh', p, requireExec ? 'x' : ''], 10_000)
  return out?.trim() === 'y'
}

/**
 * Runs a short command on the host and returns its stdout, or null.
 *
 * For probes only — startup discovery and version strings. Anything on a hot
 * path pays a WSL round trip it should not.
 */
export function hostCapture(argv: string[], timeoutMs = 30_000): string | null {
  try {
    const { file, args, cwd } = hostSpawn(argv)
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
  } catch {
    return null
  }
}

/**
 * The home directory *on the host*.
 *
 * `os.homedir()` answers for the machine Electron runs on, which on Windows is
 * `C:\Users\<name>` — the wrong side of the boundary for everything that
 * reads a dotfile an agent wrote: `~/.claude/projects`, `~/.codex/sessions`,
 * `~/.claude.json`. Those live where the agent ran, and the agent ran in WSL.
 */
export function hostHome(): string {
  return hostKind() === 'local' ? os.homedir() : `/home/${hostUser()}`
}

/**
 * The host home directory as *this* process can open it.
 *
 * Two spellings of one directory, and picking the wrong one is the easiest
 * mistake in this port. Use `hostHome()` when the string is going to be read by
 * something running on the host — a trust-record key, an argv the agent sees.
 * Use this one when Node itself is about to `readFileSync` it, because Windows
 * reaches the distro over UNC and knows nothing about `/home`.
 */
export function hostHomeNative(): string {
  return toNativePath(hostHome())
}

/** Test seam: forget everything probed, so a test can vary the environment. */
export function resetHostCacheForTests(): void {
  cachedInfo = null
  cachedUser = null
  probeFailed = null
}
