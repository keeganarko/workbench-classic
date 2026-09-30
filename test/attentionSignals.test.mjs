import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finalHumanRequest, hasActiveCodexDialog, isAgentRelayPrompt, isDefaultCodexDialogTrigger, isLegacyProseReason, isLegacyProseTrigger } from '../src/shared/attentionSignals.js'
import { DEFAULT_TRIGGERS } from '../src/main/store.js'

test('the final direct human request is retained as an actionable reason', () => {
  for (const request of ['Please confirm which option.', 'Which option should I use?',
    'Which branch should I use, `main` or `release`?', 'Are you ready for me to deploy?',
    'can you provide the missing account name?', 'Should I keep the existing configuration?']) {
    assert.equal(finalHumanRequest(`The implementation is prepared.\n\n${request}`), request)
  }
})

test('terminal approval fallback requires a current question or dialog controls', () => {
  for (const text of ['Allow command npm test? [y/n]',
    'Do you trust the files in this directory?\n› 1. Yes, proceed\n  2. No, exit',
    'Do you want to proceed?\n  1. Yes, proceed\n  2. No, cancel\nenter to confirm | esc to cancel']) {
    assert.equal(hasActiveCodexDialog(text), true, text)
    assert.equal(hasActiveCodexDialog(text + '\nTool completed.\n› Next prompt'), false)
  }
  for (const text of ['The old prompt used [y/n].', 'The option is Yes, proceed.',
    'Test case: Allow command npm test? [y/n]', '> Allow command npm test? [y/n]',
    '```text\nAllow command npm test? [y/n]\n```']) assert.equal(hasActiveCodexDialog(text), false)
  const shipped = DEFAULT_TRIGGERS.find(rule => rule.id === 'codex-approval')
  assert.equal(isDefaultCodexDialogTrigger(shipped), true)
  assert.equal(isDefaultCodexDialogTrigger({ ...shipped, pattern: 'CUSTOM APPROVAL' }), false)
})

test('reports, optional offers, quoted dialogs and relay replies do not ask the human to unblock work', () => {
  for (const message of ['Updated all agents. The old dialog said "Would you like to proceed?"; it is now resolved.',
    'Posted the relay reply: Please confirm the design with the integration lead. All my work is complete.',
    'The prompt contains [y/n]. Tests pass.', 'Would you like me to add another feature?',
    'All done.\n\n> Please confirm which option.', 'All done.\n\n```text\nPlease confirm which option.\n```',
    'This test covers "Which option should I use?"', 'Please confirm which option.\n\nVerified the result.',
    'Which option should I use?\n\n```text\nExample output\n```']) {
    assert.equal(finalHumanRequest(message), null, message)
  }
  assert.equal(finalHumanRequest('Please confirm which option.', true), null)
  assert.equal(finalHumanRequest(null), null)
  assert.equal(finalHumanRequest('Please confirm ' + 'x'.repeat(900)), null)
})

test('relay provenance and old trigger fragments have narrow recognizable shapes', () => {
  assert.equal(isAgentRelayPrompt('[relay from the "Lead" session] Handing this to you.'), true)
  assert.equal(isAgentRelayPrompt('Discuss the relay from the lead.'), false)
  assert.equal(isLegacyProseReason('Please choose'), true)
  assert.equal(isLegacyProseReason('Please confirm'), true)
  assert.equal(isLegacyProseReason('Please confirm which option.'), false)
  assert.equal(isLegacyProseReason('Codex needs approval'), false)
  const old = DEFAULT_TRIGGERS.find(rule => rule.id === 'codex-question')
  assert.equal(isLegacyProseTrigger(old), true)
  assert.equal(isLegacyProseTrigger({ ...old, pattern: 'MY EXPLICIT SIGNAL' }), false)
})
