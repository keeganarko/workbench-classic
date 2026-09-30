import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readSessionNaming } from '../src/main/sessionNaming.js'
import { toHostPath } from '../src/main/host.js'
import { tempDir } from './helpers.mjs'

const claude = (role, text, extra = {}) => ({ type: role, message: { role, content: [{ type: 'text', text }] }, ...extra })
const codex = (role, text, channel) => ({ type: 'response_item', payload: { type: 'message', role, channel, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } })

for (const [name, message] of [['Claude', claude], ['Codex', codex]]) {
  test(`${name} migration recovers actual conversation text from a large transcript`, () => {
    const file = path.join(tempDir('workbench-naming-'), 'conversation.jsonl')
    const rows = [message('user', 'Review my retirement savings'), message('assistant', 'Reviewed savings'),
      { type: 'tool_result', content: 'noise'.repeat(100000) },
      message('user', 'Find recurring charges'), message('assistant', 'Found three recurring charges'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Private reasoning' }, { type: 'tool_use', name: 'private tool' }] } },
      codex('assistant', 'Private analysis', 'analysis'), claude('user', 'Internal metadata', { isMeta: true })]
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n{"partial":')
    assert.deepEqual(readSessionNaming(file), { firstPrompt: 'Review my retirement savings', lastPrompt: 'Find recurring charges', lastReply: 'Found three recurring charges' })
    assert.deepEqual(readSessionNaming(toHostPath(file)), readSessionNaming(file), 'a hook path and native path refer to the same conversation')
  })
}

test('a newer user task clears the earlier answer, and missing transcripts are harmless', () => {
  const dir = tempDir('workbench-naming-'), file = path.join(dir, 'conversation.jsonl')
  fs.writeFileSync(file, [claude('user', '<environment_context>Do not name this</environment_context>'),
    claude('user', 'Review spending'), claude('assistant', 'Reviewed spending'), claude('user', 'Plan retirement')].map((r) => JSON.stringify(r)).join('\n'))
  assert.deepEqual(readSessionNaming(file), { firstPrompt: 'Review spending', lastPrompt: 'Plan retirement', lastReply: null })
  assert.deepEqual(readSessionNaming(path.join(dir, 'missing')), { firstPrompt: null, lastPrompt: null, lastReply: null })
})

test('repeating the same user request still clears the previous turn reply', () => {
  const file = path.join(tempDir('workbench-repeated-prompt-'), 'conversation.jsonl')
  fs.writeFileSync(file, [claude('user', 'Review the code'), claude('assistant', 'The previous code passed.'),
    claude('user', 'Review the code')].map(row => JSON.stringify(row)).join('\n'))
  assert.equal(readSessionNaming(file).lastReply, null)
})
