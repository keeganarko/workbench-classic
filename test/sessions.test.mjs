import { toHostPath, toNativePath } from '../src/main/host.js'
/**
 * The status machine, seen/review behaviour, prompt fan-out, and relaunching a
 * session from its persisted descriptor.
 *
 * tmux is a double here — see `fakeTmux`. Everything else is the real thing:
 * the real Store writing real files, the real HookBridge emitting real hook
 * events, and the real SessionManager deciding what colour a session is.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { SessionManager, withTimeout } from '../src/main/sessions.js'
import { HookBridge } from '../src/main/hooks.js'
import { Store } from '../src/main/store.js'
import { STATUS_TRANSITIONS, canTransition } from '../src/shared/types.js'
import {
  tempDir,
  fakeTmux,
  persistedSession,
  persistedDescriptor,
  writeState,
  flush,
  seedClaudeTranscript,
  seedCodexRollout
} from './helpers.mjs'

const ALL_STATUSES = ['idle', 'working', 'waiting', 'review', 'failed', 'exited']

describe('human attention evidence', () => {
  test('a new turn and a completion with no captured reply never reuse an earlier success', async () => {
    const { mgr, hooks, dir } = await makeManager({ sessions: [persistedSession({ id: 'cx', agent: 'codex', lastMessage: 'Previous success' }),
      persistedSession({ id: 'a', agent: 'claude', lastMessage: 'Previous success' })] })
    try {
      await mgr.sendPrompt('cx', 'Review the new code')
      assert.equal(mgr.get('cx').lastMessage, null)
      hook(hooks, 'cx', 'agent-turn-complete', {}, 'codex')
      await flush()
      assert.equal(mgr.get('cx').status, 'review')
      assert.equal(mgr.get('cx').lastMessage, null)
      const file = `${dir}/current-turn.jsonl`
      fs.writeFileSync(file, [
        { message: { role: 'user', content: 'Review the code' } },
        { message: { role: 'assistant', content: 'Previous result passed.' } },
        { message: { role: 'user', content: 'Review the code' } }
      ].map(row => JSON.stringify(row)).join('\n') + '\n')
      hook(hooks, 'a', 'UserPromptSubmit', { prompt: 'Review the code', transcript_path: file })
      assert.equal(mgr.get('a').lastMessage, null)
      hook(hooks, 'a', 'Stop')
      assert.equal(mgr.get('a').lastMessage, null, 'a repeated request is not the previous reply')
      fs.appendFileSync(file, JSON.stringify({ message: { role: 'assistant', content: 'Reviewed the current code; one issue remains.' } }) + '\n')
      hook(hooks, 'a', 'Stop')
      assert.equal(mgr.get('a').lastMessage, 'Reviewed the current code; one issue remains.')
    } finally { await mgr.shutdown() }
  })

  test('coordination and quoted approval text finish for review; direct requests remain actionable', async () => {
    const { mgr, hooks } = await makeManager({ sessions: [persistedSession({ id: 'cx', agent: 'codex' })] })
    try {
      for (const message of ['Updated all agents. The old dialog said "Would you like to proceed?"; it is now resolved.',
        'Posted the relay reply: Please confirm the design with the integration lead. All my work is complete.',
        'Tests cover Allow command and [y/n]. All checks pass.']) {
        hook(hooks, 'cx', 'agent-turn-complete', { 'last-assistant-message': message }, 'codex')
        await flush()
        assert.equal(mgr.get('cx').status, 'review', message)
      }
      hook(hooks, 'cx', 'agent-turn-complete', { 'last-assistant-message': 'Please confirm which option.' }, 'codex')
      await flush()
      assert.equal(mgr.get('cx').status, 'waiting')
      assert.equal(mgr.get('cx').statusReason, 'Please confirm which option.')
      hook(hooks, 'cx', 'agent-turn-complete', { 'input-messages': ['[relay from the "Lead" session] Review the design.'],
        'last-assistant-message': 'Please confirm which option.' }, 'codex')
      await flush()
      assert.equal(mgr.get('cx').status, 'review', 'the peer receives its answer without a human-help escalation')
    } finally { await mgr.shutdown() }
  })

  test('quiet coordination scrollback cannot create a human-help request', async () => {
    const { mgr } = await makeManager({ sessions: [persistedSession({ id: 'cx', agent: 'codex', status: 'working' })],
      tmux: { paneInfoFor: name => alivePane(name), captureTailText: 'Agent reply: Please choose the architecture with the lead.\nDone.\n› Next prompt' } })
    try {
      mgr.get('cx').lastActivityAt = Date.now() - 5000
      await mgr.poll()
      assert.equal(mgr.get('cx').status, 'working')
    } finally { await mgr.shutdown() }
  })

  test('default approval and trust text only waits while its dialog remains current', async () => {
    for (const text of ['The report mentions [y/n] and Yes, proceed.\nFinished.\n› Next prompt',
      'Do you want to proceed?\n1. Yes, proceed\n2. No, cancel\nenter to confirm | esc to cancel',
      'Do you trust the files in this directory?\n1. Yes, proceed\n2. No, exit']) {
      const { mgr } = await makeManager({ sessions: [persistedSession({ id: 'cx', agent: 'codex', status: 'working' })],
        tmux: { paneInfoFor: name => alivePane(name), captureTailText: text } })
      try {
        mgr.get('cx').lastActivityAt = Date.now() - 5000
        await mgr.poll()
        assert.equal(mgr.get('cx').status, text.startsWith('The report') ? 'working' : 'waiting', text)
      } finally { await mgr.shutdown() }
    }
  })

  test('missing completion text never promotes an old prose question from the pane', async () => {
    const { mgr, hooks } = await makeManager({ sessions: [persistedSession({ id: 'cx', agent: 'codex', status: 'working' })],
      tmux: { captureTailText: 'Earlier question: Please confirm the option.\nDone; report saved.\n› Next prompt' } })
    try {
      hook(hooks, 'cx', 'agent-turn-complete', {}, 'codex')
      await flush()
      assert.equal(mgr.get('cx').status, 'review')
    } finally { await mgr.shutdown() }
  })

  test('restoration retires only old built-in prose fragments, preserving approvals and custom intent', async () => {
    const records = [persistedSession({ id: 'old', agent: 'codex', status: 'waiting', statusSource: 'trigger', statusReason: 'Please choose' }),
      persistedSession({ id: 'approval', agent: 'codex', status: 'waiting', statusSource: 'hook', statusReason: 'Please confirm' }),
      persistedSession({ id: 'specific', agent: 'codex', status: 'waiting', statusSource: 'trigger', statusReason: 'Please confirm which option.' })]
    const { mgr } = await makeManager({ sessions: records })
    try {
      assert.equal(mgr.get('old').status, 'idle')
      assert.equal(mgr.get('approval').status, 'waiting')
      assert.equal(mgr.get('specific').status, 'waiting')
    } finally { await mgr.shutdown() }
    const custom = await makeManager({ sessions: [records[0]], prefs: { triggers: [
      { id: 'own-ask', name: 'My explicit signal', pattern: 'Please choose', flags: '', agent: 'codex', action: 'waiting', captureReason: true, enabled: true }
    ] } })
    try { assert.equal(custom.mgr.get('old').status, 'waiting') } finally { await custom.mgr.shutdown() }
  })

  test('acknowledgement cannot clear a newer event or revive an unchanged custom trigger', async () => {
    const { mgr, tmux, hooks } = await makeManager({ sessions: [persistedSession({ id: 'cx', agent: 'codex', status: 'working' })],
      prefs: { triggers: [{ id: 'own-ask', name: 'Explicit user rule', pattern: 'CUSTOM ASK', flags: '', agent: 'codex', action: 'waiting', captureReason: true, enabled: true }] },
      tmux: { paneInfoFor: name => alivePane(name), captureTailText: 'CUSTOM ASK one' } })
    try {
      mgr.get('cx').lastActivityAt = Date.now() - 5000
      await mgr.poll()
      const pending = mgr.get('cx')
      assert.equal(pending.status, 'waiting')
      assert.equal(mgr.clearStatus('cx', { status: 'waiting', changedAt: pending.lastStatusChangeAt - 1, reason: pending.statusReason }), false)
      assert.equal(mgr.get('cx').status, 'waiting')
      assert.equal(mgr.clearStatus('cx', { status: 'waiting', changedAt: pending.lastStatusChangeAt, reason: 'Another question' }), false)
      assert.equal(mgr.clearStatus('cx', { status: 'waiting', changedAt: pending.lastStatusChangeAt, reason: pending.statusReason }), true)
      await mgr.poll()
      assert.equal(mgr.get('cx').status, 'idle', 'the identical screen stays acknowledged')
      mgr.get('cx').lastActivityAt = Date.now() - 6000
      await mgr.poll()
      assert.equal(mgr.get('cx').status, 'idle', 'unrelated activity does not re-arm old evidence')
      tmux.captureTail = async () => 'CUSTOM ASK two'
      await mgr.poll()
      assert.equal(mgr.get('cx').status, 'waiting', 'changed evidence preserves the custom rule')
      mgr.clearStatus('cx')
      hooks.emit('hook', { termSessionId: 'cx', source: 'claude', event: 'PreToolUse', payload: {}, receivedAt: Date.now() })
      mgr.get('cx').lastActivityAt = Date.now() - 5000
      await mgr.poll()
      assert.equal(mgr.get('cx').status, 'waiting', 'a fresh lifecycle event re-arms the user rule')
    } finally { await mgr.shutdown() }
  })

  test('Claude idle and informational notifications never masquerade as permission requests', async () => {
    const { mgr, hooks, notified } = await makeManager({ sessions: [persistedSession({ id: 'a', status: 'working' })] })
    try {
      hook(hooks, 'a', 'Notification', { notification_type: 'idle_prompt', message: 'Waiting for input' })
      assert.equal(mgr.get('a').status, 'review')
      assert.equal(notified.filter(n => n.status === 'waiting').length, 0)
      mgr.clearStatus('a')
      hook(hooks, 'a', 'Notification', { notification_type: 'idle_prompt' })
      hook(hooks, 'a', 'Notification', { notification_type: 'auth_success', message: 'Signed in' })
      assert.equal(mgr.get('a').status, 'idle')
      hook(hooks, 'a', 'Notification', { notification_type: 'permission_prompt', message: 'Approve the file edit?' })
      assert.equal(mgr.get('a').status, 'waiting')
      hook(hooks, 'a', 'Notification', { notification_type: 'idle_prompt' })
      assert.equal(mgr.get('a').status, 'waiting', 'idle reminders never clear a real approval')
      assert.equal(notified.filter(n => n.status === 'waiting').length, 1)
    } finally { await mgr.shutdown() }
  })
})
/**
 * Where the manager thinks each agent's binary is.
 *
 * A function rather than a map since 5.8: the registry can hold agents the user
 * added while the app was running, so resolution happens per launch. Returning
 * a path for everything is what a machine with all of them installed looks like.
 */
