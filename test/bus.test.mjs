import { toHostPath, toNativePath } from '../src/main/host.js'
/**
 * Session Bus: the guardrails, the tools, and one end-to-end run of the
 * generated MCP server against a real bridge.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'

import { SessionBus, BUS_TOOLS } from '../src/main/bus.js'
import { Experience } from '../src/main/experience.js'
import { emptyExperience } from '../src/shared/experience.js'
import { projectFocus } from '../src/shared/focusProjects.js'
import { buildLaunchSpec } from '../src/main/agents.js'
import { definitionOr } from '../src/shared/agents.js'
import { HookBridge } from '../src/main/hooks.js'
import { tempDir } from './helpers.mjs'

/**
 * A sessions double. Only the six members the bus actually reaches for, so a
 * change to SessionManager that breaks the bus shows up as a type error rather
 * than as a test that quietly keeps passing against a stale fake.
 */
function fakeSessions(rows = []) {
  const bus = new EventEmitter()
  const map = new Map(rows.map((r) => [r.id, r]))
  const calls = []
  let createdCount = 0
  return {
    calls,
    emitChange: () => bus.emit('sessions-changed'),
    listenerCount: () => bus.listenerCount('sessions-changed'),
    set(id, patch) {
      Object.assign(map.get(id), patch)
      bus.emit('sessions-changed')
    },
    list: () => [...map.values()],
    get: (id) => map.get(id),
    captureText: async (id, lines) => {
      calls.push(['captureText', id, lines])
      return `screen of ${id}`
    },
    sendPrompt: async (id, text) => {
      calls.push(['sendPrompt', id, text])
    },
    fork: async (opts) => {
      calls.push(['fork', opts])
      const made = session('sess_forked', { title: 'fork of it', agent: opts.targetAgent ?? map.get(opts.sourceId).agent, sessionProjectId: map.get(opts.sourceId).sessionProjectId })
      map.set(made.id, made)
      return made
    },
    create: async (opts) => {
      calls.push(['create', opts])
      const id = ++createdCount === 1 ? 'created' : `created-${createdCount}`
      const made = session(id, { ...opts, sessionProjectId: opts.sessionProjectId, bus: 'off' })
      map.set(made.id, made)
      return made
    },
    rename: (id, title) => { calls.push(['rename', id, title]); map.get(id).title = title },
    setPinned: (id, pinned) => { calls.push(['setPinned', id, pinned]); map.get(id).pinned = pinned },
    setBusAccess: (id, access) => { calls.push(['setBusAccess', id, access]); map.get(id).bus = access },
    kill: async (id) => { calls.push(['kill', id]); map.get(id).alive = false },
    restart: async (id) => { calls.push(['restart', id]); map.get(id).alive = true },
    interrupt: async (id) => { calls.push(['interrupt', id]) },
    remove: async (id) => { calls.push(['remove', id]); map.delete(id); bus.emit('sessions-changed') },
    on: (evt, fn) => bus.on(evt, fn),
    off: (evt, fn) => bus.off(evt, fn)
  }
}

function session(id, over = {}) {
  return {
    id,
    title: `session ${id}`,
    agent: 'claude',
    status: 'idle',
    statusReason: null,
    alive: true,
    cwd: '/tmp/repo',
    parentId: null,
    rootId: id,
    bus: 'off',
    ...over
  }
}

function makeBus(rows, over = {}) {
  const sessions = fakeSessions(rows)
  const bus = new SessionBus({
    sessions,
    binDir: tempDir('bus-'),
    electronExecPath: process.execPath,
    enabled: () => true,
    ...over
  })
  return { bus, sessions }
}

/** Use the real scheduler and disk store behind the bus. A mocked save would
 * miss the original failure: tools and the Scheduled view must use the same
 * persisted tasks, with actual run reservations and normal launch options. */
function scheduledBus() {
  const projects = ['one', 'two'].map((id) => ({ id, name: `Project ${id}`, defaultCwd: tempDir('scheduled-project-') }))
  const project = (id) => projects.find((p) => p.id === id)
  let scheduler, enabled = true, changes = 0, now = new Date(2026, 8, 4, 8).getTime()
  const env = makeBus([
    session('manager', { bus: 'manager', busProjectId: 'one', sessionProjectId: 'one' }),
    session('ordinary', { bus: 'full', sessionProjectId: 'one' })
  ], { project, projects: () => projects, enabled: () => enabled, scheduler: () => scheduler })
  const deps = { directory: tempDir('scheduled-data-'), project, session: (id) => env.sessions.get(id),
    launch: (opts) => env.sessions.create(opts), changed: () => { changes++ }, now: () => now }
  scheduler = new Experience(deps)
  return { ...env, scheduler, deps, projects, changes: () => changes,
    enableBus: (value) => { enabled = value }, time: (value) => { now = value } }
}

const scheduleArgs = (patch = {}) => ({ name: 'Advisor briefing', prompt: 'Write a project briefing to briefing.md.',
  cadence: 'weekdays', time: '09:00', ...patch })

/** The message a call failed with, or null if it succeeded. */
async function refusal(bus, caller, tool, args = {}) {
  try {
    await bus.call(caller, tool, args)
    return null
  } catch (err) {
    return err.message
  }
}

describe('who may use the bus', () => {
  test('a session with no grant is refused, and told it is a per-session grant', async () => {
    const { bus } = makeBus([session('a'), session('b', { bus: 'full' })])
    const why = await refusal(bus, 'a', 'list_sessions')
    assert.match(why, /no bus access/i)
  })

  test('the master switch refuses everyone, however they are granted', async () => {
    const { bus } = makeBus([session('a', { bus: 'full' }), session('b', { bus: 'full' })], {
      enabled: () => false
    })
    assert.match(await refusal(bus, 'a', 'list_sessions'), /switched off/i)
  })

  test('read access can look but not touch', async () => {
    const { bus } = makeBus([
      session('a', { bus: 'read' }),
      session('b', { bus: 'read' })
    ])
    assert.ok(await bus.call('a', 'read_session', { session_id: 'b' }))
    assert.match(await refusal(bus, 'a', 'send_prompt', { session_id: 'b', text: 'hi' }), /reachable at full/)
    assert.match(await refusal(bus, 'a', 'fork_session', { session_id: 'b' }), /reachable at full/)
  })

  test('full access may prompt and fork', async () => {
    const { bus, sessions } = makeBus([
      session('a', { bus: 'read' }),
      session('b', { bus: 'full' })
    ])
    await bus.call('a', 'send_prompt', { session_id: 'b', text: 'run the tests' })
    await bus.call('a', 'fork_session', { session_id: 'b', kind: 'sibling', prompt: 'try it another way' })
    assert.deepEqual(sessions.calls[0], ['sendPrompt', 'b', 'run the tests'])
    assert.deepEqual(sessions.calls[1][1], {
      sourceId: 'b',
      kind: 'sibling',
      targetAgent: undefined,
      initialPrompt: 'try it another way'
    })
  })

  test('an off-bus target and a nonexistent one are refused in the same words', async () => {
    // Otherwise the refusal is an oracle for which session ids exist.
    const { bus } = makeBus([session('a', { bus: 'full' }), session('b')])
    const hidden = await refusal(bus, 'a', 'read_session', { session_id: 'b' })
    const missing = await refusal(bus, 'a', 'read_session', { session_id: 'nope' })
    assert.equal(hidden.replace('b', 'X'), missing.replace('nope', 'X'))
  })

  test('a session cannot address itself', async () => {
    const { bus } = makeBus([session('a', { bus: 'full' })])
    assert.match(await refusal(bus, 'a', 'read_session', { session_id: 'a' }), /cannot address itself/)
  })

  test('an unknown tool is refused rather than ignored', async () => {
    const { bus } = makeBus([session('a', { bus: 'full' })])
    assert.match(await refusal(bus, 'a', 'rm_rf', {}), /Unknown tool/)
  })
})

