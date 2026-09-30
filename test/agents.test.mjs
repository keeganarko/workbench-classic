/**
 * The agent registry.
 *
 * What is worth pinning here is not that the table has three rows — it is the
 * rule that keeps the table honest: **a capability is a claim about a real
 * command line.** Workbench passes `--resume` only to a CLI that documents
 * `--resume`. An agent that declares nothing still launches, still appears
 * everywhere, and still takes broadcast input; what it does not get is a flag
 * somebody guessed at. A wrong resume flag starts a fresh conversation and
 * looks like it worked, which is the failure this file exists to prevent.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  AGENT_PRESETS,
  BUILTIN_IDS,
  NO_CAPABILITIES,
  agentCan,
  agentColor,
  agentLabel,
  allDefinitions,
  definitionOr,
  findDefinition,
  isAgentId,
  slugifyAgentId
} from '../src/shared/agents.js'
import { buildLaunchSpec, permissionArgs } from '../src/main/agents.js'
import { asPrefsPatch } from '../src/main/validate.js'

const custom = (over = {}) => ({
  id: 'gemini',
  label: 'Gemini CLI',
  command: 'gemini',
  args: [],
  color: '#4285f4',
  ...over
})

describe('the table', () => {
  test('the three built-ins are there, in a stable order', () => {
    assert.deepEqual(BUILTIN_IDS, ['claude', 'codex', 'shell'])
    assert.deepEqual(
      allDefinitions().map((d) => d.id),
      ['claude', 'codex', 'shell']
    )
  })

  test('user agents come after the built-ins and claim nothing', () => {
    const all = allDefinitions([custom()])
    assert.deepEqual(
      all.map((d) => d.id),
      ['claude', 'codex', 'shell', 'gemini']
    )
    const gemini = all[3]
    assert.equal(gemini.launch, 'plain')
    assert.equal(gemini.builtin, false)
    assert.deepEqual(gemini.capabilities, NO_CAPABILITIES)
  })

  test('a user agent may not shadow a built-in', () => {
    // The built-in owns a hook bridge and a transcript parser; an override that
    // silently disabled them would look like Claude and behave like a stranger.
    const all = allDefinitions([custom({ id: 'claude', label: 'Not Claude', command: 'nope' })])
    assert.equal(all.length, 3)
    assert.equal(agentLabel('claude', [custom({ id: 'claude', label: 'Not Claude' })]), 'Claude Code')
  })

  test('the shell is in the registry, and is not an agent', () => {
    const shell = definitionOr('shell')
    assert.equal(shell.launch, 'plain')
    assert.deepEqual(shell.capabilities, NO_CAPABILITIES)
    // Every list, filter and colour that handles agents handles it too.
    assert.equal(agentColor('shell'), '#8b949e')
  })

  test('Claude takes effort through the model string, so claims no effort flag', () => {
    assert.equal(agentCan('claude', 'model'), true)
    assert.equal(agentCan('claude', 'effort'), false)
    assert.equal(agentCan('codex', 'effort'), true)
  })
})

describe('an id nothing matches', () => {
  test('findDefinition says so; definitionOr never does', () => {
    assert.equal(findDefinition('deleted-agent'), null)
    const placeholder = definitionOr('deleted-agent')
    assert.equal(placeholder.id, 'deleted-agent')
    assert.equal(placeholder.builtin, false)
    assert.deepEqual(placeholder.capabilities, NO_CAPABILITIES)
  })

  test('a session whose profile the user deleted still renders', () => {
    // The point of the placeholder: the row stays visible and legible, so the
    // conversation is still reachable, rather than drawing as a blank chip.
    assert.equal(agentLabel('gemini'), 'gemini')
    assert.equal(agentColor('gemini'), '#8b949e')
    assert.equal(agentCan('gemini', 'resume'), false)
  })
})

describe('ids', () => {
  test('the shape used in filenames, tmux names and class names', () => {
    assert.equal(isAgentId('gemini-cli'), true)
    assert.equal(isAgentId('a'), true)
    assert.equal(isAgentId('Gemini'), false, 'no capitals')
    assert.equal(isAgentId('2fast'), false, 'must start with a letter')
    assert.equal(isAgentId('has space'), false)
    assert.equal(isAgentId('has/slash'), false)
    assert.equal(isAgentId(''), false)
    assert.equal(isAgentId('a'.repeat(33)), false)
    assert.equal(isAgentId(null), false)
  })

  test('slugs come from labels', () => {
    assert.equal(slugifyAgentId('Gemini CLI'), 'gemini-cli')
    assert.equal(slugifyAgentId('  Aider  '), 'aider')
    assert.equal(slugifyAgentId('Cursor / Agent!'), 'cursor-agent')
  })

  test('a label that cannot start an id is prefixed rather than rejected', () => {
    assert.equal(isAgentId(slugifyAgentId('2fast')), true)
    assert.equal(isAgentId(slugifyAgentId('----')), true)
  })

  test('every preset slugifies to a usable id, and none collide', () => {
    const ids = AGENT_PRESETS.map((p) => slugifyAgentId(p.label))
    for (const id of ids) assert.equal(isAgentId(id), true, id)
    assert.equal(new Set(ids).size, ids.length)
  })

  test('a preset carries a command and a colour and no flags', () => {
    // Deliberate: these are the CLIs whose existence is well known and whose
    // command lines this project has not verified.
    for (const p of AGENT_PRESETS) {
      assert.deepEqual(p.args, [])
      assert.match(p.color, /^#[0-9a-f]{6}$/)
    }
  })
})

describe('validating what the settings form sends', () => {
  const patch = (agents) => asPrefsPatch({ customAgents: agents }).customAgents

  test('a plain profile survives intact', () => {
    assert.deepEqual(patch([custom()]), [custom()])
  })

  test('the id is derived from the label when none is supplied', () => {
    const [a] = patch([{ label: 'Gemini CLI', command: 'gemini' }])
    assert.equal(a.id, 'gemini-cli')
    assert.deepEqual(a.args, [])
  })

  test('an id already assigned stays put when the label is renamed', () => {
    // It is on every session this profile has ever launched; deriving a fresh
    // one from the new label would orphan them.
    const [a] = patch([custom({ id: 'gemini', label: 'Gemini, renamed' })])
    assert.equal(a.id, 'gemini')
  })

  test('a profile shadowing a built-in is dropped, not thrown on', () => {
    assert.deepEqual(patch([custom({ id: 'codex' })]), [])
  })

  test('two profiles with the same id keep the first', () => {
    const out = patch([custom(), custom({ label: 'Gemini Again' })])
    assert.equal(out.length, 1)
    assert.equal(out[0].label, 'Gemini CLI')
  })

  test('a colour that is not a hex triple falls back rather than failing', () => {
    assert.equal(patch([custom({ color: 'red' })])[0].color, '#8b949e')
    assert.equal(patch([custom({ color: undefined })])[0].color, '#8b949e')
  })

  test('a nameless or commandless profile is refused', () => {
    assert.throws(() => patch([custom({ label: '   ' })]), /agent name/)
    assert.throws(() => patch([custom({ command: '' })]), /agent command/)
  })

  test('the list and each argv are bounded', () => {
    assert.throws(() => patch(new Array(33).fill(custom())), /custom agents/)
    assert.equal(patch([custom({ args: new Array(50).fill('-x') })])[0].args.length, 32)
  })

  test('existence is deliberately not checked here', () => {
    // Whether `gemini` is installed is a fact about the machine at launch time,
    // not about this payload — a profile for a CLI you are about to install
    // must save fine.
    assert.equal(patch([custom({ command: '/nowhere/at/all' })])[0].command, '/nowhere/at/all')
  })
})

describe('launching what we do not know', () => {
  const base = {
    bin: '/usr/local/bin/gemini',
    claudeSettingsPath: '/tmp/settings.json',
    newSessionId: '11111111-1111-4111-8111-111111111111'
  }

  test('a plain launch is the command, its arguments, and nothing invented', () => {
    const def = definitionOr('gemini', [custom({ args: ['--yolo'] })])
    const spec = buildLaunchSpec({ ...base, definition: def })
    assert.deepEqual(spec.command, ['/usr/local/bin/gemini', '--yolo'])
    assert.deepEqual(spec.launchArgs, [])
    assert.equal(spec.assignedSessionId, null)
    assert.equal(spec.lifecycleLogPath, null)
  })

  test('asking a plain agent to resume adds no resume flag', () => {
    // The whole rule, in one assertion: a guessed `--resume` would start a new
    // conversation and look like it had worked.
    const def = definitionOr('gemini', [custom()])
    const spec = buildLaunchSpec({
      ...base,
      definition: def,
      resumeFrom: 'abc-123',
      forkFromParent: true
    })
    assert.equal(
      spec.command.some((a) => a.includes('resume') || a.includes('fork') || a === 'abc-123'),
      false
    )
  })

  test('no permission flag either, whatever mode the session records', () => {
    const def = definitionOr('gemini', [custom()])
    assert.deepEqual(permissionArgs(def, 'full-access'), [])
    assert.deepEqual(permissionArgs(def, 'auto'), [])
  })

  test('a plain agent gets no session-bus argv', () => {
    const def = definitionOr('gemini', [custom()])
    const spec = buildLaunchSpec({
      ...base,
      definition: def,
      busMcp: { claudeMcpConfig: '/tmp/bus.json', codexArgs: ['-c', 'x=1'] }
    })
    assert.deepEqual(spec.command, ['/usr/local/bin/gemini'])
  })

  test('a shell is a plain launch with a login flag', () => {
    const spec = buildLaunchSpec({ ...base, bin: '/bin/zsh', definition: definitionOr('shell') })
    assert.deepEqual(spec.command, ['/bin/zsh', '-l'])
  })
})