const BINS = (def) =>
  def.id === 'shell' ? '/bin/zsh' : def.bin ? `/usr/local/bin/${def.bin}` : null

/** A manager over a temp data dir, seeded with persisted state. */
async function makeManager({ sessions = [], descriptors = [], prefs = {}, tmux: tmuxOpts = {} } = {}) {
  const dir = tempDir('term-sessions-')
  writeState(dir, { sessions, descriptors, prefs })
  const store = new Store(dir)
  const live = sessions.filter((s) => s.alive !== false).map((s) => s.tmuxName)
  const tmux = fakeTmux({ live, ...tmuxOpts })
  const hooks = new HookBridge(dir, process.execPath)
  // Seed trust records into the temp dir, never the real ~/.claude.json.
  const mgr = new SessionManager(tmux, hooks, store, BINS, dir, '/usr/bin:/bin', dir)
  const notified = []
  mgr.on('notify', (n) => notified.push(n))
  await mgr.init()
  return { dir, store, tmux, hooks, mgr, notified }
}

/** Delivers a hook event exactly as the bridge would after authenticating it. */
function hook(hooks, termSessionId, event, payload = {}, source = 'claude') {
  hooks.emit('hook', { termSessionId, source, event, payload, receivedAt: Date.now() })
}

/** A live pane, unchanged since the given moment. */
function alivePane(name, activityAt = 0) {
  return {
    sessionName: name,
    windowId: '@0',
    paneId: '%0',
    pid: 123,
    dead: false,
    deadStatus: null,
    width: 120,
    height: 34,
    currentPath: '/tmp',
    currentCommand: 'claude',
    activityAt
  }
}

