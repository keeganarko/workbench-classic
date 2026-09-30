/**
 * Two Codex sessions running at once.
 *
 * Codex offers no per-session channel of its own, so both halves of its
 * telemetry — the rollout transcript and the TUI lifecycle log — have to be
 * bound to the right process by us. Getting this wrong does not throw; it
 * silently attributes one session's work to another, which is why it is tested
 * with two concurrent identities rather than one.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  listCodexRollouts,
  findCodexRolloutBySessionId,
  findCodexRolloutForLaunch,
  parseCodexSessionLog,
  classifyCodexLogEntry,
  transcriptToMarkdown,
  buildLaunchSpec,
  permissionArgs
} from '../src/main/agents.js'
import { extractAgentSessionId } from '../src/main/sessions.js'
import { definitionOr } from '../src/shared/agents.js'
import { tempDir } from './helpers.mjs'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const CWD_A = '/tmp/project-a'
const CWD_B = '/tmp/project-b'

let home
let fileA
let fileB
let startedAt

/** Writes a rollout the way Codex names and heads them. */
function writeRollout(id, cwd, isoStamp, turns) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '02')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-${isoStamp}-${id}.jsonl`)
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: { session_id: id, cwd, timestamp: new Date(startedAt + 1000).toISOString() }
    }),
    ...turns.map((t) =>
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: t.role, content: [{ type: 'output_text', text: t.text }] }
      })
    )
  ]
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

before(() => {
  home = tempDir('term-home-')
  startedAt = Date.now() - 60_000
  fileA = writeRollout(ID_A, CWD_A, '2026-09-02T10-00-00', [
    { role: 'user', text: 'work on project A' },
    { role: 'assistant', text: 'A is done' }
  ])
  fileB = writeRollout(ID_B, CWD_B, '2026-09-02T10-00-05', [
    { role: 'user', text: 'work on project B' },
    { role: 'assistant', text: 'B is done' }
  ])
  // Give B the later mtime so "newest first" has something to order.
  const now = Date.now()
  fs.utimesSync(fileA, now / 1000 - 10, now / 1000 - 10)
  fs.utimesSync(fileB, now / 1000, now / 1000)
})

describe('codex identity', () => {
  test('lists both rollouts, newest first, with their own ids and folders', () => {
    const found = listCodexRollouts(0, home)
    assert.equal(found.length, 2)
    assert.equal(found[0].sessionId, ID_B, 'newest first')
    assert.equal(found[1].sessionId, ID_A)
    assert.equal(found[0].cwd, CWD_B)
    assert.equal(found[1].cwd, CWD_A)
  })

  test('a known thread id resolves to that session and no other', () => {
    assert.equal(findCodexRolloutBySessionId(ID_A, home), fileA)
    assert.equal(findCodexRolloutBySessionId(ID_B, home), fileB)
    assert.equal(findCodexRolloutBySessionId('33333333-3333-4333-8333-333333333333', home), null)
  })

  test('an unknown id is bound by folder and launch window, never by "newest"', () => {
    assert.equal(findCodexRolloutForLaunch({ home, cwd: CWD_A, sinceMs: startedAt }), fileA)
    assert.equal(findCodexRolloutForLaunch({ home, cwd: CWD_B, sinceMs: startedAt }), fileB)
  })

  test('two candidates in one folder produce no binding at all', () => {
    // Same working directory is exactly the "start Claude and Codex side by
    // side, twice" case. Guessing here would attach the wrong transcript to a
    // fork or a handoff, so refusing is the correct answer.
    const third = writeRollout('33333333-3333-4333-8333-333333333333', CWD_A, '2026-09-02T10-00-09', [
      { role: 'user', text: 'a second session in the same folder' }
    ])
    try {
      assert.equal(findCodexRolloutForLaunch({ home, cwd: CWD_A, sinceMs: startedAt }), null)
      // Claiming one of them leaves exactly one candidate, which is bindable.
      assert.equal(
        findCodexRolloutForLaunch({ home, cwd: CWD_A, sinceMs: startedAt, claimed: [third] }),
        fileA
      )
      assert.equal(
        findCodexRolloutForLaunch({ home, cwd: CWD_A, sinceMs: startedAt, claimed: [ID_A] }),
        third
      )
    } finally {
      fs.rmSync(third)
    }
  })

  test('a rollout from before this launch is not adopted', () => {
    assert.equal(findCodexRolloutForLaunch({ home, cwd: CWD_A, sinceMs: Date.now() + 60_000 }), null)
    assert.equal(
      findCodexRolloutForLaunch({ home, cwd: CWD_A, sinceMs: startedAt, untilMs: startedAt - 1 }),
      null
    )
  })

  test('each session exports its own transcript', () => {
    const a = transcriptToMarkdown(fileA)
    const b = transcriptToMarkdown(fileB)
    assert.match(a, /work on project A/)
    assert.match(a, /A is done/)
    assert.ok(!a.includes('project B'), 'A must not contain B')
    assert.match(b, /work on project B/)
    assert.ok(!b.includes('project A'), 'B must not contain A')
    assert.equal(transcriptToMarkdown(path.join(home, 'missing.jsonl')), '')
  })

  test('the notify payload id is read from the hyphenated key Codex actually sends', () => {
    assert.equal(extractAgentSessionId({ 'thread-id': ID_A }), ID_A)
    assert.equal(extractAgentSessionId({ thread_id: ID_B }), ID_B)
    assert.equal(extractAgentSessionId({ session_id: 'claude-1' }), 'claude-1')
    assert.equal(extractAgentSessionId({ 'conversation-id': 'c1' }), 'c1')
    assert.equal(extractAgentSessionId({}), null)
    assert.equal(extractAgentSessionId({ 'thread-id': '   ' }), null)
  })
})

describe('codex lifecycle log', () => {
  test('gives each launch its own log path, which is what keeps two sessions apart', () => {
    const specA = buildLaunchSpec({
      definition: definitionOr('codex'),
      bin: '/usr/local/bin/codex',
      cwd: CWD_A,
      claudeSettingsPath: '/x/settings.json',
      codexNotifyShim: '/x/notify.sh',
      codexSessionLogPath: '/x/logs/a.jsonl',
      newSessionId: 'unused'
    })
    const specB = buildLaunchSpec({
      definition: definitionOr('codex'),
      bin: '/usr/local/bin/codex',
      cwd: CWD_B,
      claudeSettingsPath: '/x/settings.json',
      codexNotifyShim: '/x/notify.sh',
      codexSessionLogPath: '/x/logs/b.jsonl',
      newSessionId: 'unused'
    })

    assert.equal(specA.env.CODEX_TUI_RECORD_SESSION, '1')
    assert.equal(specA.env.CODEX_TUI_SESSION_LOG_PATH, '/x/logs/a.jsonl')
    assert.equal(specB.env.CODEX_TUI_SESSION_LOG_PATH, '/x/logs/b.jsonl')
    assert.notEqual(specA.lifecycleLogPath, specB.lifecycleLogPath)

    // Hooks are per-invocation argv; the user's ~/.codex/config.toml is untouched.
    assert.deepEqual(specA.baseArgs, ['-c', 'notify=["/x/notify.sh"]'])
  })

  test('tails a log without re-reading it and without eating a partial line', () => {
    const dir = tempDir()
    const file = path.join(dir, 'codex.jsonl')
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ kind: 'session_start', cwd: CWD_A, model: 'gpt-5' }),
        JSON.stringify({ kind: 'op', dir: 'from_tui', payload: { UserTurn: { items: [] } } })
      ].join('\n') + '\n'
    )

    const first = parseCodexSessionLog(file, 0)
    assert.deepEqual(
      first.signals.map((s) => s.kind),
      ['started', 'turn-start']
    )
    assert.equal(first.signals[0].cwd, CWD_A)
    assert.equal(first.signals[0].model, 'gpt-5')

    // Nothing new yet.
    assert.deepEqual(parseCodexSessionLog(file, first.nextByte).signals, [])

    // A half-written line must not be consumed.
    fs.appendFileSync(file, '{"kind":"app_event","dir":"to_tui","variant":"TurnAbo')
    const partial = parseCodexSessionLog(file, first.nextByte)
    assert.deepEqual(partial.signals, [])
    assert.equal(partial.nextByte, first.nextByte, 'the offset must not advance past a partial line')

    fs.appendFileSync(file, 'rted"}\n')
    const second = parseCodexSessionLog(file, partial.nextByte)
    assert.deepEqual(
      second.signals.map((s) => s.kind),
      ['interrupted']
    )

    // A restart rewrites the file; a shorter file means start over, not skip.
    fs.writeFileSync(file, JSON.stringify({ kind: 'session_end' }) + '\n')
    const restarted = parseCodexSessionLog(file, second.nextByte)
    assert.deepEqual(
      restarted.signals.map((s) => s.kind),
      ['ended']
    )
  })

  test('a missing log is not an error', () => {
    const result = parseCodexSessionLog('/nonexistent/codex.jsonl', 0)
    assert.deepEqual(result, { signals: [], nextByte: 0 })
  })

  test('classifies the entries that decide a session colour', () => {
    assert.deepEqual(classifyCodexLogEntry({ kind: 'session_end' }), { kind: 'ended' })
    assert.deepEqual(
      classifyCodexLogEntry({ kind: 'op', dir: 'from_tui', payload: { UserInput: {} } }),
      { kind: 'turn-start', text: null }
    )
    // The prompt rides along, because it is what tells your turn apart from the
    // ones Codex starts by itself. Images contribute no text and are skipped.
    assert.deepEqual(
      classifyCodexLogEntry({
        kind: 'op',
        dir: 'from_tui',
        payload: {
          UserTurn: {
            items: [
              { type: 'image', path: '/tmp/a.png' },
              { type: 'text', text: 'ship the release notes' }
            ]
          }
        }
      }),
      { kind: 'turn-start', text: 'ship the release notes' }
    )
    assert.deepEqual(
      classifyCodexLogEntry({ kind: 'app_event', dir: 'to_tui', variant: 'TurnAborted' }),
      { kind: 'interrupted' }
    )
    for (const variant of ['StopCommitAnimation', 'TaskComplete', 'TurnComplete']) {
      assert.equal(
        classifyCodexLogEntry({ kind: 'app_event', dir: 'to_tui', variant }),
        null,
        `${variant} is presentation, not lifecycle`
      )
    }
    for (const variant of ['PermissionResolved', 'ApprovalCompleted', 'SetApprovalPolicy', 'ConfirmSettings', 'TrustUpdated',
      'UpdateAskForApprovalPolicy', 'UpdateActivePermissionProfile', 'UpdateApprovalsReviewer', 'OpenApprovalsPopup']) {
      assert.equal(classifyCodexLogEntry({ kind: 'app_event', dir: 'to_tui', variant }), null,
        `${variant} is not a verified pending approval request`)
    }
    for (const variant of ['FullScreenApprovalRequest', 'ExecApprovalRequest', 'PatchApprovalRequest', 'TrustDirectory']) {
      const got = classifyCodexLogEntry({ kind: 'app_event', dir: 'to_tui', variant })
      assert.equal(got?.kind, 'approval', variant)
      assert.equal(got.reason, variant)
    }
    // Anything unrecognised must degrade to "no signal", never to a guess.
    assert.equal(classifyCodexLogEntry({ kind: 'app_event', dir: 'to_tui', variant: 'Redraw' }), null)
    assert.equal(classifyCodexLogEntry({ kind: 'op', dir: 'to_tui', payload: { UserTurn: {} } }), null)
    assert.equal(classifyCodexLogEntry({}), null)
  })
})

test('current Codex human-response operations resolve approval without beginning another turn', () => {
  for (const response of ['ResolveElicitation', 'ExecApproval', 'PatchApproval', 'UserInputAnswer', 'RequestPermissionsResponse']) {
    assert.deepEqual(classifyCodexLogEntry({ kind: 'op', dir: 'from_tui', payload: { [response]: { id: 'test-request' } } }),
      { kind: 'approval-resolved' }, response)
  }
})

describe('permission modes', () => {
  test('full access maps to each CLI’s own bypass flag and nothing global', () => {
    assert.deepEqual(permissionArgs(definitionOr('claude'), 'full-access'), ['--dangerously-skip-permissions'])
    assert.deepEqual(permissionArgs(definitionOr('codex'), 'full-access'), [
      '--dangerously-bypass-approvals-and-sandbox'
    ])
    assert.deepEqual(permissionArgs(definitionOr('claude'), 'auto'), ['--permission-mode', 'acceptEdits'])
    assert.deepEqual(permissionArgs(definitionOr('codex'), 'auto'), ['--sandbox', 'workspace-write'])
    assert.deepEqual(permissionArgs(definitionOr('claude'), 'default'), [])
    assert.deepEqual(permissionArgs(definitionOr('codex'), 'default'), [])
    assert.deepEqual(permissionArgs(definitionOr('shell'), 'full-access'), [], 'a plain shell has no such flag')
  })

  test('a fresh Claude launch pins its own session id; a fork must not', () => {
    const fresh = buildLaunchSpec({
      definition: definitionOr('claude'),
      bin: '/usr/local/bin/claude',
      cwd: CWD_A,
      claudeSettingsPath: '/x/settings.json',
      codexNotifyShim: '/x/notify.sh',
      newSessionId: 'new-uuid',
      permissionMode: 'full-access'
    })
    assert.equal(fresh.assignedSessionId, 'new-uuid')
    assert.ok(fresh.launchArgs.includes('--session-id'))
    assert.ok(fresh.command.includes('--dangerously-skip-permissions'))
    assert.deepEqual(fresh.baseArgs, ['--settings', '/x/settings.json'])

    const forked = buildLaunchSpec({
      definition: definitionOr('claude'),
      bin: '/usr/local/bin/claude',
      cwd: CWD_A,
      claudeSettingsPath: '/x/settings.json',
      codexNotifyShim: '/x/notify.sh',
      newSessionId: 'unused',
      resumeFrom: 'parent-uuid',
      forkFromParent: true
    })
    assert.equal(forked.assignedSessionId, null, '--fork-session mints its own id')
    assert.deepEqual(forked.launchArgs, ['--resume', 'parent-uuid', '--fork-session'])
  })
})

test('MCP elicitation responses resume the current turn without inventing a new prompt', () => {
  assert.deepEqual(classifyCodexLogEntry({ kind: 'op', dir: 'from_tui', payload: { ResolveElicitation: { decision: 'accept' } } }), { kind: 'approval-resolved' })
})
