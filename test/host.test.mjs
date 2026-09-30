/**
 * The Windows boundary.
 *
 * `host.ts` is the only file that knows there is a boundary at all, so it is
 * the only place a mistake about it can be caught. The two path translators are
 * pure and take their `WslInfo` as an argument, which is deliberate: it means
 * the interesting half of the Windows port can be tested from a Linux CI box
 * with no distro, no `wsl.exe`, and no probe.
 *
 * The rest of the file — `hostSpawn`, `hostSpawnEnv` — branches on
 * `hostKind()`, which is a bare `process.platform` check with no seam. Rather
 * than monkey-patching `process.platform` (which would also make `probeWsl`
 * shell out to a `wsl.exe` that is, confusingly, on the PATH *inside* WSL),
 * these assert the invariant that holds on whichever side the suite is running:
 * the argv reaches the host unmangled, and the crossing adds only the wrapper.
 * Run the suite on Windows and the `wsl` arm is the one that executes.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  findNativeExecutable,
  hostKind,
  hostSpawn,
  hostSpawnEnv,
  hostToWindowsPath,
  toHostPath,
  toNativePath,
  windowsToHostPath
} from '../src/main/host.ts'
import { tempDir } from './helpers.mjs'

/** A stock install: one distro, drives under `/mnt`. */
const INFO = { distro: 'Ubuntu', mountRoot: '/mnt' }
const LOCAL = hostKind() === 'local'

describe('windowsToHostPath', () => {
  test('maps a drive letter onto the mount root, lowercased', () => {
    assert.equal(windowsToHostPath(String.raw`C:\Users\x\Dev`, INFO), '/mnt/c/Users/x/Dev')
    // Windows itself does not care about the case of a drive letter; `/mnt/C`
    // does not exist, so the translation has to.
    assert.equal(windowsToHostPath(String.raw`c:\temp`, INFO), '/mnt/c/temp')
  })

  test('handles a bare drive root', () => {
    assert.equal(windowsToHostPath('C:\\', INFO), '/mnt/c')
    assert.equal(windowsToHostPath('C:', INFO), '/mnt/c')
  })

  test('accepts forward slashes, which Windows APIs do too', () => {
    assert.equal(windowsToHostPath('C:/Users/x', INFO), '/mnt/c/Users/x')
  })

  test('strips a UNC prefix rather than mounting it', () => {
    // `\\wsl.localhost\Ubuntu\home\k` is the distro looked at from outside. The
    // host's own name for it is `/home/k` — mounting it under `/mnt` would name
    // a path that does not exist.
    assert.equal(
      windowsToHostPath(String.raw`\\wsl.localhost\Ubuntu\home\k\Dev`, INFO),
      '/home/k/Dev'
    )
    // The older spelling is still what File Explorer hands out on some builds.
    assert.equal(windowsToHostPath(String.raw`\\wsl$\Ubuntu\home\k`, INFO), '/home/k')
    // And it arrives in whatever case the producer felt like.
    assert.equal(windowsToHostPath(String.raw`\\WSL.LOCALHOST\Ubuntu\home\k`, INFO), '/home/k')
  })

  test('ignores the distro named in a UNC path', () => {
    // We only ever translate for the distro we are running in; a stale name in
    // a pasted path must not silently redirect the result somewhere else.
    assert.equal(windowsToHostPath(String.raw`\\wsl.localhost\Debian\home\k`, INFO), '/home/k')
  })

  test('leaves a POSIX or relative path alone', () => {
    assert.equal(windowsToHostPath('/home/k/x', INFO), '/home/k/x')
    assert.equal(windowsToHostPath(String.raw`docs\a.md`, INFO), 'docs/a.md')
  })

  test('respects a moved mount root', () => {
    // `/etc/wsl.conf` can set `root = /drives/`, and then every drive path in
    // the app is wrong unless this reads it back from the probe.
    assert.equal(
      windowsToHostPath(String.raw`D:\proj`, { distro: 'Ubuntu', mountRoot: '/drives' }),
      '/drives/d/proj'
    )
  })
})