describe('what the bus reports', () => {
  test('list_sessions hides the caller, hides off-bus sessions, and states the limit', async () => {
    const { bus } = makeBus([
      session('a', { bus: 'read' }),
      session('b', { bus: 'read', status: 'working' }),
      session('c', { bus: 'full' }),
      session('d')
    ])
    const out = await bus.call('a', 'list_sessions', {})
    assert.deepEqual(
      out.sessions.map((s) => [s.session_id, s.can_message]),
      [
        ['b', false],
        ['c', true]
      ]
    )
    assert.equal(out.sessions[0].status, 'working')
  })

  test('read_session clamps the line count it was handed', async () => {
    const { bus, sessions } = makeBus([session('a', { bus: 'read' }), session('b', { bus: 'read' })])
    await bus.call('a', 'read_session', { session_id: 'b' })
    await bus.call('a', 'read_session', { session_id: 'b', lines: 99999 })
    assert.deepEqual(
      sessions.calls.map((c) => c[2]),
      [200, 4000]
    )
  })

  test('send_prompt will not submit an empty prompt', async () => {
    const { bus, sessions } = makeBus([session('a', { bus: 'read' }), session('b', { bus: 'full' })])
    assert.match(await refusal(bus, 'a', 'send_prompt', { session_id: 'b', text: '   ' }), /text is required/)
    assert.equal(sessions.calls.length, 0)
  })
})

describe('waiting on another session', () => {
  test('returns at once when the target is already there', async () => {
    const { bus } = makeBus([
      session('a', { bus: 'read' }),
      session('b', { bus: 'read', status: 'review' })
    ])
    const out = await bus.call('a', 'wait_for', { session_id: 'b' })
    assert.deepEqual(out, { session_id: 'b', status: 'review', timed_out: false, alive: true })
  })

  test('resolves on the transition, not on a poll', async () => {
    const { bus, sessions } = makeBus([
      session('a', { bus: 'read' }),
      session('b', { bus: 'read', status: 'working' })
    ])
    const pending = bus.call('a', 'wait_for', { session_id: 'b', timeout_seconds: 10 })
    // A change that is not the one asked for must not end the wait.
    sessions.set('b', { status: 'waiting' })
    await new Promise((r) => setImmediate(r))
    sessions.set('b', { status: 'review' })
    assert.equal((await pending).status, 'review')
  })

  test('a session that dies ends the wait whatever was asked for', async () => {
    // Otherwise the caller blocks for the full timeout on a session that can
    // never reach the status it wanted.
    const { bus, sessions } = makeBus([
      session('a', { bus: 'read' }),
      session('b', { bus: 'read', status: 'working' })
    ])
    const pending = bus.call('a', 'wait_for', { session_id: 'b', status: ['review'], timeout_seconds: 10 })
    sessions.set('b', { status: 'exited', alive: false })
    const out = await pending
    assert.equal(out.alive, false)
    assert.equal(out.timed_out, false)
  })

  test('a timeout says so instead of pretending the status was reached', async () => {
    const { bus } = makeBus([
      session('a', { bus: 'read' }),
      session('b', { bus: 'read', status: 'working' })
    ])
    // 0 is not a positive number, so it falls back to the default and would
    // hang; the clamp is exercised through the ledger instead.
    const out = await bus.call('a', 'wait_for', {
      session_id: 'b',
      status: ['review'],
      timeout_seconds: 0.05
    })
    assert.deepEqual(out, { session_id: 'b', status: 'working', timed_out: true, alive: true })
  })
})

describe('the ledger', () => {
  test('records refusals as prominently as successes', async () => {
    const { bus } = makeBus([session('a', { bus: 'read' }), session('b', { bus: 'read' })])
    await bus.call('a', 'read_session', { session_id: 'b' })
    await refusal(bus, 'a', 'send_prompt', { session_id: 'b', text: 'go' })

    const log = bus.entries()
    assert.equal(log.length, 2)
    assert.deepEqual(
      log.map((e) => [e.callerId, e.tool, e.targetId, e.ok]),
      [
        ['a', 'read_session', 'b', true],
        ['a', 'send_prompt', 'b', false]
      ]
    )
    assert.match(log[1].detail, /reachable at full/)
  })

  test('a refused call is logged even when the caller has no access at all', async () => {
    const { bus } = makeBus([session('a')])
    await refusal(bus, 'a', 'list_sessions')
    assert.equal(bus.entries().length, 1)
    assert.equal(bus.entries()[0].ok, false)
  })

  test('the ledger is capped, keeping the newest', async () => {
    const { bus } = makeBus([session('a', { bus: 'read' })])
    for (let i = 0; i < 260; i++) await refusal(bus, 'a', 'read_session', { session_id: `x${i}` })
    const log = bus.entries()
    assert.equal(log.length, 200)
    assert.equal(log[log.length - 1].targetId, 'x259')
  })
})

