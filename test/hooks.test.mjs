import { toHostPath, toNativePath } from '../src/main/host.js'
/**
 * Hook bridge: delivery, authentication, and — the one that actually bit us —
 * surviving an app restart while the tmux sessions carry on running.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { HookBridge, readBridgeManifest } from '../src/main/hooks.js'
import { tempDir } from './helpers.mjs'

/** POSTs straight at the bridge, bypassing the shim. */
function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body))
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: headers.__path ?? '/event',
        method: headers.__method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          ...(headers.token ? { 'x-terminal-token': headers.token } : {})
        }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

/** Runs the generated hook script exactly as a CLI would, and waits for exit. */
function runHookScript(bridge, { source = 'claude', event = 'Stop', payload = {}, env = {} }) {
  return new Promise((resolve, reject) => {
    const args =
      source === 'codex'
        ? [bridge.paths.hookScript, 'codex', JSON.stringify(payload)]
        : [bridge.paths.hookScript, 'claude', event]
    const child = spawn(process.execPath, args, {
      env: {
        PATH: process.env.PATH,
        TERMINAL_SESSION_ID: 'sess-1',
        TERMINAL_BRIDGE_FILE: bridge.paths.bridgeFile,
        ...env,
        TERMINAL_BRIDGE_FILE: toNativePath(env.TERMINAL_BRIDGE_FILE ?? bridge.paths.bridgeFile)
      },
      stdio: ['pipe', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c))
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stderr }))
    if (source === 'claude') {
      child.stdin.end(JSON.stringify(payload))
    } else {
      child.stdin.end()
    }
  })
}

/** Resolves with the next hook event, or null if none arrives in `ms`. */
function nextEvent(bridge, ms = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bridge.off('hook', onHook)
      resolve(null)
    }, ms)
    const onHook = (evt) => {
      clearTimeout(timer)
      bridge.off('hook', onHook)
      resolve(evt)
    }
    bridge.on('hook', onHook)
  })
}

