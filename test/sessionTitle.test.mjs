import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { autoSessionTitle, contextSessionTitle, explicitSessionRole, purposeFromPrompt, sessionTaskSummary, SESSION_ROLES, sidebarSessionTitle } from '../src/shared/sessionTitle.js'

describe('automatic session titles', () => {
  test('a deliberately selected Central Coordinator role stays recognizable', () => {
    assert.equal(explicitSessionRole('Central Coordinator'), 'Central Coordinator')
    assert.equal(autoSessionTitle('You are my Central Coordinator. Coordinate the software and finances.'), 'Central Coordinator')
  })
  test('uses a two-word job role without an agent suffix', () => {
    assert.equal(
      autoSessionTitle('Please fix the status engine race in the Codex hook.', 'Codex'),
      'Software Engineer'
    )
  })

  test('removes conversational boilerplate and clips at a word boundary', () => {
    assert.equal(
      purposeFromPrompt('Can you rearchitect how folders and projects work across both computers today'),
      'Rearchitect how folders and projects work across both computers'
    )
  })

  test('ignores an environment envelope', () => {
    assert.equal(
      autoSessionTitle(
        '<environment_context><cwd>/secret</cwd></environment_context> Review the authentication flow.',
        'Claude'
      ),
      'Security Analyst'
    )
  })

  test('an empty or context-only prompt has no title', () => {
    assert.equal(autoSessionTitle('  ', 'Claude'), null)
    assert.equal(autoSessionTitle('<environment_context>x</environment_context>', 'Claude'), null)
  })
})

describe('sidebar session titles', () => {
  const row = (title, extra = {}) => ({ title, agent: 'codex', cwd: '/home/me/Dev/workbench', ...extra })

  test('removes leading and trailing agent labels, including legacy punctuation', () => {
    for (const title of ['Codex. Fix the sidebar', 'Codex CLI · Fix the sidebar', 'Fix the sidebar · Codex CLI', 'Codex: Fix the sidebar']) {
      assert.equal(sidebarSessionTitle(row(title), 'Codex CLI'), 'Fix the sidebar')
    }
    assert.equal(sidebarSessionTitle(row('Review the layout · Claude', { agent: 'claude' }), 'Claude Code'), 'Review the layout')
  })

  test('hides folder decorations and uses a neutral name until the task is known', () => {
    assert.equal(sidebarSessionTitle(row('Codex CLI · workbench'), 'Codex CLI'), 'New session')
    assert.equal(sidebarSessionTitle(row('Codex · workbench · Fix the sidebar'), 'Codex CLI'), 'Fix the sidebar')
    assert.equal(sidebarSessionTitle(row('Fix the sidebar · /home/me/Dev/workbench · Codex'), 'Codex CLI'), 'Fix the sidebar')
    assert.equal(sidebarSessionTitle(row('Codex · workbench', { cwd: 'C:\\Users\\me\\Dev\\workbench' }), 'Codex CLI'), 'New session')
  })

  test('preserves agent and folder words that describe the actual work', () => {
    assert.equal(sidebarSessionTitle(row('Fix the Codex adapter · Codex'), 'Codex CLI'), 'Fix the Codex adapter')
    assert.equal(sidebarSessionTitle(row('Codex CLI compatibility'), 'Codex CLI'), 'Codex CLI compatibility')
    assert.equal(sidebarSessionTitle(row('Review workbench navigation'), 'Codex CLI'), 'Review workbench navigation')
    assert.equal(sidebarSessionTitle(row('Codex.js parser'), 'Codex CLI'), 'Codex.js parser')
  })

  test('handles custom profile labels literally and never renames the stored session', () => {
    const session = row('Agent++ · Review the build', { agent: 'agent-plus' })
    assert.equal(sidebarSessionTitle(session, 'Agent++'), 'Review the build')
    assert.equal(session.title, 'Agent++ · Review the build')
  })

  test('removes inherited agent decorations from forks without changing task arrows', () => {
    assert.equal(sidebarSessionTitle(row('Fix the sidebar · Codex CLI ↳ child', { forkKind: 'child' }), 'Codex CLI'), 'Fix the sidebar')
    assert.equal(sidebarSessionTitle(row('Fix the sidebar · Claude Code ↳ child → Codex CLI', { forkKind: 'handoff' }), 'Codex CLI'), 'Fix the sidebar')
    assert.equal(sidebarSessionTitle(row('Compare Claude → Codex', { forkKind: 'root' }), 'Codex CLI'), 'Compare Claude → Codex')
  })
})

test('roles follow work, ignore launch instructions and stay exactly two words', () => {
  for (const role of SESSION_ROLES) {
    assert.equal(role.split(' ').length, 2)
    assert.equal(explicitSessionRole(`You are my ${role}. Help me today.`), role)
  }
  assert.equal(autoSessionTitle('Review my spending and retirement savings'), 'Financial Advisor')
  assert.equal(autoSessionTitle('Fix the finance app scheduler'), 'Software Engineer')
  assert.equal(autoSessionTitle('Project instructions:\nYou are a Software Engineer.\n\nTask:\nReview my budget'), 'Financial Advisor')
  assert.equal(autoSessionTitle('# AGENTS.md instructions for /repo\n<INSTRUCTIONS>Write code.</INSTRUCTIONS>\nPlan a vacation'), 'Travel Planner')
  assert.equal(contextSessionTitle('custom-agent', 'Personal Finance', '/tmp'), 'Financial Advisor')
  assert.equal(contextSessionTitle('shell', 'Personal Finance', '/tmp'), 'Terminal Operator')
  assert.equal(contextSessionTitle('codex', '', 'C:\\Dev\\finance-app'), 'Financial Advisor')
})

test('recent work is readable, bounded and does not replace work with acknowledgments', () => {
  assert.equal(purposeFromPrompt('Thanks!'), null)
  assert.equal(purposeFromPrompt('Can you **review my budget**? Then suggest changes.', 140, 20), 'Review my budget')
  assert.equal(purposeFromPrompt('Built the scheduled task editor. Tests pass.', 140, 20), 'Built the scheduled task editor')
  assert.equal(sessionTaskSummary({ lastTask: null }), 'No task summary yet.')
  const long = purposeFromPrompt('Updated ' + 'implementation '.repeat(50), 140, 20)
  assert.ok(long.length <= 140)
  assert.ok(!long.includes('…'))
})