describe('the generated MCP server', () => {
  /** Drives the server over stdio the way a CLI would, and collects replies. */
  function client(scriptPath, env) {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const pending = new Map()
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c) => {
      buf += c
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        pending.get(msg.id)?.(msg)
        pending.delete(msg.id)
      }
    })
    let seq = 0
    return {
      child,
      request(method, params) {
        const id = ++seq
        return new Promise((resolve) => {
          pending.set(id, resolve)
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
        })
      },
      notify(method) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
      },
      stop() {
        child.kill()
      }
    }
  }

  test('speaks JSON-RPC over stdio and relays a tool call to the app', async () => {
    const dir = tempDir('bus-e2e-')
    const bridge = new HookBridge(dir, process.execPath)
    const { sessions } = makeBus([
      session('caller', { bus: 'read' }),
      session('target', { bus: 'full', status: 'working' })
    ])
    // Rebuilt against the bridge's own bin dir, so the scripts and the bridge
    // manifest land in the same place a real launch would put them.
    const wired = new SessionBus({
      sessions,
      binDir: dir,
      electronExecPath: process.execPath,
      enabled: () => true
    })
    wired.writeScripts()
    wired.mount(bridge)
    await bridge.start()

    const mcp = client(wired.paths.server, {
      TERMINAL_SESSION_ID: 'caller',
      ...wired.envFor('caller'),
      TERMINAL_BRIDGE_FILE: bridge.paths.bridgeFile
    })

    try {
      const init = await mcp.request('initialize', { protocolVersion: '2025-06-18' })
      assert.equal(init.result.protocolVersion, '2025-06-18')
      assert.ok(init.result.capabilities.tools)
      mcp.notify('notifications/initialized')

      // tools/list is answered locally, so it works with the app shut.
      const listed = await mcp.request('tools/list', {})
      assert.deepEqual(
        listed.result.tools.map((t) => t.name),
        BUS_TOOLS.map((t) => t.name)
      )

      const called = await mcp.request('tools/call', {
        name: 'read_session',
        arguments: { session_id: 'target', lines: 50 }
      })
      assert.equal(called.result.isError, undefined)
      const payload = JSON.parse(called.result.content[0].text)
      assert.equal(payload.text, 'screen of target')
      assert.equal(payload.status, 'working')

      // A refusal comes back as a readable tool error, not a protocol error —
      // the agent is meant to read it and adapt.
      const refused = await mcp.request('tools/call', {
        name: 'send_prompt',
        arguments: { session_id: 'nobody', text: 'hi' }
      })
      assert.equal(refused.result.isError, true)
      assert.match(refused.result.content[0].text, /reachable at full/)

      const unknown = await mcp.request('nonsense/method', {})
      assert.equal(unknown.error.code, -32601)
    } finally {
      mcp.stop()
      await bridge.stop()
    }
  })

  test('lists its tools and refuses calls when Workbench is not running', async () => {
    const dir = tempDir('bus-down-')
    const { bus } = makeBus([session('caller', { bus: 'read' })])
    bus.writeScripts()

    const mcp = client(bus.paths.server, {
      TERMINAL_SESSION_ID: 'caller',
      TERMINAL_BRIDGE_FILE: path.join(dir, 'no-such-bridge.json')
    })
    try {
      const listed = await mcp.request('tools/list', {})
      assert.equal(listed.result.tools.length, BUS_TOOLS.length)

      const called = await mcp.request('tools/call', {
        name: 'list_sessions',
        arguments: {}
      })
      assert.equal(called.result.isError, true)
      assert.match(called.result.content[0].text, /not running/i)
    } finally {
      mcp.stop()
    }
  })

  test('Focus reports use authenticated MCP and the durable UI store, with current-turn onboarding', { timeout: 10000 }, async () => {
    const h = scheduledBus(), { bus, scheduler, sessions, deps } = h
    const bridge = new HookBridge(path.dirname(bus.paths.server), process.execPath)
    bus.writeScripts(); bus.mount(bridge); await bridge.start()
    const mcp = client(bus.paths.server, { TERMINAL_SESSION_ID: 'ordinary',
      ...bus.envFor('ordinary'), TERMINAL_BRIDGE_FILE: bridge.paths.bridgeFile })
    const picture = path.join(h.projects[0].defaultCwd, 'milestone.svg')
    const artwork = '<svg xmlns="http://www.w3.org/2000/svg"><text x="5" y="20">Report transport checked</text></svg>'
    fs.writeFileSync(picture, artwork)
    sessions.set('ordinary', { cwd: h.projects[0].defaultCwd })
    const report = { kind: 'milestone', summary: 'Report transport checked',
      visual: { kind: 'image', path: 'milestone.svg', alt: 'The authored image reached the durable Focus report.' } }
    try {
      const init = await mcp.request('initialize', {})
      assert.match(init.result.instructions, /publish_focus_update/)
      assert.match(init.result.instructions, /current turn/)
      const list = await mcp.request('tools/list', {})
      assert.ok(list.result.tools.some((tool) => tool.name === 'publish_focus_update'))
      const before = structuredClone(sessions.get('ordinary'))
      const response = await mcp.request('tools/call', { name: 'publish_focus_update', arguments: report })
      assert.equal(response.result.isError, undefined)
      const { update } = JSON.parse(response.result.content[0].text)
      assert.equal(update.sessionId, 'ordinary')
      assert.equal(update.projectId, 'one')
      assert.equal(update.at, deps.now())
      assert.equal(update.visual.kind, 'image')
      assert.notEqual(update.visual.path, picture)
      assert.equal(fs.readFileSync(update.visual.path, 'utf8'), artwork)
      assert.deepEqual(new Experience(deps).snapshot().focusUpdates, [update])
      assert.deepEqual(sessions.get('ordinary'), before)
      assert.deepEqual(sessions.calls, [], 'publishing does not launch, prompt, or modify any terminal')

      const forged = await fetch(`http://127.0.0.1:${bridge.port}/bus/call`, { method: 'POST',
        headers: { 'x-terminal-token': bridge.token, 'content-type': 'application/json' },
        body: JSON.stringify({ callerId: 'manager', credential: bus.envFor('ordinary').TERMINAL_BUS_TOKEN,
          tool: 'publish_focus_update', args: report }) })
      const denied = await forged.json()
      assert.equal(denied.ok, false)
      assert.match(denied.error, /credential/)
      assert.deepEqual(scheduler.snapshot().focusUpdates, [update])
      sessions.set('ordinary', { bus: 'off' })
      const revoked = await mcp.request('tools/call', { name: 'publish_focus_update', arguments: report })
      assert.equal(revoked.result.isError, true)
      assert.match(revoked.result.content[0].text, /no bus access/)
      assert.deepEqual(scheduler.snapshot().focusUpdates, [update])
    } finally { mcp.stop(); await bridge.stop(); scheduler.stop() }
  })

  test('project progress is authenticated over MCP and reads the exact durable overview reports', { timeout: 10000 }, async () => {
    const { bus, sessions, scheduler, deps } = scheduledBus()
    sessions.set('manager', { bus: 'app-manager', busProjectId: null })
    const published = scheduler.publishFocusUpdate('ordinary', { kind: 'milestone', summary: 'Storage checks passed', next: 'Inspect the overview' })
    const before = scheduler.snapshot()
    const bridge = new HookBridge(path.dirname(bus.paths.server), process.execPath)
    bus.writeScripts(); bus.mount(bridge); await bridge.start()
    const mcp = client(bus.paths.server, { TERMINAL_SESSION_ID: 'manager',
      ...bus.envFor('manager'), TERMINAL_BRIDGE_FILE: bridge.paths.bridgeFile })
    try {
      const initialized = await mcp.request('initialize', {})
      assert.match(initialized.result.instructions, /get_project_progress/)
      const response = await mcp.request('tools/call', { name: 'get_project_progress', arguments: {} })
      assert.equal(response.result.isError, undefined)
      const progress = JSON.parse(response.result.content[0].text)
      assert.equal(progress.management_scope, 'app')
      assert.equal(progress.projects.length, 2)
      const one = progress.projects.find(p => p.project_id === 'one')
      assert.equal(one.reports[0].id, published.id)
      assert.equal(one.reports[0].reported_at, published.at)
      assert.equal(one.reports[0].next, 'Inspect the overview')
      assert.deepEqual(new Experience(deps).snapshot().focusUpdates, before.focusUpdates)
      const forged = await fetch(`http://127.0.0.1:${bridge.port}/bus/call`, { method: 'POST',
        headers: { 'x-terminal-token': bridge.token, 'content-type': 'application/json' },
        body: JSON.stringify({ callerId: 'manager', credential: bus.envFor('ordinary').TERMINAL_BUS_TOKEN,
          tool: 'get_project_progress', args: {} }) })
      assert.equal((await forged.json()).ok, false)
      assert.deepEqual(scheduler.snapshot(), before)
      assert.deepEqual(sessions.calls, [])
    } finally { mcp.stop(); await bridge.stop(); scheduler.stop() }
  })

  test('agent scheduling goes through MCP, authenticated HTTP, and the durable UI scheduler', { timeout: 10000 }, async () => {
    const { bus, scheduler, sessions, deps } = scheduledBus()
    const bridge = new HookBridge(path.dirname(bus.paths.server), process.execPath)
    bus.writeScripts(); bus.mount(bridge); await bridge.start()
    const mcp = client(bus.paths.server, { TERMINAL_SESSION_ID: 'manager',
      ...bus.envFor('manager'), TERMINAL_BRIDGE_FILE: bridge.paths.bridgeFile })
    const call = async (name, args = {}) => {
      const reply = await mcp.request('tools/call', { name, arguments: args })
      assert.equal(reply.result.isError, undefined, reply.result.content[0].text)
      return JSON.parse(reply.result.content[0].text)
    }
    try {
      const listed = await mcp.request('tools/list', {})
      assert.ok(listed.result.tools.some((tool) => tool.name === 'create_scheduled_task'))
      const { task } = await call('create_scheduled_task', scheduleArgs({ enabled: false }))
      assert.deepEqual(new Experience(deps).snapshot().tasks, [task])
      assert.equal(sessions.calls.length, 0, 'saving a task must not launch it')
      assert.equal((await call('list_scheduled_tasks')).tasks[0].id, task.id)
      const { run } = await call('run_scheduled_task', { task_id: task.id })
      assert.equal(run.status, 'launched')
      assert.equal(sessions.calls[0][1].permissionMode, 'default')
      const busy = await mcp.request('tools/call', { name: 'run_scheduled_task', arguments: { task_id: task.id } })
      assert.equal(busy.result.isError, true)
      assert.match(busy.result.content[0].text, /active run/)
      sessions.set(run.sessionId, { status: 'review' }); scheduler.syncRuns()
      await call('delete_scheduled_task', { task_id: task.id })
      const remaining = await call('list_scheduled_tasks')
      assert.deepEqual(remaining.tasks, [])
      assert.equal(remaining.runs[0].status, 'review')
      assert.ok(bus.entries().some((entry) => entry.tool === 'create_scheduled_task' && entry.ok))
    } finally { mcp.stop(); await bridge.stop(); scheduler.stop() }
  })

  test('the Claude config and Codex overrides point at the shim that exists', () => {
    const { bus } = makeBus([])
    bus.writeScripts()

    const cfg = JSON.parse(fs.readFileSync(bus.paths.claudeConfig, 'utf8'))
    assert.equal(cfg.mcpServers.workbench.command, toHostPath(bus.paths.shim))
    assert.ok(fs.existsSync(bus.paths.shim))
    assert.ok(fs.existsSync(bus.paths.server))

    const args = bus.codexConfigArgs()
    assert.deepEqual(args[0], '-c')
    assert.equal(args[1], `mcp_servers.workbench.command=${JSON.stringify(toHostPath(bus.paths.shim))}`)
    const allowed = JSON.parse(args.find(arg => arg.startsWith('mcp_servers.workbench.env_vars=')).split('=')[1])
    assert.deepEqual(allowed, ['TERMINAL_SESSION_ID', 'TERMINAL_BRIDGE_FILE', 'TERMINAL_BUS_TOKEN'])
    assert.ok(Number(args.find(arg => arg.startsWith('mcp_servers.workbench.tool_timeout_sec=')).split('=')[1]) > 600)
  })

  describe('reaching the agent that is launched', () => {
    const base = {
      bin: '/usr/local/bin/agent',
      cwd: '/tmp/project',
      claudeSettingsPath: '/x/settings.json',
      codexNotifyShim: '/x/notify.sh',
      codexSessionLogPath: null,
      newSessionId: '33333333-3333-4333-8333-333333333333'
    }

    test('Claude is pointed at the generated config, Codex at the shim', () => {
      const { bus } = makeBus([])
      const busMcp = {
        claudeMcpConfig: bus.paths.claudeConfig,
        codexArgs: bus.codexConfigArgs()
      }

      const claude = buildLaunchSpec({ ...base, definition: definitionOr('claude'), busMcp })
      const flag = claude.command.indexOf('--mcp-config')
      assert.ok(flag >= 0, 'claude launches with --mcp-config')
      assert.equal(claude.command[flag + 1], toHostPath(bus.paths.claudeConfig))

      const codex = buildLaunchSpec({ ...base, definition: definitionOr('codex'), busMcp })
      assert.ok(
        codex.command.some((a) => a.startsWith('mcp_servers.workbench.command=')),
        'codex launches with the server override'
      )
    })

    test('with the bus off, nothing about it appears in the argv', () => {
      for (const agent of ['claude', 'codex']) {
        const spec = buildLaunchSpec({ ...base, definition: definitionOr(agent), busMcp: null })
        assert.equal(
          spec.command.some((a) => a.includes('mcp') || a.includes('workbench')),
          false,
          `${agent} argv is untouched`
        )
      }
    })
  })
})