describe('status machine', () => {
  test('the transition table is total, and the only way out of exited is a restart', () => {
    for (const from of ALL_STATUSES) {
      assert.ok(STATUS_TRANSITIONS[from], `${from} must be in the table`)
      assert.equal(canTransition(from, from), true, `${from} → ${from} is a no-op, not a violation`)
      for (const to of ALL_STATUSES) {
        if (from === to) continue
        assert.equal(
          canTransition(from, to),
          STATUS_TRANSITIONS[from].includes(to),
          `${from} → ${to}`
        )
      }
    }
    // Spelled out, because this is the rule the rest of the file leans on.
    assert.deepEqual(STATUS_TRANSITIONS.exited, ['idle'])
    for (const to of ['working', 'waiting', 'review', 'failed']) {
      assert.equal(canTransition('exited', to), false, `exited → ${to}`)
    }
  })

  test('Claude hooks walk a session through every colour it can show', async () => {
    const { mgr, hooks } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    try {
      const s = mgr.get('a')

      hook(hooks, 'a', 'SessionStart')
      assert.equal(s.status, 'idle')
      assert.equal(s.statusSource, 'hook')

      hook(hooks, 'a', 'UserPromptSubmit')
      assert.equal(s.status, 'working')

      hook(hooks, 'a', 'PreToolUse')
      assert.equal(s.status, 'working')

      hook(hooks, 'a', 'Notification', { message: 'Claude needs your permission to run rm' })
      assert.equal(s.status, 'waiting')
      assert.equal(s.statusReason, 'Claude needs your permission to run rm')

      hook(hooks, 'a', 'UserPromptSubmit')
      assert.equal(s.status, 'working', 'answering the question resumes work')

      hook(hooks, 'a', 'Stop')
      assert.equal(s.status, 'review')

      hook(hooks, 'a', 'UserPromptSubmit')
      assert.equal(s.status, 'working', 'review → working is a legal follow-up turn')

      hook(hooks, 'a', 'SessionEnd')
      assert.equal(s.status, 'exited')
      assert.equal(s.alive, false)
    } finally {
      await mgr.shutdown()
    }
  })

  test('Codex stays working through TUI animations and finishes only on notify', async () => {
    const logDir = tempDir('term-codex-status-')
    const lifecycleLog = `${logDir}/codex.jsonl`
    fs.writeFileSync(lifecycleLog, '')
    const { dir, store, mgr, hooks } = await makeManager({
      sessions: [persistedSession({ id: 'cx', agent: 'codex' })],
      descriptors: [
        persistedDescriptor({ sessionId: 'cx', profileId: 'codex', lifecycleLogPath: lifecycleLog })
      ],
      tmux: { paneInfoFor: (name) => alivePane(name) }
    })
    try {
      fs.appendFileSync(
        lifecycleLog,
        [
          { kind: 'op', dir: 'from_tui', payload: { UserTurn: { items: [] } } },
          { kind: 'app_event', dir: 'to_tui', variant: 'StopCommitAnimation' },
          { kind: 'app_event', dir: 'to_tui', variant: 'TaskComplete' },
          { kind: 'app_event', dir: 'to_tui', variant: 'TurnComplete' },
          { kind: 'app_event', dir: 'to_tui', variant: 'StopCommitAnimation' }
        ].map(JSON.stringify).join('\n') + '\n'
      )
      await mgr.poll()
      assert.equal(mgr.get('cx').status, 'working', 'presentation events cannot finish a turn')
      const submittedAt = mgr.get('cx').lastPromptAt
      assert.ok(submittedAt > 0, 'a directly typed Codex turn records prompt recency')

      hook(hooks, 'cx', 'future-notify-event', { type: 'future-notify-event' }, 'codex')
      await flush()
      assert.equal(mgr.get('cx').status, 'working', 'an unknown notify event has no semantics')

      hook(
        hooks,
        'cx',
        'agent-turn-complete',
        { type: 'agent-turn-complete', 'last-assistant-message': 'Implemented and verified.' },
        'codex'
      )
      await flush()
      assert.equal(mgr.get('cx').status, 'review')
      assert.equal(mgr.get('cx').lastMessage, 'Implemented and verified.')
      assert.equal(mgr.get('cx').lastPromptAt, submittedAt, 'completion is not a newer user prompt')

      store.saveNow()
      const saved = JSON.parse(fs.readFileSync(`${dir}/workbench.json`, 'utf8'))
      assert.equal(saved.sessions.find((s) => s.id === 'cx').status, 'review')
    } finally {
      await mgr.shutdown()
    }
  })

  test('Codex interruption returns to Recent and a final question waits for the user', async () => {
    const logDir = tempDir('term-codex-interrupt-')
    const lifecycleLog = `${logDir}/codex.jsonl`
    fs.writeFileSync(lifecycleLog, '')
    const { mgr, hooks } = await makeManager({
      sessions: [persistedSession({ id: 'cx', agent: 'codex' })],
      descriptors: [
        persistedDescriptor({ sessionId: 'cx', profileId: 'codex', lifecycleLogPath: lifecycleLog })
      ],
      tmux: {
        paneInfoFor: (name) => alivePane(name),
        captureTailText: 'Old output: Would you like to approve something unrelated?'
      }
    })
    try {
      fs.appendFileSync(
        lifecycleLog,
        [
          { kind: 'op', dir: 'from_tui', payload: { UserTurn: { items: [] } } },
          { kind: 'app_event', dir: 'to_tui', variant: 'TurnAborted' }
        ].map(JSON.stringify).join('\n') + '\n'
      )
      await mgr.poll()
      assert.equal(mgr.get('cx').status, 'idle', 'an interrupted turn has nothing to review')

      fs.appendFileSync(
        lifecycleLog,
        JSON.stringify({ kind: 'op', dir: 'from_tui', payload: { UserTurn: { items: [] } } }) + '\n'
      )
      await mgr.poll()
      assert.equal(mgr.get('cx').status, 'working')

      hook(
        hooks,
        'cx',
        'agent-turn-complete',
        { type: 'agent-turn-complete', 'last-assistant-message': 'Implemented and verified.' },
        'codex'
      )
      await flush()
      assert.equal(
        mgr.get('cx').status,
        'review',
        'stale questions in the pane cannot override the final assistant message'
      )

      fs.appendFileSync(
        lifecycleLog,
        JSON.stringify({ kind: 'op', dir: 'from_tui', payload: { UserTurn: { items: [] } } }) + '\n'
      )
      await mgr.poll()
      hook(
        hooks,
        'cx',
        'agent-turn-complete',
        { type: 'agent-turn-complete', 'last-assistant-message': 'Please confirm which option.' },
        'codex'
      )
      await flush()
      assert.equal(mgr.get('cx').status, 'waiting')
    } finally {
      await mgr.shutdown()
    }
  })

  test('a delayed Codex completion cannot overwrite a newer working turn', async () => {
    const logDir = tempDir('term-codex-race-')
    const lifecycleLog = `${logDir}/codex.jsonl`
    fs.writeFileSync(lifecycleLog, '')
    const { mgr, hooks, tmux } = await makeManager({
      sessions: [persistedSession({ id: 'cx', agent: 'codex' })],
      descriptors: [
        persistedDescriptor({ sessionId: 'cx', profileId: 'codex', lifecycleLogPath: lifecycleLog })
      ],
      tmux: { paneInfoFor: (name) => alivePane(name) }
    })
    try {
      const userTurn = JSON.stringify({
        kind: 'op',
        dir: 'from_tui',
        payload: { UserTurn: { items: [] } }
      })
      fs.appendFileSync(lifecycleLog, `${userTurn}\n`)
      await mgr.poll()

      let releaseTail
      tmux.captureTail = () => new Promise((resolve) => { releaseTail = resolve })
      hook(hooks, 'cx', 'agent-turn-complete', { type: 'agent-turn-complete' }, 'codex')

      fs.appendFileSync(lifecycleLog, `${userTurn}\n`)
      await mgr.poll()
      releaseTail('old completed output')
      await flush()
      assert.equal(mgr.get('cx').status, 'working')
    } finally {
      await mgr.shutdown()
    }
  })

  test('Codex naming its own thread does not end your turn', async () => {
    // Reproduces what the notify hook actually delivers: on the first turn of a
    // conversation Codex opens a second, throwaway thread to generate a title,
    // and that thread completes in a few seconds — firing `agent-turn-complete`
    // on the same hook, with its own thread id, while the real turn runs on.
    const logDir = tempDir('term-codex-subturn-')
    const lifecycleLog = `${logDir}/codex.jsonl`
    fs.writeFileSync(lifecycleLog, '')
    const { mgr, hooks } = await makeManager({
      sessions: [persistedSession({ id: 'cx', agent: 'codex', agentSessionId: 'real-thread' })],
      descriptors: [
        persistedDescriptor({
          sessionId: 'cx',
          profileId: 'codex',
          agentSessionId: 'real-thread',
          lifecycleLogPath: lifecycleLog
        })
      ],
      tmux: { paneInfoFor: (name) => alivePane(name) }
    })
    try {
      fs.appendFileSync(
        lifecycleLog,
        JSON.stringify({
          kind: 'op',
          dir: 'from_tui',
          payload: { UserTurn: { items: [{ type: 'text', text: 'summarise every doc' }] } }
        }) + '\n'
      )
      await mgr.poll()
      assert.equal(mgr.get('cx').status, 'working')

      hook(
        hooks,
        'cx',
        'agent-turn-complete',
        {
          type: 'agent-turn-complete',
          'thread-id': 'title-thread',
          'input-messages': ['Generate a concise, single-line task title…'],
          'last-assistant-message': '{"title":"Summarise docs"}'
        },
        'codex'
      )
      await flush()
      assert.equal(mgr.get('cx').status, 'working', 'a sub-turn cannot finish your turn')
      assert.equal(
        mgr.get('cx').agentSessionId,
        'real-thread',
        'nor may it claim the session, whose transcript lives under the real thread'
      )

      hook(
        hooks,
        'cx',
        'agent-turn-complete',
        {
          type: 'agent-turn-complete',
          'thread-id': 'real-thread',
          'input-messages': ['an earlier prompt', '  summarise   every doc  '],
          'last-assistant-message': 'Read all five files.'
        },
        'codex'
      )
      await flush()
      assert.equal(mgr.get('cx').status, 'review', 'the turn you submitted still ends it')
      assert.equal(mgr.get('cx').lastMessage, 'Read all five files.')
    } finally {
      await mgr.shutdown()
    }
  })

  test('a late event cannot resurrect a session that has exited', async () => {
    const { mgr, hooks } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    try {
      hook(hooks, 'a', 'SessionEnd')
      assert.equal(mgr.get('a').status, 'exited')

      // Hooks arriving after the CLI is gone are common; none of them may
      // repaint a dead session as busy.
      for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop', 'Notification']) {
        hook(hooks, 'a', event, { message: 'still here?' })
        assert.equal(mgr.get('a').status, 'exited', `${event} must not revive it`)
      }
    } finally {
      await mgr.shutdown()
    }
  })

  test('an event for an unknown session is ignored rather than inventing one', async () => {
    const { mgr, hooks } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    try {
      hook(hooks, 'ghost', 'UserPromptSubmit')
      assert.equal(mgr.list().length, 1)
    } finally {
      await mgr.shutdown()
    }
  })

  test('a repeat of the same status sharpens the reason without restarting the clock', async () => {
    const { mgr, hooks } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    try {
      hook(hooks, 'a', 'Notification', { message: 'Claude needs your input' })
      const at = mgr.get('a').lastStatusChangeAt
      hook(hooks, 'a', 'Notification', { message: 'Allow write to /etc/hosts?' })
      assert.equal(mgr.get('a').statusReason, 'Allow write to /etc/hosts?')
      assert.equal(mgr.get('a').lastStatusChangeAt, at, 'still the same waiting episode')
    } finally {
      await mgr.shutdown()
    }
  })

  test('the CLI’s own session id and transcript path are learnt from the first hook', async () => {
    const { mgr, hooks } = await makeManager({
      sessions: [persistedSession({ id: 'a' })],
      descriptors: [persistedDescriptor({ sessionId: 'a' })]
    })
    try {
      hook(hooks, 'a', 'SessionStart', {
        session_id: 'cli-uuid-1',
        transcript_path: '/tmp/transcript.jsonl'
      })
      assert.equal(mgr.get('a').agentSessionId, 'cli-uuid-1')
      const d = mgr.descriptorFor('a')
      assert.equal(d.agentSessionId, 'cli-uuid-1', 'the descriptor must learn it too, for restart')
      assert.equal(d.transcriptPath, '/tmp/transcript.jsonl')
    } finally {
      await mgr.shutdown()
    }
  })

  test('waiting and a finished turn each raise exactly one notification', async () => {
    const { mgr, hooks, notified } = await makeManager({
      sessions: [persistedSession({ id: 'a', title: 'auth refactor' })]
    })
    try {
      hook(hooks, 'a', 'Notification', { message: 'Approve the edit?' })
      assert.equal(notified.length, 1)
      assert.equal(notified[0].status, 'waiting')
      assert.equal(notified[0].title, 'Software Engineer needs you')
      assert.equal(notified[0].body, 'Approve the edit?')

      hook(hooks, 'a', 'UserPromptSubmit')
      hook(hooks, 'a', 'Stop')
      assert.equal(notified.length, 2)
      assert.equal(notified[1].status, 'review')
      assert.equal(notified[1].title, 'Software Engineer finished')

      // Idle is not an event worth interrupting anyone for.
      hook(hooks, 'a', 'SessionStart')
      assert.equal(notified.length, 2)
    } finally {
      await mgr.shutdown()
    }
  })

  test('the notification preferences are honoured', async () => {
    const { mgr, hooks, notified } = await makeManager({
      sessions: [persistedSession({ id: 'a' })],
      prefs: { notifyOnWaiting: false, notifyOnDone: false }
    })
    try {
      hook(hooks, 'a', 'Notification', { message: 'Approve?' })
      hook(hooks, 'a', 'UserPromptSubmit')
      hook(hooks, 'a', 'Stop')
      assert.equal(notified.length, 0)
      assert.equal(mgr.get('a').status, 'review', 'the colour still changes; only the banner is off')
    } finally {
      await mgr.shutdown()
    }
  })

  test('a non-zero exit is failed, not exited, and says why', async () => {
    const deadPane = (name) => ({ ...alivePane(name), dead: true, deadStatus: 137 })
    const { mgr } = await makeManager({
      sessions: [persistedSession({ id: 'a' })],
      tmux: { paneInfoFor: deadPane }
    })
    try {
      await mgr.poll()
      const s = mgr.get('a')
      assert.equal(s.status, 'failed')
      assert.equal(s.alive, false)
      assert.equal(s.exitCode, 137)
      assert.equal(s.statusReason, 'Exited with status 137')
      assert.equal(s.statusSource, 'poll')
      assert.equal(mgr.counts().failed, 1)
    } finally {
      await mgr.shutdown()
    }
  })

  test('a clean exit is exited, and a vanished pane is too', async () => {
    const { mgr } = await makeManager({
      sessions: [persistedSession({ id: 'a' }), persistedSession({ id: 'b' })],
      tmux: {
        paneInfoFor: (name) =>
          name === 'term_a' ? { ...alivePane(name), dead: true, deadStatus: 0 } : null
      }
    })
    try {
      await mgr.poll()
      assert.equal(mgr.get('a').status, 'exited')
      assert.equal(mgr.get('a').exitCode, 0)
      assert.equal(mgr.get('b').status, 'exited', 'a pane tmux no longer reports is gone')
      assert.equal(mgr.get('b').alive, false)
    } finally {
      await mgr.shutdown()
    }
  })

  test('a session found alive again stops advertising a death it did not have', async () => {
    // The locale bug buried live sessions as "exited" and persisted that. Once
    // the pane is seen alive and not dead, the recorded death was simply wrong.
    const { mgr } = await makeManager({
      sessions: [
        persistedSession({
          id: 'a',
          status: 'exited',
          statusSource: 'poll',
          alive: false,
          exitCode: 0
        })
      ],
      // The pane was alive all along; only our record of it said otherwise.
      tmux: { live: ['term_a'], paneInfoFor: (name) => alivePane(name) }
    })
    try {
      await mgr.poll()
      const s = mgr.get('a')
      assert.equal(s.alive, true)
      assert.equal(s.status, 'idle', 'a live pane is not an exited session')
      assert.equal(s.exitCode, null)
    } finally {
      await mgr.shutdown()
    }
  })

  test('a failed pane snapshot leaves live sessions alone instead of burying them', async () => {
    // Regression: tmux rewrites non-printable bytes in `-F` output to "_" when it
    // has no UTF-8 locale, and a GUI-launched macOS app inherits none. Every
    // field fused into one string, allPaneInfo came back empty, and poll read
    // "no panes exist" as "every session exited" — roughly two seconds after
    // launch, while the CLI was still sitting happily at its prompt.
    let failing = false
    const { mgr } = await makeManager({
      sessions: [persistedSession({ id: 'a', status: 'working' })],
      tmux: {
        paneInfoFor: (name) => {
          if (failing) throw new Error('tmux list-panes failed')
          return alivePane(name)
        }
      }
    })
    try {
      failing = true
      await mgr.poll()
      const s = mgr.get('a')
      assert.equal(s.alive, true, 'a query we could not make is not evidence of death')
      assert.equal(s.status, 'working', 'and it certainly is not evidence of an exit')
      assert.equal(mgr.counts().failed, 0)
    } finally {
      await mgr.shutdown()
    }
  })

  test('a quiet pane showing a password prompt is red before any hook fires', async () => {
    // The shell has no hooks at all, so the trigger sweep is the only thing that
    // can notice it is blocked on a human.
    const { mgr } = await makeManager({
      sessions: [persistedSession({ id: 'a', agent: 'shell', status: 'working' })],
      tmux: {
        paneInfoFor: (name) => alivePane(name),
        captureTailText: 'sudo git push\nPassword:'
      }
    })
    try {
      mgr.get('a').lastActivityAt = Date.now() - 5000
      await mgr.poll()
      assert.equal(mgr.get('a').status, 'waiting')
      assert.equal(mgr.get('a').statusSource, 'trigger')
    } finally {
      await mgr.shutdown()
    }
  })

  test('a pane still producing output is left alone by the trigger sweep', async () => {
    const { mgr } = await makeManager({
      sessions: [persistedSession({ id: 'a', agent: 'shell', status: 'working' })],
      tmux: {
        paneInfoFor: (name) => alivePane(name, Date.now()),
        captureTailText: 'Password:'
      }
    })
    try {
      await mgr.poll()
      assert.equal(mgr.get('a').status, 'working', 'still busy — not waiting on us')
    } finally {
      await mgr.shutdown()
    }
  })
})

