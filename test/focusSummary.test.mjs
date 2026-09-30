import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { relayEnvelope, relayPreamble } from '../src/shared/relay.js'
import { autoSessionTitle, purposeFromPrompt, taskText } from '../src/shared/sessionTitle.js'
import { SessionManager } from '../src/main/sessions.js'
import { readSessionNaming } from '../src/main/sessionNaming.js'
import { tempDir } from './helpers.mjs'

const notification = `<task-notification>
<task-id>background-check-1</task-id>
<tool-use-id>toolu_example_only</tool-use-id>
<output-file>/tmp/example/tasks/background-check-1.output</output-file>
<status>completed</status>
<summary>Background command completed (exit code 0)</summary>
</task-notification>`

test('Focus task summaries use the actual message from either generated relay banner', () => {
  for (const from of [null, 'Project Manager', 'Lead [design] "review"']) {
    for (const wait of [false, true]) {
      const prompt = relayEnvelope(from, 'Please review the sidebar layout. Then check mobile sizes.', wait)
      assert.equal(purposeFromPrompt(prompt, 140, 20), 'Review the sidebar layout')
      assert.equal(purposeFromPrompt(prompt.replace(/\n/g, '\r\n'), 140, 20), 'Review the sidebar layout')
      assert.equal(autoSessionTitle(prompt), 'Research Analyst', 'the sender role is not the recipient role')
    }
  }
})

test('relay banners, empty relays and acknowledgments carry no new work', () => {
  for (const wait of [false, true]) {
    assert.equal(purposeFromPrompt(relayEnvelope('Lead', '', wait)), null)
    assert.equal(purposeFromPrompt(relayEnvelope('Lead', 'Thanks!', wait)), null)
    assert.equal(purposeFromPrompt(relayPreamble('Lead', wait).slice(0, 65)), null)
  }
  assert.equal(purposeFromPrompt('[relay from the "Lead" session] Handing this to you'), null)
})

test('machine task notifications and output retrieval instructions carry no new work', () => {
  assert.equal(purposeFromPrompt(notification), null)
  assert.equal(autoSessionTitle(notification), null)
  assert.equal(purposeFromPrompt(`${notification}\nRead the output file to retrieve the result: /tmp/example/tasks/check.output`), null)
  assert.equal(purposeFromPrompt(notification.slice(0, 110)), null, 'legacy saved metadata fragments stay out of cards')
  assert.equal(purposeFromPrompt(relayEnvelope('Lead', notification, false)), null)
})

test('real requests after notification metadata still provide a summary', () => {
  assert.equal(purposeFromPrompt(`${notification}\n\nPlease review the authentication flow.`, 140, 20), 'Review the authentication flow')
  assert.equal(purposeFromPrompt(`${notification}\n${notification}\nReview the mobile layout.`, 140, 20), 'Review the mobile layout')
  assert.equal(purposeFromPrompt(`${notification.toUpperCase()}\nReview the mobile layout.`, 140, 20), 'Review the mobile layout')
})

test('launch context can wrap a relay or a machine notification', () => {
  const context = 'Project instructions:\nYou are a Project Manager.\n\nTask:\n'
  assert.equal(purposeFromPrompt(context + relayEnvelope('Lead', 'Review the mobile layout.', true), 140, 20), 'Review the mobile layout')
  assert.equal(purposeFromPrompt(context + notification), null)
  assert.equal(purposeFromPrompt('<environment_context>shell context</environment_context>\n' + notification), null)
})

test('human markup requests and descriptions of protocol text remain readable', () => {
  for (const prompt of [
    'Explain <task-notification> tags in the transcript parser',
    'Render <section>Release notes</section> in the preview',
    '<task-notification>Please design a notification card</task-notification>',
    '[relay from the "Lead" session] is the example header to document'
  ]) assert.equal(taskText(prompt), prompt)
  assert.equal(purposeFromPrompt('Can you **review the [layout](docs/layout.md)**?', 140, 20), 'Review the layout')
  assert.equal(purposeFromPrompt('Explain `[relay from the "Lead" session] Handing this to you`', 140, 20),
    'Explain [relay from the "Lead" session] Handing this to you')
})

test('prompt ingestion retains the previous useful summary for machine-only input', () => {
  const session = { agent: 'claude', title: 'Software Engineer', titleMode: 'auto', titleSource: 'prompt',
    lastTask: 'Built the Focus card layout' }
  for (const prompt of [notification, relayEnvelope('Project Manager', notification, true), relayEnvelope('Lead', 'Thanks!', false)]) {
    assert.equal(SessionManager.prototype.maybeAutoTitle.call(null, session, prompt), false)
    assert.equal(session.lastTask, 'Built the Focus card layout')
    assert.equal(session.title, 'Software Engineer')
  }
  assert.equal(SessionManager.prototype.maybeAutoTitle.call(null, session,
    relayEnvelope('Project Manager', 'Review the Focus card layout.', false)), true)
  assert.equal(session.lastTask, 'Review the Focus card layout')
  assert.equal(session.title, 'Software Engineer')
})

test('transcript recovery keeps meaningful work across incidental task notifications', () => {
  const file = `${tempDir('focus-summary-')}/transcript.jsonl`
  fs.writeFileSync(file, [
    { role: 'user', content: relayEnvelope('Project Manager', 'Review the Focus card layout.', false) },
    { role: 'assistant', content: 'Built the Focus card layout. The tests pass.' },
    { role: 'user', content: notification },
    { role: 'assistant', content: notification }
  ].map(message => JSON.stringify({ message })).join('\n') + '\n')
  assert.deepEqual(readSessionNaming(file), {
    firstPrompt: 'Review the Focus card layout.',
    lastPrompt: 'Review the Focus card layout.',
    lastReply: 'Built the Focus card layout. The tests pass.'
  })
})