describe('project scheduling authority', () => {
  test('creates a visible durable task, lists its time zone and edits only supplied fields', async () => {
    const h = scheduledBus()
    const made = await h.bus.call('manager', 'create_scheduled_task', scheduleArgs())
    assert.equal(made.task.projectId, 'one')
    assert.equal(made.task.agent, 'claude', 'defaults to the calling advisor')
    assert.equal(made.task.enabled, true)
    assert.equal(made.requires_workbench_open, true)
    assert.ok(made.time_zone)
    assert.equal(h.sessions.calls.length, 0)
    const updated = await h.bus.call('manager', 'update_scheduled_task', { task_id: made.task.id, enabled: false })
    assert.equal(updated.task.prompt, made.task.prompt)
    assert.equal(updated.task.createdAt, made.task.createdAt)
    assert.equal(updated.task.enabled, false)
    assert.equal(h.changes(), 2, 'each save updates the same state used by the UI')
    assert.deepEqual(new Experience(h.deps).snapshot().tasks, [updated.task])
    assert.deepEqual((await h.bus.call('manager', 'list_scheduled_tasks', {})).tasks, [updated.task])
  })

  test('saved agent tasks execute when due with project context and ordinary permissions', async () => {
    const h = scheduledBus()
    h.scheduler.setProjectDetails('one', { description: '', instructions: 'Read project notes before writing the briefing.' })
    const { task } = await h.bus.call('manager', 'create_scheduled_task', scheduleArgs({ agent: 'codex' }))
    h.time(task.nextRunAt)
    await h.scheduler.tick()
    const options = h.sessions.calls[0][1]
    assert.equal(options.cwd, h.projects[0].defaultCwd)
    assert.equal(options.sessionProjectId, 'one')
    assert.equal(options.agent, 'codex')
    assert.equal(options.permissionMode, 'default')
    assert.match(options.initialPrompt, /Read project notes/)
    assert.match(options.initialPrompt, /Write a project briefing/)
    assert.equal(h.scheduler.snapshot().runs[0].status, 'launched')
    await h.scheduler.tick()
    assert.equal(h.sessions.calls.length, 1)
  })

  test('a failed task save can be retried after the storage problem is resolved', async () => {
    const h = scheduledBus()
    const blocked = path.join(h.deps.directory, 'experience.json.tmp')
    fs.mkdirSync(blocked)
    assert.match(await refusal(h.bus, 'manager', 'create_scheduled_task', scheduleArgs()), /not saved/)
    assert.match(await refusal(h.bus, 'manager', 'list_scheduled_tasks'), /not saved/)
    fs.rmdirSync(blocked)
    const { task } = await h.bus.call('manager', 'create_scheduled_task', scheduleArgs({ enabled: false }))
    assert.deepEqual(new Experience(h.deps).snapshot().tasks, [task])
    assert.equal(h.scheduler.snapshot().error, null)
  })

  test('foreign tasks and their run history cannot be read or targeted using copied IDs', async () => {
    const h = scheduledBus()
    const foreign = h.scheduler.saveTask({ ...scheduleArgs(), projectId: 'two', agent: 'codex', weekday: 1, enabled: false })
    await h.scheduler.runTask(foreign.id)
    const roster = await h.bus.call('manager', 'list_scheduled_tasks', {})
    assert.deepEqual(roster.tasks, [])
    assert.deepEqual(roster.runs, [])
    for (const tool of ['update_scheduled_task', 'run_scheduled_task', 'delete_scheduled_task']) {
      const patch = tool === 'update_scheduled_task' ? { enabled: true } : {}
      const hidden = await refusal(h.bus, 'manager', tool, { task_id: foreign.id, ...patch })
      const missing = await refusal(h.bus, 'manager', tool, { task_id: 'missing', ...patch })
      assert.match(hidden, /managed project/)
      assert.equal(hidden, missing)
    }
    assert.equal(h.scheduler.snapshot().tasks[0].enabled, false)
  })

  test('ordinary grants, revoked managers and the master switch cannot schedule agents', async () => {
    const h = scheduledBus()
    for (const tool of ['list_scheduled_tasks', 'create_scheduled_task', 'update_scheduled_task', 'run_scheduled_task', 'delete_scheduled_task']) {
      assert.match(await refusal(h.bus, 'ordinary', tool), /Manager grant/)
    }
    h.enableBus(false)
    assert.match(await refusal(h.bus, 'manager', 'create_scheduled_task', scheduleArgs()), /switched off/)
    h.enableBus(true)
    h.sessions.set('manager', { sessionProjectId: 'two' })
    assert.match(await refusal(h.bus, 'manager', 'create_scheduled_task', scheduleArgs()), /no bus access/)
    assert.deepEqual(h.scheduler.snapshot().tasks, [])
    assert.equal(h.sessions.calls.length, 0)
  })

  test('task arguments cannot override project, execution permissions or unsupported scheduling fields', async () => {
    const h = scheduledBus()
    for (const patch of [{ projectId: 'two' }, { project_id: 'two' }, { cwd: '/elsewhere' },
      { permissionMode: 'bypass' }, { id: 'forged' }, { agent: 'shell' }, { time: '24:00' },
      { cadence: 'monthly' }, { cadence: 'weekly' }, { enabled: 'yes' }, { prompt: '' }]) {
      assert.ok(await refusal(h.bus, 'manager', 'create_scheduled_task', scheduleArgs(patch)), JSON.stringify(patch))
    }
    assert.deepEqual(h.scheduler.snapshot().tasks, [])
    const { task } = await h.bus.call('manager', 'create_scheduled_task', scheduleArgs())
    assert.match(await refusal(h.bus, 'manager', 'update_scheduled_task', { task_id: task.id }), /at least one/)
    assert.match(await refusal(h.bus, 'manager', 'update_scheduled_task', { task_id: task.id, cadence: 'weekly' }), /weekday/)
    const weekly = await h.bus.call('manager', 'update_scheduled_task', { task_id: task.id, cadence: 'weekly', weekday: 5 })
    assert.equal(weekly.task.weekday, 5)
  })

  test('pausing preserves an active run, deletion waits for it, and run history survives deletion', async () => {
    const h = scheduledBus()
    const { task } = await h.bus.call('manager', 'create_scheduled_task', scheduleArgs())
    const { run } = await h.bus.call('manager', 'run_scheduled_task', { task_id: task.id })
    await h.bus.call('manager', 'update_scheduled_task', { task_id: task.id, enabled: false })
    assert.equal(h.sessions.get(run.sessionId).alive, true)
    assert.match(await refusal(h.bus, 'manager', 'delete_scheduled_task', { task_id: task.id }), /run is active/)
    h.sessions.set(run.sessionId, { status: 'review' }); h.scheduler.syncRuns()
    await h.bus.call('manager', 'delete_scheduled_task', { task_id: task.id })
    const restored = new Experience(h.deps).snapshot()
    assert.deepEqual(restored.tasks, [])
    assert.equal(restored.runs[0].id, run.id)
  })

  test('revocation during a run launch blocks the reply without granting the worker extra access', async () => {
    const h = scheduledBus()
    const { task } = await h.bus.call('manager', 'create_scheduled_task', scheduleArgs({ enabled: false }))
    const create = h.sessions.create
    h.sessions.create = async (options) => {
      const made = await create(options)
      h.sessions.set('manager', { bus: 'off' })
      return made
    }
    assert.match(await refusal(h.bus, 'manager', 'run_scheduled_task', { task_id: task.id }), /no bus access/)
    assert.equal(h.sessions.get('created').bus, 'off')
    assert.equal(h.scheduler.snapshot().runs[0].status, 'launched')
  })
})