describe('seen and review', () => {
  test('focusing a working session cannot acknowledge or hide it', async () => {
    const { mgr, hooks } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    try {
      hook(hooks, 'a', 'UserPromptSubmit')
      assert.equal(mgr.get('a').status, 'working')

      mgr.setVisiblePanes({ sessionIds: ['a'], focusedSessionId: 'a' })
      assert.equal(mgr.get('a').status, 'working')
      assert.equal(mgr.get('a').statusSource, 'hook')
    } finally {
      await mgr.shutdown()
    }
  })

  test('looking at a finished session clears the green', async () => {
    const { mgr, hooks } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    try {
      hook(hooks, 'a', 'UserPromptSubmit')
      hook(hooks, 'a', 'Stop')
      assert.equal(mgr.get('a').status, 'review')

      mgr.setVisiblePanes({ sessionIds: ['a'], focusedSessionId: 'a' })
      const s = mgr.get('a')
      assert.equal(s.status, 'idle', 'green means "something new here"; you have now seen it')
      assert.equal(s.statusSource, 'user')
      assert.equal(s.statusReason, null)
      assert.ok(s.lastSeenAt)
    } finally {
      await mgr.shutdown()
    }
  })

  test('a session you are not focused on stays green', async () => {
    const { mgr, hooks } = await makeManager({
      sessions: [persistedSession({ id: 'a' }), persistedSession({ id: 'b' })]
    })
    try {
      for (const id of ['a', 'b']) {
        hook(hooks, id, 'UserPromptSubmit')
        hook(hooks, id, 'Stop')
      }
      // Both on screen in a split; only one has focus.
      mgr.setVisiblePanes({ sessionIds: ['a', 'b'], focusedSessionId: 'a' })
      assert.equal(mgr.get('a').status, 'idle')
      assert.equal(mgr.get('b').status, 'review', 'visible is not the same as looked at')
      assert.equal(mgr.isVisible('b'), true)
      assert.equal(mgr.isFocused('b'), false)
      assert.equal(mgr.isFocused('a'), true)
    } finally {
      await mgr.shutdown()
    }
  })

  test('focusing a red session does not clear it — it still needs an answer', async () => {
    const { mgr, hooks } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    try {
      hook(hooks, 'a', 'Notification', { message: 'Approve?' })
      mgr.setVisiblePanes({ sessionIds: ['a'], focusedSessionId: 'a' })
      assert.equal(mgr.get('a').status, 'waiting')
      assert.ok(mgr.get('a').lastSeenAt, 'seen, but not resolved')
    } finally {
      await mgr.shutdown()
    }
  })

  test('new activity makes a seen session unseen again', async () => {
    const { mgr, hooks } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    try {
      mgr.setVisiblePanes({ sessionIds: ['a'], focusedSessionId: 'a' })
      assert.ok(mgr.get('a').lastSeenAt)
      hook(hooks, 'a', 'UserPromptSubmit')
      assert.equal(mgr.get('a').lastSeenAt, null)
    } finally {
      await mgr.shutdown()
    }
  })

  test('clearStatus is an escape hatch that respects whether the pane is alive', async () => {
    const { mgr, hooks } = await makeManager({
      sessions: [persistedSession({ id: 'a' }), persistedSession({ id: 'b' })]
    })
    try {
      hook(hooks, 'a', 'Notification', { message: 'stuck' })
      mgr.clearStatus('a')
      assert.equal(mgr.get('a').status, 'idle')
      assert.equal(mgr.get('a').statusSource, 'user')

      hook(hooks, 'b', 'SessionEnd')
      mgr.clearStatus('b')
      assert.equal(mgr.get('b').status, 'exited', 'a dead pane cannot be cleared back to life')
    } finally {
      await mgr.shutdown()
    }
  })
})

