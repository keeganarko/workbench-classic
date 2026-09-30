/**
 * Pre-session prompts: the window before an agent exists.
 *
 * Hooks are the authoritative status source, but a CLI stopped at its own
 * trust, sign-in or first-run screen has not installed one yet and will not
 * until you answer. Those minutes used to read as a calm grey "idle" dot on a
 * pane that was blocked on a question — the exact failure this app exists to
 * remove.
 *
 * Two things are tested here: that the shipped patterns fire on the shape of
 * text those screens produce and stay quiet on ordinary output, and that a new
 * rule actually reaches an install that already exists. The sample text below
 * is representative of each screen, not a transcript captured from a specific
 * CLI version — the patterns are deliberately written around the stable phrase
 * in each, not an exact frame.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_TRIGGERS, migrate } from '../src/main/store.js'
import { asPrefsPatch } from '../src/main/validate.js'

/** Applies one shipped rule the way SessionManager does. */
function fires(id, text) {
  const rule = DEFAULT_TRIGGERS.find((t) => t.id === id)
  assert.ok(rule, `no shipped rule named ${id}`)
  assert.equal(rule.enabled, true, `${id} ships disabled`)
  return new RegExp(rule.pattern, rule.flags).test(text)
}

/** Every rule that would change a session's colour, for the given agent. */
function statusRulesFor(agent) {
  return DEFAULT_TRIGGERS.filter(
    (t) => t.enabled && (t.agent === 'any' || t.agent === agent) && t.action !== 'notify'
  )
}

/** What the poll loop would conclude from a pane full of `text`. */
function verdict(agent, text) {
  const hits = statusRulesFor(agent).filter((r) => new RegExp(r.pattern, r.flags).test(text))
  return (
    hits.find((h) => h.action === 'failed')?.action ??
    hits.find((h) => h.action === 'waiting')?.action ??
    hits.find((h) => h.action === 'working')?.action ??
    hits.find((h) => h.action === 'review')?.action ??
    null
  )
}

describe('claude pre-session screens', () => {
  test('the folder trust prompt is a question, not idling', () => {
    assert.equal(
      verdict(
        'claude',
        [
          '╭──────────────────────────────────────╮',
          '│ Do you trust the files in this folder?│',
          '│ /Users/me/Dev/terminal              │',
          '│ ❯ 1. Yes, proceed                    │',
          '│   2. No, exit                        │',
          '╰──────────────────────────────────────╯'
        ].join('\n')
      ),
      'waiting'
    )
  })

  test('a sign-in screen is a question', () => {
    assert.ok(fires('claude-login', 'Select login method:\n  1. Claude account'))
    assert.ok(fires('claude-login', 'Invalid API key · Please run /login'))
  })

  test('first-run setup is a question', () => {
    assert.ok(fires('claude-first-run', 'Choose the text style that looks best'))
    assert.ok(fires('claude-first-run', "Let's get started."))
    assert.ok(fires('claude-first-run', 'Press Enter to continue…'))
  })

  test('the dangerous-mode acceptance screen is a question', () => {
    assert.equal(
      verdict('claude', 'WARNING: Claude Code running in Bypass Permissions mode\n❯ 2. Yes, I accept'),
      'waiting'
    )
  })

  test('an in-session permission prompt is a question', () => {
    assert.ok(fires('claude-permission', 'Do you want to make this edit to store.ts?'))
    assert.ok(fires('claude-permission', '❯ 3. No, and tell Claude what to do differently'))
  })

  test('ordinary working output stays quiet', () => {
    // The cost of a false positive is a red dot that means nothing, which is
    // worse than no dot at all — you stop trusting the colour.
    for (const text of [
      '● Read src/main/store.ts (469 lines)',
      'Running tests… 126 passing',
      'I trust the files here are fine to edit.',
      '  claude-trust is one of the shipped rules'
    ]) {
      assert.equal(verdict('claude', text), null, `fired on: ${text}`)
    }
  })
})