describe('App Manager session authority', () => {
  function appManaged(over = {}) {
    const projects = ['one', 'two'].map((id) => ({ id, name: `Project ${id}`, defaultCwd: tempDir('app-manager-project-') }))
    let enabled = true
    const env = makeBus([
      session('central', { bus: 'app-manager', busProjectId: null, sessionProjectId: 'one' }),
      session('worker-one', { sessionProjectId: 'one' }),
      session('worker-two', { sessionProjectId: 'two' }),
      session('unfiled', { sessionProjectId: null }),
      session('project-manager', { bus: 'manager', busProjectId: 'one', sessionProjectId: 'one' }),
      session('ordinary', { bus: 'full', sessionProjectId: 'one' })
    ], { project: (id) => projects.find((p) => p.id === id), projects: () => projects,
      enabled: () => enabled, context: (id, prompt) => `Context for ${id}\n${prompt}`, ...over })
    return { ...env, projects, enable: (value) => { enabled = value } }
  }

  test('discovers real projects and manages off-bus sessions across the app including unfiled', async () => {
    const { bus, projects } = appManaged()
    const found = await bus.call('central', 'list_projects', {})
    assert.equal(found.management_scope, 'app')
    assert.deepEqual(found.projects, projects.map(p => ({ project_id: p.id, name: p.name, default_cwd: p.defaultCwd, can_create: true })))
    const roster = await bus.call('central', 'list_sessions', {})
    assert.equal(roster.management_scope, 'app')
    assert.equal(roster.managed_project_id, null)
    assert.deepEqual(roster.sessions.map(s => s.session_id), ['worker-one', 'worker-two', 'unfiled', 'project-manager', 'ordinary'])
    assert.ok(roster.sessions.every(s => s.can_manage && s.can_message))
    for (const target of ['worker-two', 'unfiled']) {
      assert.equal((await bus.call('central', 'read_session', { session_id: target })).text, `screen of ${target}`)
      assert.equal((await bus.call('central', 'send_prompt', { session_id: target, text: 'Review the current work.' })).submitted, true)
    }
  })

  test('creates separate ordinary workers in both actual project folders with their own instructions', async () => {
    const { bus, sessions, projects } = appManaged()
    const createdIds = []
    for (const project of projects) {
      const made = await bus.call('central', 'create_session', { agent: 'codex', title: 'Reviewer', project_id: project.id, prompt: 'Review it.' })
      createdIds.push(made.session_id)
      assert.equal(made.project_id, project.id)
      assert.equal(made.cwd, project.defaultCwd)
      const child = sessions.get(made.session_id)
      assert.equal(child.bus, 'full')
      assert.equal(child.busProjectId ?? null, null)
      assert.equal(child.sessionProjectId, project.id)
      assert.equal(child.permissionMode, 'default')
      assert.equal(child.parentId, 'central')
      assert.equal(child.initialPrompt, `Context for ${project.id}\nReview it.`)
      assert.match(await refusal(bus, child.id, 'create_session', { agent: 'codex', title: 'Unwanted manager tree', project_id: project.id }), /Manager grant/)
    }
    assert.equal(new Set(createdIds).size, 2)
  })

  test('Project Manager discovery/creation stays in its original project', async () => {
    const { bus, sessions } = appManaged()
    const found = await bus.call('project-manager', 'list_projects', {})
    assert.equal(found.management_scope, 'project')
    assert.deepEqual(found.projects.map(p => p.project_id), ['one'])
    assert.match(await refusal(bus, 'project-manager', 'create_session', { agent: 'codex', title: 'No', project_id: 'two' }), /within your Manager grant/)
    assert.match(await refusal(bus, 'project-manager', 'read_session', { session_id: 'worker-two' }), /reachable/)
    const made = await bus.call('project-manager', 'create_session', { agent: 'codex', title: 'Reviewer', project_id: 'one' })
    assert.equal(made.project_id, 'one')
    assert.equal(sessions.get('project-manager').bus, 'manager')
  })

  test('creation requires a real explicit project and refuses forged execution or grant arguments', async () => {
    const { bus, sessions } = appManaged()
    const base = { agent: 'codex', title: 'Reviewer' }
    for (const project_id of [undefined, '', null, 42, 'missing']) {
      assert.ok(await refusal(bus, 'central', 'create_session', { ...base, ...(project_id === undefined ? {} : { project_id }) }))
    }
    for (const extra of [{ cwd: '/forged' }, { sessionProjectId: 'two' }, { permissionMode: 'full-access' },
      { bus: 'app-manager' }, { busProjectId: null }, { callerId: 'ordinary' }, { parentId: 'ordinary' }, { extraArgs: ['--bypass'] }]) {
      assert.match(await refusal(bus, 'central', 'create_session', { ...base, project_id: 'one', ...extra }), /Unsupported/)
    }
    assert.match(await refusal(bus, 'central', 'list_projects', { project_id: 'one' }), /Unsupported/)
    assert.match(await refusal(bus, 'ordinary', 'list_projects'), /Manager grant/)
    assert.equal(sessions.calls.length, 0)
  })

  test('unavailable/deleted projects never launch and discovery labels an unavailable folder', async () => {
    const { bus, projects, sessions } = appManaged()
    projects[1].defaultCwd += '/missing'
    assert.equal((await bus.call('central', 'list_projects', {})).projects[1].can_create, false)
    assert.match(await refusal(bus, 'central', 'create_session', { agent: 'codex', title: 'Reviewer', project_id: 'two' }), /folder is unavailable/)
    projects.splice(1, 1)
    assert.match(await refusal(bus, 'central', 'create_session', { agent: 'codex', title: 'Reviewer', project_id: 'two' }), /No project/)
    assert.equal(sessions.calls.length, 0)
  })

  test('app workers and unfiled sessions support the normal management lifecycle', async () => {
    for (const target of ['worker-two', 'unfiled']) {
      const { bus, sessions } = appManaged()
      await bus.call('central', 'update_session', { session_id: target, title: 'Reviewer', pinned: true })
      assert.equal(sessions.get(target).title, 'Reviewer')
      assert.equal(sessions.get(target).pinned, true)
      await bus.call('central', 'interrupt_session', { session_id: target })
      await bus.call('central', 'stop_session', { session_id: target })
      assert.equal(sessions.get(target).alive, false)
      await bus.call('central', 'restart_session', { session_id: target })
      assert.equal(sessions.get(target).alive, true)
      await bus.call('central', 'delete_session', { session_id: target })
      assert.equal(sessions.get(target), undefined)
    }
  })

  test('forking other projects, unfiled sessions and the App Manager never grants management', async () => {
    for (const source of ['worker-two', 'unfiled', 'central']) {
      const { bus, sessions } = appManaged()
      const projectId = sessions.get(source).sessionProjectId
      const made = await bus.call('central', 'fork_session', { session_id: source })
      const child = sessions.get(made.session_id)
      assert.equal(made.project_id, projectId)
      assert.equal(child.sessionProjectId, projectId)
      assert.equal(child.bus, 'full')
      assert.equal(child.busProjectId ?? null, null)
    }
  })

  test('grant/master/project/folder changes during creation leave the child off the bus', async () => {
    for (const change of ['grant', 'downgrade', 'remove-caller', 'master', 'delete-project', 'folder', 'wrong-child-project', 'fallback-folder']) {
      const { bus, sessions, projects, enable } = appManaged()
      const create = sessions.create
      sessions.create = async (opts) => {
        const child = await create(opts)
        if (change === 'grant') sessions.set('central', { bus: 'off' })
        if (change === 'downgrade') sessions.set('central', { bus: 'manager', busProjectId: 'one' })
        if (change === 'remove-caller') await sessions.remove('central')
        if (change === 'master') enable(false)
        if (change === 'delete-project') projects.splice(0, 1)
        if (change === 'folder') projects[0].defaultCwd = projects[1].defaultCwd
        if (change === 'wrong-child-project') sessions.set(child.id, { sessionProjectId: 'two' })
        if (change === 'fallback-folder') sessions.set(child.id, { cwd: '/unwanted-home' })
        return child
      }
      assert.ok(await refusal(bus, 'central', 'create_session', { agent: 'codex', title: 'Reviewer', project_id: 'one' }), change)
      assert.equal(sessions.get('created').bus, 'off', change)
    }
  })

  test('revocation and a moved fork source are rechecked before returning a reachable child', async () => {
    for (const change of ['revoke', 'move']) {
      const { bus, sessions } = appManaged()
      const fork = sessions.fork
      sessions.fork = async (opts) => {
        const child = await fork(opts)
        if (change === 'revoke') sessions.set('central', { bus: 'off' })
        else sessions.set('worker-two', { sessionProjectId: 'one' })
        return child
      }
      assert.ok(await refusal(bus, 'central', 'fork_session', { session_id: 'worker-two' }), change)
      assert.equal(sessions.get('sess_forked').bus, 'off')
    }
  })

  test('reads and legacy sends do not return results after the App Manager loses access', async () => {
    for (const operation of ['read_session', 'send_prompt']) {
      const { bus, sessions } = appManaged()
      if (operation === 'read_session') sessions.captureText = async () => { sessions.set('central', { bus: 'off' }); return 'Private result' }
      else sessions.sendPrompt = async () => { sessions.set('central', { bus: 'off' }) }
      assert.match(await refusal(bus, 'central', operation, { session_id: 'worker-two', ...(operation === 'send_prompt' ? { text: 'Review' } : {}) }), /no bus access/)
    }
  })

  test('relay authorization is rechecked while settling and before reply disclosure', async () => {
    for (const stage of ['settling', 'reply']) {
      let sessions
      const env = appManaged({ relay: async (_request, authorize) => {
        authorize()
        sessions.set('central', { bus: 'off' })
        if (stage === 'settling') authorize()
        return { ok: true, phase: 'completed', reply: 'Private result' }
      } })
      sessions = env.sessions
      assert.match(await refusal(env.bus, 'central', 'send_prompt', { session_id: 'worker-two', text: 'Review', wait: true }), /no bus access/)
    }
  })

  test('in-flight waits stop on app grant revocation, caller removal or master disable', async () => {
    for (const change of ['grant', 'remove', 'master']) {
      const { bus, sessions, enable } = appManaged()
      sessions.set('worker-two', { status: 'working' })
      const pending = bus.call('central', 'wait_for', { session_id: 'worker-two', timeout_seconds: 2 })
      const rejected = assert.rejects(pending, /access|known|switched off/)
      if (change === 'grant') sessions.set('central', { bus: 'off' })
      if (change === 'remove') await sessions.remove('central')
      if (change === 'master') enable(false)
      await rejected
      assert.equal(sessions.listenerCount(), 0)
    }
  })

  test('app scope rejects malformed bindings and does not add scheduler authority', async () => {
    const { bus, sessions } = appManaged()
    for (const tool of ['list_scheduled_tasks', 'create_scheduled_task', 'update_scheduled_task', 'run_scheduled_task', 'delete_scheduled_task']) {
      assert.match(await refusal(bus, 'central', tool, {}), /project Manager grant/)
    }
    for (const binding of ['one', undefined]) {
      sessions.set('central', { busProjectId: binding })
      assert.match(await refusal(bus, 'central', 'list_sessions'), /no bus access/)
    }
    assert.equal(sessions.calls.length, 0)
  })

  test('App Manager credentials still identify only that caller', () => {
    const { bus } = appManaged()
    const token = bus.envFor('central').TERMINAL_BUS_TOKEN
    bus.authenticate('central', token)
    assert.throws(() => bus.authenticate('ordinary', token), /credential/)
    assert.throws(() => bus.authenticate('central', bus.envFor('ordinary').TERMINAL_BUS_TOKEN), /credential/)
  })

  function progressManaged() {
    const state = emptyExperience()
    const env = appManaged({ scheduler: () => ({ snapshot: () => structuredClone(state) }) })
    const now = Date.now()
    for (const row of env.sessions.list()) env.sessions.set(row.id, { createdAt: now - 60000,
      lastPromptAt: now - 30000, lastStatusChangeAt: now - 20000, statusSource: 'hook', lastActivityAt: now })
    const report = (id, sessionId, projectId, patch = {}) => ({ id, sessionId, projectId,
      at: now - 10000, kind: 'milestone', summary: 'Parser checks passed', next: 'Review the interface', ...patch })
    state.focusUpdates = [report('one-report', 'worker-one', 'one'), report('two-report', 'worker-two', 'two')]
    return { ...env, state, now, report }
  }

  test('project progress uses the shared overview selection and the actual report visual', async () => {
    const { bus, sessions, projects, state } = progressManaged()
    sessions.set('worker-one', { lastTask: 'Build the parser', lastPromptAt: Date.now() })
    const before = structuredClone(state)
    const result = await bus.call('central', 'get_project_progress', {})
    assert.equal(result.management_scope, 'app')
    assert.equal(result.total_projects, 2)
    for (const card of result.projects) {
      const project = projects.find(p => p.id === card.project_id)
      const shared = projectFocus(project.id, sessions.list(), state.focusUpdates, state.archivedIds)
      assert.deepEqual(card.workers.map(w => w.session_id), shared.workers.map(w => w.id))
      assert.deepEqual(card.reports.map(r => r.id), shared.reports.map(r => r.id))
      assert.equal(card.latest_report_id, shared.latest.id)
      assert.equal(card.task_art, null, 'a task name does not select generic artwork')
      assert.deepEqual(card.latest_visual, shared.latest?.visual ?? null)
      assert.equal(card.reports[0].source, 'agent_report')
      assert.equal(card.reports[0].next, 'Review the interface')
      assert.ok(card.workers.every(w => w.source === 'observed_session_snapshot'))
    }
    assert.deepEqual(state, before)
    assert.equal(sessions.calls.length, 0, 'progress does not prompt agents or read terminals')
  })

  test('progress enforces App/Project Manager scope and refuses ordinary workers', async () => {
    const { bus } = progressManaged()
    const own = await bus.call('project-manager', 'get_project_progress', {})
    assert.equal(own.total_projects, 1)
    assert.deepEqual(own.projects.map(p => p.project_id), ['one'])
    assert.match(await refusal(bus, 'project-manager', 'get_project_progress', { project_id: 'two' }), /within your Manager grant/)
    for (const project_id of [undefined, 'one', 'two']) {
      assert.match(await refusal(bus, 'ordinary', 'get_project_progress', project_id ? { project_id } : {}), /Manager grant/)
    }
    assert.match(await refusal(bus, 'central', 'get_project_progress', { project_id: 'missing' }), /No project/)
  })

  test('archived reports remain labeled history while moved/removed authors never transfer reports', async () => {
    const { bus, sessions, state, report } = progressManaged()
    state.archivedIds = ['worker-one']
    state.focusUpdates.push(report('removed-report', 'removed', 'one'))
    sessions.set('worker-two', { sessionProjectId: 'one' })
    const result = await bus.call('central', 'get_project_progress', {})
    const one = result.projects.find(p => p.project_id === 'one')
    assert.equal(one.workers.some(w => w.session_id === 'worker-one'), false)
    assert.deepEqual(one.reports.map(r => r.id), ['one-report'])
    assert.equal(one.reports[0].archived_history, true)
    assert.deepEqual(result.projects.find(p => p.project_id === 'two').reports, [])
    assert.equal(JSON.stringify(result).includes('removed-report'), false)
    assert.equal(JSON.stringify(result).includes('two-report'), false)
  })

  test('old reports keep source time and newer-request warnings despite fresh terminal activity', async () => {
    const { bus, sessions, state, now } = progressManaged()
    const oldAt = now - 2 * 86400000
    state.focusUpdates[0].at = oldAt
    sessions.set('worker-one', { lastPromptAt: now - 1000, lastActivityAt: now + 100000 })
    const one = (await bus.call('central', 'get_project_progress', { project_id: 'one' })).projects[0]
    assert.equal(one.reports[0].reported_at, oldAt)
    assert.deepEqual(one.reports[0].stale_reasons, ['newer_request', 'older_than_24_hours'])
    assert.equal(one.reports[0].stale, true)
    state.focusUpdates[0].at = now + 600000
    const future = (await bus.call('central', 'get_project_progress', { project_id: 'one' })).projects[0].reports[0]
    assert.deepEqual(future.stale_reasons, ['future_timestamp'])
  })

  test('progress pages projects/workers and bounds report history without hiding coverage', async () => {
    const { bus, sessions, projects, state, report, now } = progressManaged()
    for (let i = 3; i <= 11; i++) projects.push({ ...projects[0], id: `project-${i}`, name: `Project ${i}` })
    for (let i = 0; i < 16; i++) await sessions.create({ agent: 'codex', title: `Worker ${i}`, sessionProjectId: 'one', createdAt: now + i })
    state.focusUpdates = Array.from({ length: 20 }, (_, i) => report(`milestone-${i}`, 'worker-one', 'one', { at: now - i }))
    const first = await bus.call('central', 'get_project_progress', {})
    assert.equal(first.projects.length, 8)
    assert.equal(first.total_projects, 11)
    assert.equal(first.next_project_offset, 8)
    const second = await bus.call('central', 'get_project_progress', { project_offset: first.next_project_offset })
    assert.equal(second.projects.length, 3)
    assert.equal(second.next_project_offset, null)
    const one = first.projects[0]
    assert.equal(one.workers.length, 12)
    assert.equal(one.worker_count, 20)
    assert.equal(one.next_worker_offset, 12)
    assert.equal(one.reports.length, 6)
    assert.equal(one.reports[0].id, 'milestone-0')
    const remaining = (await bus.call('central', 'get_project_progress', { project_id: 'one', worker_offset: 12 })).projects[0]
    assert.equal(remaining.workers.length, 8)
    assert.equal(remaining.next_worker_offset, null)
    assert.equal(new Set([...one.workers, ...remaining.workers].map(w => w.session_id)).size, 20)
  })

  test('progress validates selectors/pagination and reveals no data after revocation', async () => {
    const { bus } = progressManaged()
    for (const field of ['project_offset', 'worker_offset']) {
      for (const value of [-1, 0.5, '1', null, Infinity, 100001]) {
        assert.ok(await refusal(bus, 'central', 'get_project_progress', { project_id: 'one', [field]: value }))
      }
    }
    for (const args of [{ project_id: '' }, { project_id: 2 }, { project_id: 'one', project_offset: 1 },
      { worker_offset: 1 }, { callerId: 'project-manager' }, { include_archived_workers: true }]) {
      assert.ok(await refusal(bus, 'central', 'get_project_progress', args))
    }
    let sessions
    const revoked = appManaged({ scheduler: () => ({ snapshot: () => {
      sessions.set('central', { bus: 'off' }); return emptyExperience()
    } }) })
    sessions = revoked.sessions
    assert.match(await refusal(revoked.bus, 'central', 'get_project_progress'), /no bus access/)
  })

  test('unavailable saved progress is explicit and never presented as zero verified activity', async () => {
    const { bus, state } = progressManaged()
    state.error = 'Private storage path failed'
    const data = await bus.call('central', 'get_project_progress', {})
    assert.equal(data.data_status, 'unavailable')
    assert.ok(data.warnings.length)
    assert.equal(JSON.stringify(data).includes('Private storage path'), false)
    const unavailable = appManaged({ scheduler: () => null })
    assert.match(await refusal(unavailable.bus, 'central', 'get_project_progress'), /not ready/)
  })
})