describe('prompt fan-out', () => {
  const three = [
    persistedSession({ id: 'a' }),
    persistedSession({ id: 'b' }),
    persistedSession({ id: 'c' })
  ]

  test('reports which recipients got the broadcast and which did not', async () => {
    const { mgr, tmux } = await makeManager({
      sessions: three,
      tmux: {
        submitPromptFailure: (name) =>
          name === 'term_b' ? new Error('no server running on /tmp/tmux-501/terminal') : null
      }
    })
    try {
      const results = await mgr.sendPromptMany(['a', 'b', 'c'], 'run the tests')
      assert.deepEqual(
        results.map((r) => [r.sessionId, r.ok]),
        [
          ['a', true],
          ['b', false],
          ['c', true]
        ]
      )
      assert.match(results[1].error, /no server running/)

      // Every recipient was attempted — one failure must not abort the rest.
      const sent = tmux.calls.filter((c) => c.name === 'submitPrompt').map((c) => c.args[0])
      assert.deepEqual(sent, ['term_a', 'term_b', 'term_c'])

      assert.equal(mgr.get('a').status, 'working')
      assert.equal(mgr.get('c').status, 'working')
      assert.equal(mgr.get('b').status, 'idle', 'a session that never got the prompt is not working')
    } finally {
      await mgr.shutdown()
    }
  })

  test('total failure is reported per recipient, not as one opaque error', async () => {
    const { mgr } = await makeManager({
      sessions: three,
      tmux: { submitPromptFailure: () => new Error('tmux: connection refused') }
    })
    try {
      const results = await mgr.sendPromptMany(['a', 'b', 'c'], 'stop')
      assert.equal(results.length, 3)
      assert.equal(results.every((r) => !r.ok), true)
      for (const r of results) assert.match(r.error, /connection refused/)
      assert.equal(mgr.list().every((s) => s.status === 'idle'), true)
    } finally {
      await mgr.shutdown()
    }
  })

  test('a dead session and an unknown id each fail with their own reason', async () => {
    const { mgr, hooks } = await makeManager({ sessions: three })
    try {
      hook(hooks, 'b', 'SessionEnd')
      const results = await mgr.sendPromptMany(['a', 'b', 'ghost'], 'hello')
      assert.equal(results[0].ok, true)
      assert.equal(results[1].error, 'Session has exited')
      assert.equal(results[2].error, 'Session no longer exists')
    } finally {
      await mgr.shutdown()
    }
  })

  test('a recipient that never answers is written off rather than hanging the batch', async () => {
    // The bug this guards: `sendPromptMany` awaits each recipient in turn, so a
    // tmux call that never settles used to hang every recipient behind it and
    // the composer's promise with them — the prompt bar stuck on "Sending…"
    // with no error and nothing to retry.
    const never = new Promise(() => {})
    await assert.rejects(
      () => withTimeout(never, 10, 'tmux did not answer within 5s'),
      /did not answer/
    )
  })

  test('a bounded send that finishes in time keeps its value, and clears its timer', async () => {
    assert.equal(await withTimeout(Promise.resolve('sent'), 1000, 'nope'), 'sent')
    await assert.rejects(
      () => withTimeout(Promise.reject(new Error('tmux: connection refused')), 1000, 'nope'),
      // The real error survives; the timeout must not replace it with its own.
      /connection refused/
    )
  })

  test('sendPrompt throws rather than dropping a prompt quietly', async () => {
    const { mgr } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    try {
      await assert.rejects(() => mgr.sendPrompt('ghost', 'hi'), /Session no longer exists/)
    } finally {
      await mgr.shutdown()
    }
  })
})

describe('automatic session naming', () => {
  test('submitted prompt recency persists even during a working turn; output and failed sends do not advance it', async () => {
    const { mgr, hooks, store, tmux } = await makeManager({ sessions: [persistedSession({ id: 'a', status: 'working', lastPromptAt: 1 })] })
    try {
      await mgr.sendPrompt('a', 'Please check this too.')
      const submittedAt = mgr.get('a').lastPromptAt
      assert.ok(submittedAt > 1)
      assert.equal(store.sessions.find((session) => session.id === 'a').lastPromptAt, submittedAt)
      hook(hooks, 'a', 'PreToolUse')
      assert.equal(mgr.get('a').lastPromptAt, submittedAt)
      tmux.submitPromptFailure = () => new Error('Delivery failed')
      await assert.rejects(mgr.sendPrompt('a', 'Undelivered prompt'), /Delivery failed/)
      assert.equal(mgr.get('a').lastPromptAt, submittedAt)
    } finally { await mgr.shutdown() }
  })

  test('the first delivered prompt assigns a stable role and later work updates the reminder', async () => {
    const { mgr } = await makeManager({
      sessions: [persistedSession({ id: 'a', title: 'Claude · repo', titleMode: 'auto' })]
    })
    try {
      await mgr.sendPrompt('a', 'Please review the authentication flow before changing it.')
      assert.equal(mgr.get('a').title, 'Security Analyst')
      await mgr.sendPrompt('a', 'Now rewrite every test.')
      assert.equal(
        mgr.get('a').title,
        'Security Analyst',
        'later turns do not change the company role'
      )
      assert.equal(mgr.get('a').lastTask, 'Rewrite every test')
    } finally {
      await mgr.shutdown()
    }
  })

  test('a prompt typed directly into Claude is observed by its hook', async () => {
    const { mgr, hooks } = await makeManager({
      sessions: [persistedSession({ id: 'a', title: 'Claude · repo', titleMode: 'auto' })]
    })
    try {
      hook(hooks, 'a', 'UserPromptSubmit', { prompt: 'Fix the flaky status test.' })
      assert.equal(mgr.get('a').title, 'Quality Engineer')
      assert.ok(mgr.get('a').lastPromptAt > 0)
    } finally {
      await mgr.shutdown()
    }
  })

  test('an explicit role correction is authoritative while the task keeps updating', async () => {
    const { mgr } = await makeManager({
      sessions: [persistedSession({ id: 'a', title: 'Infrastructure Engineer', titleMode: 'manual', titleVersion: 1, titleSource: 'prompt' })]
    })
    try {
      await mgr.sendPrompt('a', 'Plan a completely different task.')
      assert.equal(mgr.get('a').title, 'Infrastructure Engineer')
      assert.equal(mgr.get('a').lastTask, 'Plan a completely different task')
    } finally {
      await mgr.shutdown()
    }
  })
})

