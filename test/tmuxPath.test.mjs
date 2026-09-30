/**
 * The pane's PATH.
 *
 * tmux will not let `-e` set PATH, and it does not say so: the value lands in
 * the session environment, `show-environment` prints it back, and the pane
 * quietly runs with the PATH of the *client* that ran `new-session` instead.
 * That client is Electron, and an app launched from the Dock gets its PATH from
 * launchd: `/usr/bin:/bin:/usr/sbin:/sbin`, with no Homebrew on it.
 *
 * `claude` survived that because it is a binary launched by absolute path.
 * `codex` is a `#!/usr/bin/env node` script, so it died with
 * `env: node: No such file or directory` and status 127 — and looked, from the
 * outside, like a broken Codex install.
 *
 * These tests pin the workaround: PATH travels under another name and a one
 * line `sh` prologue restores it before exec'ing the agent.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { createSessionArgs, PANE_PATH_VAR } from '../src/main/tmux.ts'

const BASE = {
  name: 'term_abc',
  cwd: '/Users/x/Dev/proj',
  command: ['/opt/homebrew/bin/codex', '--flag', 'a b'],
  env: {},
  cols: 100,
  rows: 30
}

/** The argv after the `--` separator: what the pane actually runs. */
function paneCommand(argv) {
  const i = argv.indexOf('--')
  assert.notEqual(i, -1, 'expected a -- separator')
  return argv.slice(i + 1)
}

/** All `-e KEY=VALUE` pairs, as an object. */
function envPairs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '-e') continue
    const eq = argv[i + 1].indexOf('=')
    out[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1)
  }
  return out
}

describe('createSessionArgs', () => {
  test('runs the command directly when no PATH is supplied', () => {
    const argv = createSessionArgs(BASE)
    assert.deepEqual(paneCommand(argv), BASE.command)
  })

  test('wraps the command in an sh prologue when PATH is supplied', () => {
    const argv = createSessionArgs({ ...BASE, env: { PATH: '/opt/homebrew/bin:/usr/bin' } })
    const cmd = paneCommand(argv)
    assert.equal(cmd[0], '/bin/sh')
    assert.equal(cmd[1], '-c')
    // The real command is passed as arguments, never spliced into the script,
    // so no argument can be re-parsed as shell syntax.
    assert.deepEqual(cmd.slice(3), ['workbench', ...BASE.command])
  })

  test('the prologue exports PATH and then gets out of the way', () => {
    const argv = createSessionArgs({ ...BASE, env: { PATH: '/opt/homebrew/bin' } })
    const script = paneCommand(argv)[2]
    assert.match(script, new RegExp(`export PATH="\\$${PANE_PATH_VAR}"`))
    assert.match(script, new RegExp(`unset ${PANE_PATH_VAR}`))
    // exec, so the pane's exit status is the agent's and not a shell's.
    assert.match(script, /exec "\$@"/)
  })

  test('carries PATH under a name tmux does not intercept', () => {
    const argv = createSessionArgs({ ...BASE, env: { PATH: '/opt/homebrew/bin:/usr/bin' } })
    assert.equal(envPairs(argv)[PANE_PATH_VAR], '/opt/homebrew/bin:/usr/bin')
  })

  test('still sets -e PATH, which is what a manually opened window inherits', () => {
    const argv = createSessionArgs({ ...BASE, env: { PATH: '/opt/homebrew/bin' } })
    assert.equal(envPairs(argv).PATH, '/opt/homebrew/bin')
  })

  test('passes the other variables through untouched', () => {
    const argv = createSessionArgs({
      ...BASE,
      env: { PATH: '/opt/homebrew/bin', TERMINAL_SESSION_ID: 's1', TERM: 'xterm-256color' }
    })
    const env = envPairs(argv)
    assert.equal(env.TERMINAL_SESSION_ID, 's1')
    assert.equal(env.TERM, 'xterm-256color')
  })

  test('an empty PATH is not worth wrapping for', () => {
    const argv = createSessionArgs({ ...BASE, env: { PATH: '' } })
    assert.deepEqual(paneCommand(argv), BASE.command)
    assert.equal(envPairs(argv)[PANE_PATH_VAR], undefined)
  })

  test('clamps the geometry tmux would reject', () => {
    const argv = createSessionArgs({ ...BASE, cols: 2, rows: 1 })
    assert.equal(argv[argv.indexOf('-x') + 1], '20')
    assert.equal(argv[argv.indexOf('-y') + 1], '5')
  })
})