describe('hostToWindowsPath', () => {
  test('spells a distro path as UNC', () => {
    assert.equal(
      hostToWindowsPath('/home/k/Dev', INFO),
      String.raw`\\wsl.localhost\Ubuntu\home\k\Dev`
    )
  })

  test('unmounts a drive back to its letter', () => {
    assert.equal(hostToWindowsPath('/mnt/c/Users/x', INFO), String.raw`C:\Users\x`)
    assert.equal(hostToWindowsPath('/mnt/c', INFO), 'C:\\')
    assert.equal(hostToWindowsPath('/mnt/c/', INFO), 'C:\\')
  })

  test('is idempotent on anything already Windows-shaped', () => {
    // The `/preview/show` route takes its argument from a CLI that may have
    // resolved the path on either side of the boundary. Without this guard a
    // UNC path gets the UNC prefix stapled on a second time and opens nothing.
    for (const p of [
      String.raw`C:\Users\x`,
      'C:/Users/x',
      String.raw`\\wsl.localhost\Ubuntu\home\k`,
      String.raw`\\server\share\f`
    ]) {
      assert.equal(hostToWindowsPath(p, INFO), p)
    }
  })

  test('leaves a relative path alone', () => {
    assert.equal(hostToWindowsPath('docs/a.md', INFO), 'docs/a.md')
  })

  test('matches the mount root literally, not as a pattern', () => {
    const dotted = { distro: 'Ubuntu', mountRoot: '/mnt.d' }
    assert.equal(hostToWindowsPath('/mnt.d/c/x', dotted), String.raw`C:\x`)
    // `.` in the root must not match an arbitrary character: this path is not
    // under the mount root at all and belongs inside the distro.
    assert.equal(hostToWindowsPath('/mntxd/c/x', dotted), String.raw`\\wsl.localhost\Ubuntu\mntxd\c\x`)
  })

  test('round-trips both kinds of native path', () => {
    for (const p of [String.raw`C:\Users\x\Dev`, String.raw`\\wsl.localhost\Ubuntu\home\k\Dev`]) {
      assert.equal(hostToWindowsPath(windowsToHostPath(p, INFO), INFO), p)
    }
  })
})

describe('toHostPath / toNativePath', () => {
  test('cost nothing on a local host', { skip: !LOCAL }, () => {
    // The whole point of the rule is that it is free on the platforms with no
    // boundary — if these ever stopped being the identity, every macOS and
    // Linux path in the app would start moving.
    assert.equal(toHostPath('/Users/x/Dev'), '/Users/x/Dev')
    assert.equal(toNativePath('/Users/x/Dev'), '/Users/x/Dev')
  })
})

describe('hostSpawn', () => {
  /** The argv as the host will see it, with the crossing wrapper removed. */
  const hostArgv = (spawn) => {
    if (LOCAL) return [spawn.file, ...spawn.args]
    assert.equal(spawn.file, 'wsl.exe')
    const at = spawn.args.indexOf('-e')
    assert.ok(at >= 0, '`-e` is what makes wsl.exe an exec instead of a shell')
    return spawn.args.slice(at + 1)
  }

  test('passes the argv through untouched', () => {
    const argv = ['tmux', '-L', 'terminal', 'attach', '-t', '=term_a b']
    assert.deepEqual(hostArgv(hostSpawn(argv)), argv)
  })

  test('carries the cwd the way the host takes it', () => {
    const spawn = hostSpawn(['tmux', 'ls'], { cwd: '/home/k/proj' })
    assert.deepEqual(hostArgv(spawn), ['tmux', 'ls'])
    if (LOCAL) {
      assert.equal(spawn.cwd, '/home/k/proj')
    } else {
      // WSL takes it as an argument; a `cwd` spawn option would be a Windows
      // path and would fail, so it must not be set on this side.
      assert.equal(spawn.cwd, undefined)
      assert.deepEqual(spawn.args.slice(0, spawn.args.indexOf('-e')).slice(-2), [
        '--cd',
        '/home/k/proj'
      ])
    }
  })

  test('puts the environment where the command can read it', () => {
    const spawn = hostSpawn(['sh', '-c', 'echo hi'], { env: { A: '1', B: 'two words' } })
    if (LOCAL) {
      // Locally the caller passes `env` to the spawn itself; nothing is
      // prepended to the argv.
      assert.deepEqual(hostArgv(spawn), ['sh', '-c', 'echo hi'])
    } else {
      // The interop boundary does not forward the parent environment, so the
      // variables travel as arguments to `env` — no shell, nothing to requote.
      assert.deepEqual(hostArgv(spawn), ['env', 'A=1', 'B=two words', 'sh', '-c', 'echo hi'])
    }
  })

  test('unsets variables through the same door', () => {
    const spawn = hostSpawn(['tmux', 'ls'], { unsetEnv: ['TMUX'] })
    if (LOCAL) {
      assert.deepEqual(hostArgv(spawn), ['tmux', 'ls'])
    } else {
      assert.deepEqual(hostArgv(spawn), ['env', '-u', 'TMUX', 'tmux', 'ls'])
    }
  })
})