describe('restart from a persisted descriptor', () => {
  test('a Codex session resumes its own conversation with its own flags', async () => {
    const session = persistedSession({
      id: 'cx',
      agent: 'codex',
      status: 'review',
      agentSessionId: 'codex-thread-1',
      cwd: '/tmp'
    })
    const descriptor = persistedDescriptor({
      sessionId: 'cx',
      profileId: 'codex',
      command: '/usr/local/bin/codex',
      launchArgs: [],
      baseArgs: ['-c', 'notify=["/old/shim"]'],
      extraArgs: ['--search'],
      permissionMode: 'full-access',
      agentSessionId: 'codex-thread-1',
      lifecycleLogPath: '/old/codex-log.jsonl',
      origin: 'new'
    })
    const { mgr, tmux, dir } = await makeManager({ sessions: [session], descriptors: [descriptor] })
    // A restart only resumes a conversation the CLI actually recorded.
    seedCodexRollout(dir, 'codex-thread-1', { cwd: '/tmp' })
    try {
      assert.equal(mgr.descriptorFor('cx').lifecycleLogPath, '/old/codex-log.jsonl')

      await mgr.restart('cx')

      // The husk is replaced, not reused: tmux reports a dead pane as present.
      const killed = tmux.calls.filter((c) => c.name === 'killSession').map((c) => c.args[0])
      assert.deepEqual(killed, ['term_cx'])

      const created = tmux.calls.filter((c) => c.name === 'createSession').at(-1).args[0]
      assert.deepEqual(created.command.slice(0, 3), [
        '/usr/local/bin/codex',
        'resume',
        'codex-thread-1'
      ])
      assert.ok(
        created.command.includes('--dangerously-bypass-approvals-and-sandbox'),
        'the permission mode chosen at launch is replayed, not reset to the default'
      )
      assert.equal(created.command.at(-1), '--search', 'extra args survive a restart')
      assert.equal(created.cwd, '/tmp')

      // Hook wiring is per-invocation argv and per-session env; nothing global.
      assert.ok(created.command.includes('-c'))
      assert.ok(created.command.some((a) => a.startsWith('notify=[')))
      assert.equal(created.env.TERMINAL_SESSION_ID, 'cx')
      assert.ok(created.env.TERMINAL_BRIDGE_FILE)

      const d = mgr.descriptorFor('cx')
      assert.equal(d.origin, 'resumed')
      assert.equal(d.permissionMode, 'full-access')
      assert.deepEqual(d.launchArgs, [
        'resume',
        'codex-thread-1',
        '--dangerously-bypass-approvals-and-sandbox'
      ])
      assert.notEqual(d.lifecycleLogPath, '/old/codex-log.jsonl')
      assert.ok(d.lifecycleLogPath.startsWith(dir), 'the new log is ours, and per-launch')
      assert.equal(created.env.CODEX_TUI_SESSION_LOG_PATH, toHostPath(d.lifecycleLogPath))
      assert.equal(created.env.CODEX_TUI_RECORD_SESSION, '1')
      assert.ok(fs.existsSync(dir), 'the log directory was prepared')

      const s = mgr.get('cx')
      assert.equal(s.status, 'idle')
      assert.equal(s.alive, true)
      assert.equal(s.exitCode, null)
      assert.equal(s.agentSessionId, 'codex-thread-1', 'the thread id is kept, not regenerated')
    } finally {
      await mgr.shutdown()
    }
  })

  test('a phantom Codex thread id restarts fresh instead of resuming a dead conversation', async () => {
    // The id was assigned but never recorded — the session died before its first
    // turn (e.g. at the trust dialog). `codex resume <id>` on it exits with "No
    // conversation found", turning a restart into an instant re-failure.
    const { mgr, tmux } = await makeManager({
      sessions: [persistedSession({ id: 'cx', agent: 'codex', agentSessionId: 'ghost-thread' })],
      descriptors: [
        persistedDescriptor({
          sessionId: 'cx',
          profileId: 'codex',
          command: '/usr/local/bin/codex',
          agentSessionId: 'ghost-thread',
          origin: 'resumed'
        })
      ]
    })
    try {
      // No rollout is seeded for 'ghost-thread'.
      await mgr.restart('cx')
      const created = tmux.calls.filter((c) => c.name === 'createSession').at(-1).args[0]
      assert.ok(!created.command.includes('resume'), 'a phantom thread is never resumed')
      assert.equal(mgr.descriptorFor('cx').origin, 'new')
    } finally {
      await mgr.shutdown()
    }
  })

  test('a phantom Claude session id restarts fresh instead of resuming a dead conversation', async () => {
    const { mgr, tmux } = await makeManager({
      sessions: [persistedSession({ id: 'a', agentSessionId: 'ghost-uuid' })],
      descriptors: [
        persistedDescriptor({
          sessionId: 'a',
          agentSessionId: 'ghost-uuid',
          launchArgs: ['--resume', 'ghost-uuid'],
          origin: 'resumed'
        })
      ]
    })
    try {
      await mgr.restart('a')
      const created = tmux.calls.filter((c) => c.name === 'createSession').at(-1).args[0]
      assert.ok(!created.command.includes('--resume'), 'a phantom id is never resumed')
      const d = mgr.descriptorFor('a')
      assert.equal(d.origin, 'new')
      assert.equal(d.launchArgs[0], '--session-id')
    } finally {
      await mgr.shutdown()
    }
  })

  test('a real Claude conversation is still resumed on restart', async () => {
    const { mgr, tmux, dir } = await makeManager({
      sessions: [persistedSession({ id: 'a', agentSessionId: 'real-uuid' })],
      descriptors: [
        persistedDescriptor({
          sessionId: 'a',
          agentSessionId: 'real-uuid',
          launchArgs: ['--resume', 'real-uuid'],
          origin: 'resumed'
        })
      ]
    })
    seedClaudeTranscript(dir, 'real-uuid', { cwd: '/tmp' })
    try {
      await mgr.restart('a')
      const created = tmux.calls.filter((c) => c.name === 'createSession').at(-1).args[0]
      assert.ok(created.command.includes('--resume'), 'a recorded conversation is resumed')
      assert.ok(created.command.includes('real-uuid'))
      assert.equal(mgr.descriptorFor('a').origin, 'resumed')
    } finally {
      await mgr.shutdown()
    }
  })

  test('a Claude session with no known id restarts as a new conversation, and says so', async () => {
    const { mgr, tmux } = await makeManager({
      sessions: [persistedSession({ id: 'a', agentSessionId: null })],
      descriptors: [persistedDescriptor({ sessionId: 'a', agentSessionId: null })]
    })
    try {
      await mgr.restart('a')
      const d = mgr.descriptorFor('a')
      assert.equal(d.origin, 'new')
      assert.equal(d.launchArgs[0], '--session-id')
      assert.equal(mgr.get('a').agentSessionId, d.launchArgs[1])

      const created = tmux.calls.filter((c) => c.name === 'createSession').at(-1).args[0]
      assert.ok(!created.command.includes('--resume'))
    } finally {
      await mgr.shutdown()
    }
  })

  test('restarting an exited session is the one way back from exited', async () => {
    const { mgr, hooks } = await makeManager({
      sessions: [persistedSession({ id: 'a' })],
      descriptors: [persistedDescriptor({ sessionId: 'a' })]
    })
    try {
      hook(hooks, 'a', 'SessionEnd')
      assert.equal(mgr.get('a').status, 'exited')
      await mgr.restart('a')
      assert.equal(mgr.get('a').status, 'idle')
      assert.equal(mgr.get('a').alive, true)
    } finally {
      await mgr.shutdown()
    }
  })

  test('restarting a session that no longer exists is a no-op, not a crash', async () => {
    const { mgr, tmux } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    try {
      await mgr.restart('ghost')
      assert.equal(tmux.calls.filter((c) => c.name === 'createSession').length, 0)
    } finally {
      await mgr.shutdown()
    }
  })
})

describe('launch fields on the public session', () => {
  test('model, effort and permission mode are folded in from the descriptor', async () => {
    const { mgr } = await makeManager({
      sessions: [persistedSession({ id: 'cl', agent: 'claude', status: 'working' })],
      descriptors: [
        persistedDescriptor({
          sessionId: 'cl',
          profileId: 'claude',
          model: 'claude-opus-4',
          effort: 'high',
          permissionMode: 'full-access'
        })
      ]
    })
    try {
      const s = mgr.get('cl')
      assert.equal(s.model, 'claude-opus-4')
      assert.equal(s.effort, 'high')
      assert.equal(
        s.permissionMode,
        'full-access',
        'the pane footer has to be able to warn about an unsupervised agent'
      )
      assert.equal(mgr.list().find((x) => x.id === 'cl').permissionMode, 'full-access')
    } finally {
      await mgr.shutdown()
    }
  })

  test('a session whose descriptor was discarded claims no permissions it cannot prove', async () => {
    // No descriptor: a version bump threw it away, or the session predates them.
    const { mgr } = await makeManager({
      sessions: [persistedSession({ id: 'orphan', agent: 'claude', status: 'idle' })],
      prefs: { defaultPermissionMode: 'default' }
    })
    try {
      const s = mgr.get('orphan')
      assert.equal(s.model, null)
      assert.equal(s.permissionMode, 'default')
    } finally {
      await mgr.shutdown()
    }
  })

  test('the launch fields are derived on read, never saved alongside the descriptor', async () => {
    const { dir, mgr, store } = await makeManager({
      sessions: [persistedSession({ id: 'cl', agent: 'claude', status: 'working' })],
      descriptors: [
        persistedDescriptor({
          sessionId: 'cl',
          profileId: 'claude',
          model: 'claude-opus-4',
          permissionMode: 'full-access'
        })
      ]
    })
    try {
      assert.equal(mgr.get('cl').permissionMode, 'full-access')

      store.saveNow()
      const saved = JSON.parse(fs.readFileSync(`${dir}/workbench.json`, 'utf8'))
      const stored = saved.sessions.find((s) => s.id === 'cl')
      // One fact, one home. If the session row also carried these, a descriptor
      // discarded by a version bump would leave a session on disk still
      // claiming full access — and the footer would keep saying so.
      assert.notEqual(stored.permissionMode, 'full-access')
      assert.equal(stored.model, null)
      assert.equal(saved.descriptors.find((d) => d.sessionId === 'cl').permissionMode, 'full-access')
    } finally {
      await mgr.shutdown()
    }
  })
})