describe('project manager authority', () => {
  function managed() {
    const project = { id: 'one', name: 'Project One', defaultCwd: tempDir('bus-project-') }
    const env = makeBus([
      session('manager', { bus: 'manager', busProjectId: 'one', sessionProjectId: 'one' }),
      session('worker', { sessionProjectId: 'one' }),
      session('outside', { bus: 'full', sessionProjectId: 'two' }),
      session('ordinary', { bus: 'full', sessionProjectId: 'one' })
    ], { project: id => id === project.id ? project : undefined })
    return { ...env, project }
  }
  test('manager sees and drives off-bus project sessions, never another project', async () => {
    const { bus, sessions } = managed()
    const roster = await bus.call('manager', 'list_sessions', {})
    assert.equal(roster.managed_project_id, 'one')
    assert.deepEqual(roster.sessions.map(s => s.session_id), ['worker', 'ordinary'])
    assert.ok(roster.sessions.every(s => s.can_manage && s.can_message))
    await bus.call('manager', 'send_prompt', { session_id: 'worker', text: 'hello' })
    for (const tool of ['read_session', 'send_prompt', 'fork_session', 'update_session', 'delete_session', 'stop_session', 'restart_session', 'interrupt_session']) {
      const args = { session_id: 'outside', ...(tool === 'send_prompt' ? { text: 'hello' } : {}) }
      assert.match(await refusal(bus, 'manager', tool, args), /reachable/)
    }
    assert.equal(sessions.calls.length, 1)
  })
  test('creates a reachable worker in the authorized folder with normal CLI permissions', async () => {
    const { bus, sessions, project } = managed()
    const created = await bus.call('manager', 'create_session', { agent: 'codex', title: 'Worker 2', prompt: 'hello' })
    assert.equal(created.project_id, 'one')
    assert.equal(sessions.get(created.session_id).bus, 'full')
    assert.deepEqual(sessions.calls[0], ['create', {
      agent: 'codex', title: 'Worker 2', cwd: project.defaultCwd, sessionProjectId: 'one',
      parentId: 'manager', forkKind: 'child', permissionMode: 'default', initialPrompt: 'hello'
    }])
    assert.equal(sessions.get(created.session_id).busProjectId, undefined)
  })
  test('manager can fork its own context without delegating Manager access', async () => {
    const { bus, sessions } = managed()
    const forked = await bus.call('manager', 'fork_session', { session_id: 'manager', kind: 'child' })
    assert.equal(sessions.get(forked.session_id).sessionProjectId, 'one')
    assert.equal(sessions.get(forked.session_id).bus, 'full')
    assert.equal(sessions.get(forked.session_id).busProjectId, undefined)
  })
  test('unavailable project folders fail instead of falling back to home', async () => {
    const { bus, sessions, project } = managed()
    project.defaultCwd += '/missing'
    assert.ok(await refusal(bus, 'manager', 'create_session', { agent: 'codex', title: 'Never created' }))
    assert.equal(sessions.calls.length, 0)
  })
  test('revoking Manager during launch leaves the already-started child off the bus', async () => {
    const { bus, sessions } = managed()
    const create = sessions.create
    sessions.create = async opts => { const child = await create(opts); sessions.set('manager', { bus: 'off' }); return child }
    assert.match(await refusal(bus, 'manager', 'create_session', { agent: 'codex', title: 'Worker' }), /no bus access/)
    assert.equal(sessions.get('created').bus, 'off')
  })
  test('manager can edit, interrupt, stop, restart and delete its workers', async () => {
    const { bus, sessions } = managed()
    await bus.call('manager', 'update_session', { session_id: 'worker', title: 'Renamed', pinned: true })
    assert.equal(sessions.get('worker').title, 'Renamed')
    assert.equal(sessions.get('worker').pinned, true)
    await bus.call('manager', 'interrupt_session', { session_id: 'worker' })
    await bus.call('manager', 'stop_session', { session_id: 'worker' })
    assert.equal(sessions.get('worker').alive, false)
    await bus.call('manager', 'restart_session', { session_id: 'worker' })
    assert.equal(sessions.get('worker').alive, true)
    await bus.call('manager', 'delete_session', { session_id: 'worker' })
    assert.equal(sessions.get('worker'), undefined)
  })
  test('ordinary Full grants do not allow management or self-promotion', async () => {
    const { bus, sessions } = managed()
    for (const tool of ['create_session', 'update_session', 'delete_session', 'stop_session', 'restart_session', 'interrupt_session']) {
      assert.match(await refusal(bus, 'ordinary', tool, {}), /Manager grant/)
    }
    assert.match(await refusal(bus, 'manager', 'update_session', { session_id: 'worker', bus: 'manager' }), /Unsupported/)
    assert.match(await refusal(bus, 'manager', 'create_session', { agent: 'codex', title: 'test', cwd: '/elsewhere' }), /Unsupported/)
    assert.match(await refusal(bus, 'manager', 'update_session', { session_id: 'worker', title: 'changed', pinned: 'yes' }), /boolean/)
    assert.equal(sessions.get('worker').title, 'session worker')
    assert.equal(sessions.calls.length, 0)
  })
  test('a moved, unfiled or invalid manager loses all authority', async () => {
    const { bus, sessions } = managed()
    for (const projectId of ['two', null]) {
      sessions.set('manager', { sessionProjectId: projectId })
      assert.match(await refusal(bus, 'manager', 'list_sessions'), /no bus access/)
    }
    sessions.set('manager', { sessionProjectId: 'one', busProjectId: null })
    assert.match(await refusal(bus, 'manager', 'list_sessions'), /no bus access/)
  })
  test('waiting stops on caller or target revocation, removal, project moves and master switch', async () => {
    for (const change of ['caller', 'target', 'remove', 'move', 'master']) {
      let enabled = true
      const { bus, sessions } = makeBus([
        session('a', { bus: 'read' }), session('b', { bus: 'full', status: 'working' })
      ], { enabled: () => enabled })
      const pending = bus.call('a', 'wait_for', { session_id: 'b', timeout_seconds: 2 })
      const rejected = assert.rejects(pending, /access|reachable|switched off/)
      if (change === 'caller') sessions.set('a', { bus: 'off' })
      if (change === 'target' || change === 'move') sessions.set('b', { bus: 'off' })
      if (change === 'remove') await sessions.remove('b')
      if (change === 'master') enabled = false
      await rejected
      assert.equal(sessions.listenerCount(), 0)
    }
    const { bus, sessions } = managed()
    sessions.set('worker', { status: 'working' })
    const pending = bus.call('manager', 'wait_for', { session_id: 'worker', timeout_seconds: 2 })
    const rejected = assert.rejects(pending, /reachable/)
    sessions.set('worker', { sessionProjectId: 'two' })
    await rejected
    assert.equal(sessions.listenerCount(), 0)
  })
  test('credentials bind caller identity and survive an app restart without entering tool configs', () => {
    const { bus, sessions, project } = managed()
    const token = bus.envFor('manager').TERMINAL_BUS_TOKEN
    bus.authenticate('manager', token)
    assert.throws(() => bus.authenticate('ordinary', token), /credential/)
    assert.throws(() => bus.authenticate('manager', ''), /credential/)
    const reopened = new SessionBus({ sessions, binDir: path.dirname(bus.paths.server), electronExecPath: process.execPath,
      enabled: () => true, project: id => id === 'one' ? project : undefined })
    reopened.authenticate('manager', token)
    bus.writeScripts()
    assert.ok(!fs.readFileSync(bus.paths.claudeConfig, 'utf8').includes(token))
    assert.ok(!bus.codexConfigArgs().join(' ').includes(token))
  })
  test('HTTP MCP and legacy CLI routes enforce the same credential, grant and project boundary', async () => {
    const { bus, sessions } = managed()
    const bridge = new HookBridge(path.dirname(bus.paths.server), process.execPath)
    bus.mount(bridge)
    await bridge.start()
    const post = async (route, body) => (await fetch(`http://127.0.0.1:${bridge.port}${route}`, {
      method: 'POST', headers: { 'x-terminal-token': bridge.token, 'content-type': 'application/json' }, body: JSON.stringify(body)
    })).json()
    try {
      const credential = bus.envFor('manager').TERMINAL_BUS_TOKEN
      const roster = await post('/sessions', { termSessionId: 'manager', credential })
      assert.equal(roster.ok, true)
      assert.deepEqual(roster.value.sessions.map(s => s.id), ['worker', 'ordinary'])
      const sent = await post('/relay', { termSessionId: 'manager', credential, to: '@worker', message: 'hello' })
      assert.equal(sent.ok, true)
      assert.equal(sessions.calls[0][0], 'sendPrompt')
      const outside = await post('/relay', { termSessionId: 'manager', credential, to: '@outside', message: 'hello' })
      assert.equal(outside.ok, false)
      for (const route of ['/sessions', '/relay', '/bus/call']) {
        const denied = await post(route, { termSessionId: 'manager', callerId: 'manager', tool: 'list_sessions', credential: bus.envFor('ordinary').TERMINAL_BUS_TOKEN })
        assert.equal(denied.ok, false)
        assert.match(denied.error, /credential/)
      }
      sessions.set('manager', { bus: 'off' })
      assert.equal((await post('/sessions', { termSessionId: 'manager', credential })).ok, false)
    } finally { await bridge.stop() }
  })
})