describe('hook bridge', () => {
  test('publishes a private, readable manifest and delivers authenticated events', async () => {
    const dir = tempDir()
    const bridge = new HookBridge(dir, process.execPath)
    await bridge.start()
    try {
      const manifest = readBridgeManifest(bridge.paths.bridgeFile)
      assert.ok(manifest, 'manifest should parse')
      assert.equal(manifest.port, bridge.port)
      assert.equal(manifest.token, bridge.token)
      assert.equal(manifest.version, 1)

      // The token lives in this file; it must never be group- or world-readable.
      const mode = fs.statSync(bridge.paths.bridgeFile).mode & 0o777
      if (process.platform !== 'win32') assert.equal(mode, 0o600)

      const seen = nextEvent(bridge)
      const status = await post(
        bridge.port,
        { termSessionId: 'sess-1', source: 'claude', event: 'Stop', payload: { session_id: 'cli-1' } },
        { token: bridge.token }
      )
      assert.equal(status, 200)
      const evt = await seen
      assert.ok(evt)
      assert.equal(evt.termSessionId, 'sess-1')
      assert.equal(evt.source, 'claude')
      assert.equal(evt.event, 'Stop')
      assert.equal(evt.payload.session_id, 'cli-1')
    } finally {
      await bridge.stop()
    }
  })

  test('rejects a wrong token, a wrong method and a wrong path without emitting', async () => {
    const dir = tempDir()
    const bridge = new HookBridge(dir, process.execPath)
    await bridge.start()
    try {
      let emitted = 0
      bridge.on('hook', () => emitted++)

      assert.equal(
        await post(bridge.port, { termSessionId: 'sess-1' }, { token: 'not-the-token' }),
        403
      )
      assert.equal(await post(bridge.port, { termSessionId: 'sess-1' }, {}), 403)
      assert.equal(
        await post(bridge.port, { termSessionId: 'sess-1' }, { token: bridge.token, __path: '/' }),
        404
      )
      assert.equal(
        await post(
          bridge.port,
          { termSessionId: 'sess-1' },
          { token: bridge.token, __method: 'GET' }
        ),
        404
      )

      // An authenticated but sessionless payload is accepted at the HTTP layer
      // and dropped at the application layer.
      assert.equal(await post(bridge.port, { source: 'claude' }, { token: bridge.token }), 200)
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(emitted, 0, 'no unauthenticated or anonymous event should reach the app')
    } finally {
      await bridge.stop()
    }
  })

  test('the generated shim script delivers a real Claude hook payload', async () => {
    const dir = tempDir()
    const bridge = new HookBridge(dir, process.execPath)
    await bridge.start()
    try {
      const seen = nextEvent(bridge)
      const { code } = await runHookScript(bridge, {
        event: 'Notification',
        payload: { hook_event_name: 'Notification', message: 'Claude needs your permission' }
      })
      assert.equal(code, 0)
      const evt = await seen
      assert.ok(evt, 'the script should have reached the bridge')
      assert.equal(evt.event, 'Notification')
      assert.equal(evt.payload.message, 'Claude needs your permission')
    } finally {
      await bridge.stop()
    }
  })

  test('a Codex notify payload arrives with its hyphenated thread-id intact', async () => {
    const dir = tempDir()
    const bridge = new HookBridge(dir, process.execPath)
    await bridge.start()
    try {
      const seen = nextEvent(bridge)
      const { code } = await runHookScript(bridge, {
        source: 'codex',
        payload: {
          type: 'agent-turn-complete',
          'thread-id': 'codex-thread-1',
          'last-assistant-message': 'done'
        }
      })
      assert.equal(code, 0)
      const evt = await seen
      assert.ok(evt)
      assert.equal(evt.source, 'codex')
      assert.equal(evt.event, 'agent-turn-complete')
      assert.equal(evt.payload['thread-id'], 'codex-thread-1')
    } finally {
      await bridge.stop()
    }
  })

  test('hooks reconnect after the app restarts while the tmux session survives', async () => {
    const dir = tempDir()

    // Launch 1. A tmux session created now bakes in TERMINAL_SESSION_ID and
    // TERMINAL_BRIDGE_FILE — and nothing else. That is the whole point.
    const first = new HookBridge(dir, process.execPath)
    await first.start()
    const bakedEnv = first.envFor('sess-1')
    assert.deepEqual(Object.keys(bakedEnv).sort(), ['TERMINAL_BRIDGE_FILE', 'TERMINAL_SESSION_ID'])
    assert.ok(!JSON.stringify(bakedEnv).includes(String(first.port)))
    assert.ok(!JSON.stringify(bakedEnv).includes(first.token))

    const firstPort = first.port
    const firstToken = first.token
    await first.stop()
    assert.equal(fs.existsSync(first.paths.bridgeFile), false, 'stop removes the endpoint')

    // Launch 2 — new port, new token, same directory.
    const second = new HookBridge(dir, process.execPath)
    await second.start()
    try {
      assert.notEqual(second.token, firstToken, 'a restart must rotate the token')
      const manifest = readBridgeManifest(second.paths.bridgeFile)
      assert.equal(manifest.port, second.port)
      assert.equal(manifest.token, second.token)

      // The surviving session's environment is byte-for-byte what it was, and a
      // hook fired from it still lands — on the new port.
      assert.deepEqual(second.envFor('sess-1'), bakedEnv)
      const seen = nextEvent(second)
      const { code } = await runHookScript(second, {
        event: 'Stop',
        payload: { hook_event_name: 'Stop', session_id: 'cli-1' },
        env: bakedEnv
      })
      assert.equal(code, 0)
      const evt = await seen
      assert.ok(evt, 'a session that outlived the app should still reach the new bridge')
      assert.equal(evt.termSessionId, 'sess-1')

      // And the pre-restart token is now worthless.
      if (firstPort !== second.port) {
        assert.equal(await post(second.port, { termSessionId: 'sess-1' }, { token: firstToken }), 403)
      }
    } finally {
      await second.stop()
    }
  })

  test('a stale endpoint fails the hook quietly instead of blocking the agent', async () => {
    const dir = tempDir()
    const bridge = new HookBridge(dir, process.execPath)
    await bridge.start()
    try {
      let emitted = 0
      bridge.on('hook', () => emitted++)

      // The exact shape of a bridge file left behind by a previous run: right
      // port, dead token.
      fs.writeFileSync(
        bridge.paths.bridgeFile,
        JSON.stringify({ version: 1, port: bridge.port, token: 'stale-token', pid: 1, startedAt: 1 })
      )
      const authFailed = await runHookScript(bridge, { event: 'Stop', payload: {} })
      assert.equal(authFailed.code, 0, 'a rejected hook must not fail the agent')

      // And an endpoint that is not listening at all.
      fs.writeFileSync(
        bridge.paths.bridgeFile,
        JSON.stringify({ version: 1, port: 1, token: 'stale-token', pid: 1, startedAt: 1 })
      )
      const refused = await runHookScript(bridge, { event: 'Stop', payload: {} })
      assert.equal(refused.code, 0, 'a dead endpoint must not fail the agent')

      // A missing bridge file: the app is not running at all.
      fs.rmSync(bridge.paths.bridgeFile, { force: true })
      const missing = await runHookScript(bridge, { event: 'Stop', payload: {} })
      assert.equal(missing.code, 0)

      await new Promise((r) => setTimeout(r, 150))
      assert.equal(emitted, 0, 'none of those should have been accepted')
    } finally {
      await bridge.stop()
    }
  })

  test('readBridgeManifest refuses anything it cannot trust', () => {
    const dir = tempDir()
    const file = `${dir}/bridge.json`
    assert.equal(readBridgeManifest(file), null, 'missing')
    fs.writeFileSync(file, 'not json')
    assert.equal(readBridgeManifest(file), null, 'unparseable')
    fs.writeFileSync(file, JSON.stringify({ port: 0, token: 'x' }))
    assert.equal(readBridgeManifest(file), null, 'no port')
    fs.writeFileSync(file, JSON.stringify({ port: 123, token: '' }))
    assert.equal(readBridgeManifest(file), null, 'no token')
    fs.writeFileSync(file, JSON.stringify({ port: 123, token: 'x' }))
    assert.deepEqual(readBridgeManifest(file), {
      version: 0,
      port: 123,
      token: 'x',
      pid: 0,
      startedAt: 0
    })
  })

  test('the Claude settings file wires hooks without touching global config', () => {
    const dir = tempDir()
    const bridge = new HookBridge(dir, process.execPath)
    const file = bridge.writeClaudeSettings()
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.ok(file.startsWith(dir), 'settings must live in our own data directory')
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd']) {
      const command = settings.hooks[event][0].hooks[0].command
      assert.ok(command.includes(toHostPath(bridge.paths.claudeShim)), `${event} points at our shim`)
      assert.ok(command.endsWith(` ${event}`), `${event} names itself`)
    }
  })
})