describe('restore across an app restart', () => {
  test('sessions tmux still has come back alive; the rest come back exited', async () => {
    const dir = tempDir('term-restore-')
    writeState(dir, {
      sessions: [
        persistedSession({ id: 'live', status: 'working' }),
        persistedSession({ id: 'gone', status: 'working' })
      ],
      descriptors: [persistedDescriptor({ sessionId: 'live' })]
    })
    const store = new Store(dir)
    const tmux = fakeTmux({ live: ['term_live'] })
    const mgr = new SessionManager(
      tmux,
      new HookBridge(dir, process.execPath),
      store,
      BINS,
      dir,
      '/usr/bin:/bin'
    )
    await mgr.init()
    try {
      assert.equal(mgr.get('live').alive, true)
      assert.equal(mgr.get('live').status, 'working', 'a surviving session keeps its colour')
      assert.equal(mgr.get('gone').alive, false)
      assert.equal(mgr.get('gone').status, 'exited')
      assert.ok(mgr.descriptorFor('live'), 'descriptors are restored so restart still works')
    } finally {
      await mgr.shutdown()
    }
  })

  test('an orphaned tmux session is adopted as the agent its descriptor names', async () => {
    const dir = tempDir('term-adopt-')
    writeState(dir, {
      sessions: [],
      descriptors: [
        persistedDescriptor({ sessionId: 'orphan', profileId: 'codex', cwd: '/tmp/work' })
      ]
    })
    const store = new Store(dir)
    const tmux = fakeTmux({ live: ['term_orphan', 'someone-elses-session'] })
    const mgr = new SessionManager(
      tmux,
      new HookBridge(dir, process.execPath),
      store,
      BINS,
      dir,
      '/usr/bin:/bin'
    )
    await mgr.init()
    try {
      const adopted = mgr.get('orphan')
      assert.ok(adopted, 'a term_ session we lost track of is reclaimed')
      assert.equal(adopted.agent, 'codex', 'a live Codex session must not be demoted to a shell')
      assert.equal(adopted.cwd, '/tmp/work')
      assert.equal(adopted.alive, true)
      assert.equal(mgr.list().length, 1, 'tmux sessions that are not ours are left alone')
    } finally {
      await mgr.shutdown()
    }
  })

  test('a full cycle survives shutdown and reload', async () => {
    const dir = tempDir('term-cycle-')
    writeState(dir, {
      sessions: [persistedSession({ id: 'a', status: 'idle' })],
      descriptors: [persistedDescriptor({ sessionId: 'a' })]
    })
    const store = new Store(dir)
    const hooks = new HookBridge(dir, process.execPath)
    const mgr = new SessionManager(fakeTmux({ live: ['term_a'] }), hooks, store, BINS, dir, '/usr/bin:/bin')
    await mgr.init()
    hook(hooks, 'a', 'Notification', { message: 'Approve the migration?', session_id: 'cli-9' })
    await flush()
    assert.equal(await mgr.shutdown(), true, 'a clean quit reports a successful save')

    // Second launch, same directory, tmux still has the pane.
    const store2 = new Store(dir)
    assert.equal(store2.error, null)
    const mgr2 = new SessionManager(
      fakeTmux({ live: ['term_a'] }),
      new HookBridge(dir, process.execPath),
      store2,
      BINS,
      dir,
      '/usr/bin:/bin'
    )
    await mgr2.init()
    try {
      const s = mgr2.get('a')
      assert.equal(s.status, 'waiting', 'you should not have to rediscover what it was blocked on')
      assert.equal(s.statusReason, 'Approve the migration?')
      assert.equal(s.agentSessionId, 'cli-9')
      assert.equal(mgr2.descriptorFor('a').agentSessionId, 'cli-9')
    } finally {
      await mgr2.shutdown()
    }
  })
})

/**
 * The turn boundary the preview pane hangs off.
 *
 * "Did this turn produce a document?" is only answerable relative to when the
 * turn began, so the manager reports the boundary and nothing else — no
 * filesystem, no opinion about what is worth showing.
 */
describe('reporting the end of a turn', () => {
  /** Collects `produced` events, which is the whole surface under test. */
  function produced(mgr) {
    const seen = []
    mgr.on('produced', (e) => seen.push(e))
    return seen
  }

  test('a finished turn reports its start, so a scan can be scoped to it', async () => {
    const { mgr, hooks } = await makeManager({
      sessions: [persistedSession({ id: 'a', cwd: '/tmp/project' })]
    })
    try {
      const seen = produced(mgr)
      const before = Date.now()

      hook(hooks, 'a', 'UserPromptSubmit')
      await flush()
      assert.equal(seen.length, 0, 'a turn that has only started has produced nothing yet')

      hook(hooks, 'a', 'Stop')
      await flush()

      assert.equal(seen.length, 1)
      assert.equal(seen[0].sessionId, 'a')
      assert.equal(seen[0].cwd, '/tmp/project')
      assert.ok(seen[0].since >= before, 'the window starts when the turn did')
      assert.ok(seen[0].since <= Date.now())
    } finally {
      await mgr.shutdown()
    }
  })

  test('a turn in flight across a relaunch keeps its start', async () => {
    // The app can be rebuilt and restarted while an agent is mid-turn, and
    // `turnStartedAt` lives only in memory. Without the seed on restore the
    // first turn to end afterwards reports nothing, and a document that turn
    // genuinely wrote never reaches the pane.
    const startedAt = Date.now() - 60_000
    const { mgr, hooks } = await makeManager({
      sessions: [
        persistedSession({
          id: 'a',
          cwd: '/tmp/project',
          status: 'working',
          lastStatusChangeAt: startedAt
        })
      ]
    })
    try {
      const seen = produced(mgr)

      hook(hooks, 'a', 'Stop')
      await flush()

      assert.equal(seen.length, 1, 'the turn still had a boundary to report')
      assert.equal(seen[0].since, startedAt, 'and it is where the turn actually began')
    } finally {
      await mgr.shutdown()
    }
  })

  test('a turn that stopped for a question still reports — that is when output appears', async () => {
    const { mgr, hooks } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    try {
      const seen = produced(mgr)
      hook(hooks, 'a', 'UserPromptSubmit')
      hook(hooks, 'a', 'Notification', { message: 'Approve the write?' })
      await flush()
      assert.equal(seen.length, 1)
    } finally {
      await mgr.shutdown()
    }
  })

  test('a session that died reports nothing', async () => {
    // A crashed turn should not pop a pane open over whatever you were reading.
    const { mgr, hooks } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    try {
      const seen = produced(mgr)
      hook(hooks, 'a', 'UserPromptSubmit')
      hook(hooks, 'a', 'SessionEnd')
      await flush()
      assert.deepEqual(seen, [])
    } finally {
      await mgr.shutdown()
    }
  })

  test('a status change with no turn behind it reports nothing', async () => {
    const { mgr, hooks } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    try {
      const seen = produced(mgr)
      hook(hooks, 'a', 'SessionStart')
      hook(hooks, 'a', 'Stop')
      await flush()
      assert.deepEqual(seen, [], 'nothing ran, so nothing was produced')
    } finally {
      await mgr.shutdown()
    }
  })
})