/** Reports have self authority only; they do not reuse manager targeting even
 * when a caller could otherwise edit or message every session in its project. */
describe('agent-authored Focus reports', () => {
  const report = (patch = {}) => ({ kind: 'update', summary: 'Checking the report integration', ...patch })

  test('Read, Full and Manager may report only their own work with server-owned metadata', async () => {
    const h = scheduledBus()
    for (const grant of ['read', 'full']) {
      h.sessions.set('ordinary', { bus: grant, status: 'working' })
      const before = structuredClone(h.sessions.get('ordinary'))
      const { update } = await h.bus.call('ordinary', 'publish_focus_update', report())
      assert.equal(update.sessionId, 'ordinary')
      assert.equal(update.projectId, 'one')
      assert.equal(update.at, h.deps.now())
      assert.deepEqual(h.sessions.get('ordinary'), before)
    }
    const { update } = await h.bus.call('manager', 'publish_focus_update', report({ kind: 'blocked' }))
    assert.equal(update.sessionId, 'manager')
    assert.equal(h.sessions.get('manager').status, 'idle')
    assert.deepEqual(h.sessions.calls, [])
    assert.ok(h.bus.entries().every((entry) => entry.tool === 'publish_focus_update' && entry.targetId === null && entry.ok))
  })

  test('master off, revoked, missing and dead callers cannot publish', async () => {
    const h = scheduledBus()
    h.enableBus(false)
    assert.match(await refusal(h.bus, 'ordinary', 'publish_focus_update', report()), /switched off/)
    h.enableBus(true)
    h.sessions.set('ordinary', { bus: 'off' })
    assert.match(await refusal(h.bus, 'ordinary', 'publish_focus_update', report()), /no bus access/)
    h.sessions.set('ordinary', { bus: 'full', alive: false })
    assert.match(await refusal(h.bus, 'ordinary', 'publish_focus_update', report()), /no longer running/)
    assert.match(await refusal(h.bus, 'missing', 'publish_focus_update', report()), /not known/)
    assert.deepEqual(h.scheduler.snapshot().focusUpdates, [])
    assert.ok(h.bus.entries().every((entry) => !entry.ok))
  })

  test('caller project must currently exist; a moved manager loses its grant', async () => {
    const h = scheduledBus()
    for (const project of [null, 'missing']) {
      h.sessions.set('ordinary', { sessionProjectId: project })
      assert.match(await refusal(h.bus, 'ordinary', 'publish_focus_update', report()), /existing Workbench project/)
    }
    h.sessions.set('manager', { sessionProjectId: 'two' })
    assert.match(await refusal(h.bus, 'manager', 'publish_focus_update', report()), /no bus access/)
    h.sessions.set('ordinary', { sessionProjectId: 'two' })
    const { update } = await h.bus.call('ordinary', 'publish_focus_update', report())
    assert.equal(update.projectId, 'two')
    h.projects.splice(1, 1)
    assert.match(await refusal(h.bus, 'ordinary', 'publish_focus_update', report()), /existing Workbench project/)
  })

  test('forged identity, project, time and authority are refused, including from managers', async () => {
    const h = scheduledBus()
    for (const caller of ['manager', 'ordinary']) {
      for (const field of ['session_id', 'sessionId', 'projectId', 'project_id', 'id', 'at', 'status', 'bus']) {
        assert.match(await refusal(h.bus, caller, 'publish_focus_update', report({ [field]: 'forged' })), /Unsupported/)
      }
    }
    assert.deepEqual(h.scheduler.snapshot().focusUpdates, [])
  })

  test('oversized and malformed visuals never reach the durable board', async () => {
    const h = scheduledBus()
    for (const patch of [{ summary: 'x'.repeat(181) }, { next: 'x'.repeat(141) }, { summary: '<svg/>' },
      { summary: 'Open https://example.com' }, { visual: { kind: 'steps', items: [{ label: 'Step', state: 'done', html: '<svg/>' }] } },
      { visual: { kind: 'metrics', items: [{ label: 'Count', value: 1 }] } },
      { visual: { kind: 'steps', items: Array(5).fill({ label: 'Step', state: 'done' }) } }]) {
      assert.ok(await refusal(h.bus, 'ordinary', 'publish_focus_update', report(patch)))
    }
    assert.deepEqual(h.scheduler.snapshot().focusUpdates, [])
    assert.equal(h.changes(), 0)
  })

  test('unavailable storage and atomic save failure are reported without a false saved result', async () => {
    const unready = makeBus([session('reporter', { bus: 'read', sessionProjectId: 'one' })], { project: () => ({ id: 'one' }) })
    assert.match(await refusal(unready.bus, 'reporter', 'publish_focus_update', report()), /not ready/)
    const h = scheduledBus()
    fs.mkdirSync(path.join(h.deps.directory, 'experience.json.tmp'))
    assert.match(await refusal(h.bus, 'ordinary', 'publish_focus_update', report()), /not saved/)
    assert.deepEqual(h.scheduler.snapshot().focusUpdates, [])
    assert.deepEqual(h.sessions.calls, [])
  })
})