/**
 * `workbench show <file>` — the verb an agent uses to put an existing file on
 * screen. The auto-surface only ever sees documents a turn produced, so without
 * this there is no way to say "look at the résumé that is already in the repo".
 */
describe('the show CLI', () => {
  /** Runs the generated script the way a session's PATH would. */
  function runShow(bridge, args, env = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(bridge.bin, 'workbench.cjs'), ...args], {
        env: {
          PATH: process.env.PATH,
          TERMINAL_SESSION_ID: 'sess-1',
          TERMINAL_BRIDGE_FILE: bridge.paths.bridgeFile,
          ...env,
        TERMINAL_BRIDGE_FILE: toNativePath(env.TERMINAL_BRIDGE_FILE ?? bridge.paths.bridgeFile)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (err += c))
      child.on('error', reject)
      child.on('exit', (code) => resolve({ code, out, err }))
    })
  }

  test('posts the resolved path to the mounted route, and reports back', async () => {
    const dir = tempDir()
    const bridge = new HookBridge(dir, process.execPath)
    await bridge.start()
    try {
      const seen = []
      bridge.route('/preview/show', async (body) => {
        seen.push(body)
        return { path: body.path }
      })

      const doc = path.join(dir, 'report.md')
      fs.writeFileSync(doc, '# hello\n')

      const { code, out } = await runShow(bridge, ['show', doc])

      assert.equal(code, 0)
      assert.equal(seen.length, 1)
      assert.equal(seen[0].termSessionId, 'sess-1')
      assert.equal(seen[0].path, doc, 'the path is resolved before it leaves the CLI')
      assert.match(out, /report\.md/)
    } finally {
      await bridge.stop()
    }
  })

  test("a route that refuses is reported as the route's own words, not a stack", async () => {
    const dir = tempDir()
    const bridge = new HookBridge(dir, process.execPath)
    await bridge.start()
    try {
      bridge.route('/preview/show', async () => {
        throw new Error('The pane cannot render .zip files')
      })
      const { code, err } = await runShow(bridge, ['show', path.join(dir, 'a.zip')])
      assert.equal(code, 1)
      assert.match(err, /cannot render \.zip/)
    } finally {
      await bridge.stop()
    }
  })

  test('outside a session, and with the app gone, it fails without a stack trace', async () => {
    const dir = tempDir()
    const bridge = new HookBridge(dir, process.execPath)
    await bridge.start()
    await bridge.stop() // publishes, then removes, the bridge file
    try {
      const loose = await runShow(bridge, ['show', 'x.md'], { TERMINAL_SESSION_ID: '' })
      assert.equal(loose.code, 1)
      assert.match(loose.err, /not running inside a Workbench session/)

      const down = await runShow(bridge, ['show', 'x.md'])
      assert.equal(down.code, 1)
      assert.match(down.err, /not running/)

      const misuse = await runShow(bridge, ['open', 'x.md'])
      assert.equal(misuse.code, 2)
      assert.match(misuse.err, /workbench show <file>/)
    } finally {
      /* already stopped */
    }
  })
})