describe('hostSpawnEnv', () => {
  test('a local child gets the host environment; a crossing one gets this process\'s', () => {
    const hostEnv = { PATH: '/usr/bin', WORKBENCH_PANE_PATH: '/opt/bin' }
    if (LOCAL) {
      assert.equal(hostSpawnEnv(hostEnv), hostEnv)
    } else {
      // A POSIX-shaped environment means nothing to `wsl.exe` and must not be
      // smeared onto it — those variables went in the argv instead.
      assert.equal(hostSpawnEnv(hostEnv), process.env)
    }
  })
})

describe('findNativeExecutable', () => {
  const win = process.platform === 'win32'

  /** Runs `fn` with PATH pointing at a throwaway directory. */
  const withPath = (dir, fn) => {
    const saved = process.env.PATH
    process.env.PATH = dir
    try {
      return fn()
    } finally {
      process.env.PATH = saved
    }
  }

  test('finds a binary on the PATH', () => {
    const dir = tempDir('host-path-')
    const name = win ? 'wb-tool.exe' : 'wb-tool'
    fs.writeFileSync(path.join(dir, name), '')
    if (!win) fs.chmodSync(path.join(dir, name), 0o755)
    withPath(dir, () => {
      // The lookup is by bare name on both platforms: on Windows the extension
      // is implied by PATHEXT and never typed, which is exactly why
      // `existsSync('cloudflared')` was invisible to the old check.
      assert.equal(findNativeExecutable('wb-tool')?.toLowerCase(), path.join(dir, name).toLowerCase())
      assert.equal(findNativeExecutable('wb-absent'), null)
    })
  })

  test('ignores a file that is not executable', { skip: win }, () => {
    // Only meaningful on POSIX. Windows has no execute bit Node can read, so
    // the extension list carries that weight there instead.
    const dir = tempDir('host-path-')
    fs.writeFileSync(path.join(dir, 'wb-plain'), '', { mode: 0o644 })
    withPath(dir, () => {
      assert.equal(findNativeExecutable('wb-plain'), null)
    })
  })

  test('tries every PATHEXT extension', { skip: !win }, () => {
    const dir = tempDir('host-path-')
    fs.writeFileSync(path.join(dir, 'wb-cmd.cmd'), '')
    withPath(dir, () => {
      assert.equal(findNativeExecutable('wb-cmd')?.toLowerCase(), path.join(dir, 'wb-cmd.cmd').toLowerCase())
    })
  })

  test('survives an empty PATH entry', () => {
    // `PATH=/usr/bin:` yields an empty segment, and `path.join('', name)` would
    // otherwise turn into a relative lookup against the cwd.
    withPath(`${path.delimiter}${path.delimiter}`, () => {
      assert.equal(findNativeExecutable('wb-tool'), null)
    })
  })
})