describe('project manager grants', () => {
  test('an explicit App Manager grant persists without binding and survives organizational moves', async () => {
    const { mgr, dir } = await makeManager({ sessions: [persistedSession({ id: 'app-grant', sessionProjectId: null })] })
    try {
      assert.throws(() => mgr.setBusAccess('app-grant', 'app-manager', 'one'), /without a project binding/)
      assert.equal(mgr.setBusAccess('app-grant', 'app-manager'), true)
      assert.equal(mgr.get('app-grant').busProjectId, null)
      assert.equal(mgr.setBusAccess('app-grant', 'app-manager'), false)
      mgr.assignSessionProject('app-grant', 'one')
      assert.equal(mgr.get('app-grant').bus, 'app-manager')
      mgr.clearSessionProject('one')
      assert.equal(mgr.get('app-grant').bus, 'app-manager')
      await mgr.shutdown()
      const saved = new Store(dir).sessions.find(s => s.id === 'app-grant')
      assert.equal(saved.bus, 'app-manager')
      assert.equal(saved.busProjectId, null)
      mgr.setBusAccess('app-grant', 'off')
      assert.equal(mgr.get('app-grant').bus, 'off')
      assert.equal(mgr.get('app-grant').busProjectId, null)
    } finally { await mgr.shutdown() }
  })

  test('real session creation never inherits its App Manager parent grant', async () => {
    const { mgr } = await makeManager({ sessions: [persistedSession({ id: 'central', bus: 'app-manager', busProjectId: null, sessionProjectId: 'one' })] })
    try {
      const worker = await mgr.create({ agent: 'shell', title: 'Reviewer', parentId: 'central', sessionProjectId: 'two', permissionMode: 'default' })
      assert.equal(worker.parentId, 'central')
      assert.equal(worker.sessionProjectId, 'two')
      assert.equal(worker.bus, 'off')
      assert.equal(worker.busProjectId ?? null, null)
      await mgr.remove('central')
      assert.equal(mgr.get('central'), undefined)
      assert.equal(mgr.get(worker.id).bus, 'off')
    } finally { await mgr.shutdown() }
  })

  test('grant binds to the current project, persists, and is revoked by refiling', async () => {
    const { mgr, dir } = await makeManager({ sessions: [persistedSession({ id: 'grant-test', sessionProjectId: 'one' })] })
    assert.equal(mgr.setBusAccess('grant-test', 'manager', 'one'), true)
    assert.equal(mgr.get('grant-test').busProjectId, 'one')
    await mgr.shutdown()
    const reloaded = new Store(dir)
    assert.equal(reloaded.sessions.find(s => s.id === 'grant-test').bus, 'manager')
    assert.equal(reloaded.sessions.find(s => s.id === 'grant-test').busProjectId, 'one')
    mgr.assignSessionProject('grant-test', 'two')
    assert.equal(mgr.get('grant-test').bus, 'off')
    assert.equal(mgr.get('grant-test').busProjectId, null)
    assert.throws(() => mgr.setBusAccess('grant-test', 'manager', 'one'), /project changed/)
    assert.throws(() => mgr.setBusAccess('grant-test', 'manager'), /project changed/)
    assert.equal(mgr.get('grant-test').bus, 'off', 'stale confirmation cannot authorize another project')
    mgr.setBusAccess('grant-test', 'manager', 'two')
    mgr.clearSessionProject('two')
    assert.equal(mgr.get('grant-test').bus, 'off')
    assert.throws(() => mgr.setBusAccess('grant-test', 'manager'), /File this session/)
    await mgr.shutdown()
  })
  test('saved manager access without a matching explicit project binding loads as Off', async () => {
    const { mgr } = await makeManager({ sessions: [
      persistedSession({ id: 'unbound', bus: 'manager', sessionProjectId: 'one' }),
      persistedSession({ id: 'mismatch', bus: 'manager', busProjectId: 'two', sessionProjectId: 'one' })
    ] })
    assert.equal(mgr.get('unbound').bus, 'off')
    assert.equal(mgr.get('mismatch').bus, 'off')
    await mgr.shutdown()
  })
})

test('a worker created during a liveness snapshot is not falsely marked exited', async () => {
  const { mgr, tmux } = await makeManager({ sessions: [persistedSession({ id: 'existing' })] })
  try {
    let release
    tmux.allPaneInfo = () => new Promise(resolve => { release = resolve })
    const polling = mgr.poll()
    const created = await mgr.create({ agent: 'shell', title: 'New worker' })
    release(new Map([['term_existing', alivePane('term_existing')]]))
    await polling
    assert.equal(mgr.get(created.id).alive, true)
    assert.equal(mgr.get(created.id).status, 'idle')
  } finally { await mgr.shutdown() }
})

test('an open MCP approval dialog needs the user, but its old scrollback does not', async () => {
  const screen = 'Allow the workbench MCP server to run tool "create_session"?\n  1. Allow\n  2. Allow for this session\nenter to submit | esc to cancel\n'
  for (const active of [true, false]) {
    const { mgr } = await makeManager({ sessions: [persistedSession({ id: 'approval-test', agent: 'codex', status: 'working' })],
      tmux: { paneInfoFor: name => alivePane(name), captureTailText: screen + (active ? '' : '\nTool completed\n› Next prompt\n') } })
    try {
      mgr.get('approval-test').lastActivityAt = Date.now() - 5000
      await mgr.poll()
      assert.equal(mgr.get('approval-test').status, active ? 'waiting' : 'working')
      if (active) {
        const stamp = mgr.get('approval-test').lastPromptAt
        mgr.applyCodexSignal(mgr.get('approval-test'), { kind: 'approval-resolved' })
        assert.equal(mgr.get('approval-test').status, 'working')
        assert.equal(mgr.get('approval-test').lastPromptAt, stamp)
      }
    } finally { await mgr.shutdown() }
  }
})

describe('role and recent-work persistence', () => {
  test('legacy random names migrate from their bound transcript without changing status or identity', async () => {
    const dir = tempDir('workbench-role-history-'), file = `${dir}/conversation.jsonl`
    fs.writeFileSync(file, [
      { message: { role: 'user', content: 'Review my budget' } },
      { message: { role: 'assistant', content: 'Reviewed expenses and found three recurring charges. Next steps follow.' } }
    ].map((row) => JSON.stringify(row)).join('\n'))
    const { mgr, store, tmux, dir: stateDir } = await makeManager({
      sessions: [persistedSession({ id: 'finance', title: 'Sparkling otter', titleMode: 'manual', status: 'working', sessionProjectId: 'finance-project' })],
      descriptors: [persistedDescriptor({ sessionId: 'finance', transcriptPath: file })]
    })
    try {
      const session = mgr.get('finance')
      assert.equal(session.title, 'Financial Advisor')
      assert.equal(session.lastTask, 'Reviewed expenses and found three recurring charges')
      assert.equal(session.status, 'working')
      assert.equal(session.tmuxName, 'term_finance')
      assert.equal(session.sessionProjectId, 'finance-project')
      assert.equal(tmux.calls.filter((call) => call.name === 'submitPrompt').length, 0)
      assert.equal(store.saveNow(), true)
      const saved = new Store(stateDir)
      // Use the manager's actual persisted snapshot: restoring naming is a data
      // migration, never a synthetic turn sent to the agent.
      assert.equal(saved.sessions[0].titleVersion, 1)
      assert.equal(saved.sessions[0].lastTask, session.lastTask)
      assert.equal(saved.sessions[0].title, store.sessions[0].title)
    } finally { await mgr.shutdown() }
  })

  test('Claude completion updates the summary; failed sends and acknowledgments preserve it', async () => {
    const { mgr, hooks, tmux, dir } = await makeManager({ sessions: [persistedSession({ id: 'a' })] })
    const file = `${dir}/conversation.jsonl`
    try {
      await mgr.sendPrompt('a', 'Review my budget')
      assert.equal(mgr.get('a').title, 'Financial Advisor')
      fs.writeFileSync(file, JSON.stringify({ message: { role: 'assistant', content: 'Found three recurring charges. Details below.' } }))
      hook(hooks, 'a', 'Stop', { transcript_path: file })
      assert.equal(mgr.get('a').lastTask, 'Found three recurring charges')
      assert.equal(mgr.get('a').status, 'review')
      tmux.submitPromptFailure = () => new Error('Delivery failed')
      await assert.rejects(mgr.sendPrompt('a', 'Build a React app'), /Delivery failed/)
      assert.equal(mgr.get('a').lastTask, 'Found three recurring charges')
      tmux.submitPromptFailure = () => null
      await mgr.sendPrompt('a', 'Thanks!')
      assert.equal(mgr.get('a').lastTask, 'Found three recurring charges')
    } finally { await mgr.shutdown() }
  })

  test('Codex final answer supplies the reminder while retaining its role', async () => {
    const { mgr, hooks, store, dir } = await makeManager({ sessions: [persistedSession({ id: 'cx', agent: 'codex' })] })
    try {
      await mgr.sendPrompt('cx', 'Fix the app scheduler')
      hook(hooks, 'cx', 'agent-turn-complete', { 'input-messages': ['Fix the app scheduler'], 'last-assistant-message': 'Fixed the scheduled task editor. Tests pass.' }, 'codex')
      await flush()
      assert.equal(mgr.get('cx').title, 'Software Engineer')
      assert.equal(mgr.get('cx').lastTask, 'Fixed the scheduled task editor')
      assert.equal(mgr.get('cx').status, 'review')
      assert.equal(store.saveNow(), true)
      assert.equal(new Store(dir).sessions[0].lastTask, store.sessions[0].lastTask)
      mgr.rename('cx', 'Quality Engineer')
      await mgr.sendPrompt('cx', 'Now build another app')
      assert.equal(mgr.get('cx').title, 'Quality Engineer')
    } finally { await mgr.shutdown() }
  })
})