describe('a missing agent binary', () => {
  test('the shell error is a failure, in either order the shells print it', () => {
    assert.equal(verdict('claude', 'zsh: command not found: claude'), 'failed')
    assert.equal(verdict('codex', 'bash: codex: command not found'), 'failed')
    assert.equal(verdict('claude', 'env: claude: No such file or directory'), 'failed')
  })

  test('an agent quoting a build log is not a failed session', () => {
    // This one has to be tight: `failed` is the badge that says the session is
    // over, and an agent reading somebody's CI output says these words often.
    assert.equal(
      verdict('claude', 'The log shows: command not found: pnpm, which is why the build broke'),
      null
    )
    assert.equal(verdict('claude', 'Their README warns that claude: command not found means…'), null)
  })
})

describe('reaching installs that already exist', () => {
  /** A document from before the pre-session rules shipped. */
  function legacyDoc(triggers) {
    return {
      version: 2,
      prefs: { fontSize: 13, triggers },
      sessions: [],
      descriptors: [],
      tabs: [],
      activeTabId: null
    }
  }

  const legacyIds = ['codex-approval', 'codex-question', 'codex-trust', 'shell-sudo', 'generic-error']
  const legacyRules = legacyIds.map((id) => ({
    id,
    name: id,
    pattern: 'x',
    flags: '',
    agent: 'any',
    action: 'waiting',
    captureReason: true,
    enabled: true
  }))

  test('a new rule arrives at an install that predates it', () => {
    const { data } = migrate(legacyDoc(legacyRules))
    const ids = data.prefs.triggers.map((t) => t.id)
    assert.ok(ids.includes('claude-trust'), 'the new rule was back-filled')
    assert.ok(ids.includes('agent-missing'))
    assert.equal(ids.length, DEFAULT_TRIGGERS.length)
  })

  test('a rule the user edited is left exactly as they edited it', () => {
    const edited = legacyRules.map((r) =>
      r.id === 'codex-trust' ? { ...r, pattern: 'MY OWN PATTERN', enabled: false } : r
    )
    const { data } = migrate(legacyDoc(edited))
    const trust = data.prefs.triggers.find((t) => t.id === 'codex-trust')
    assert.equal(trust.pattern, 'MY OWN PATTERN')
    assert.equal(trust.enabled, false)
  })

  test('a rule the user deleted is not resurrected', () => {
    // The whole reason the bookkeeping exists: "you deleted this" and "you
    // installed before this existed" look identical without it.
    const withoutTrust = legacyRules.filter((r) => r.id !== 'codex-trust')
    const { data } = migrate(legacyDoc(withoutTrust))
    const ids = data.prefs.triggers.map((t) => t.id)
    assert.equal(ids.includes('codex-trust'), false)
    assert.ok(ids.includes('claude-trust'), 'a genuinely new rule still arrives')
  })

  test('the back-fill happens once, not on every launch', () => {
    const first = migrate(legacyDoc(legacyRules)).data
    // The user then deletes one of the newly arrived rules.
    const pruned = {
      ...legacyDoc(first.prefs.triggers.filter((t) => t.id !== 'claude-login')),
      prefs: {
        ...first.prefs,
        triggers: first.prefs.triggers.filter((t) => t.id !== 'claude-login')
      }
    }
    const second = migrate(pruned).data
    assert.equal(
      second.prefs.triggers.some((t) => t.id === 'claude-login'),
      false,
      'a rule deleted after it arrived stays deleted'
    )
  })

  test('every shipped id is recorded as offered', () => {
    const { data } = migrate(legacyDoc(legacyRules))
    for (const rule of DEFAULT_TRIGGERS) {
      assert.ok(data.prefs.knownTriggerIds.includes(rule.id), `${rule.id} was not recorded`)
    }
  })

  test('a fresh install starts with every rule and every id recorded', () => {
    const { data } = migrate({})
    assert.equal(data.prefs.triggers.length, DEFAULT_TRIGGERS.length)
    assert.deepEqual(
      [...data.prefs.knownTriggerIds].sort(),
      DEFAULT_TRIGGERS.map((t) => t.id).sort()
    )
  })

  test('the renderer cannot rewrite what the install has been offered', () => {
    // Writable from the UI, this would let a bad patch resurrect deleted rules
    // or suppress every future one.
    const patch = asPrefsPatch({ knownTriggerIds: [], fontSize: 14 })
    assert.equal('knownTriggerIds' in patch, false)
    assert.equal(patch.fontSize, 14)
  })
})
