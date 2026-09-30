import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { lastAssistantMessage, transcriptToMarkdown } from '../src/main/agents.js'
import { tempDir } from './helpers.mjs'

const record = (role, text) => JSON.stringify({ type: 'response_item', payload: {
  type: 'message', role, content: [{ type: 'output_text', text }]
} })
const transcript = (text) => {
  const file = path.join(tempDir('transcript-memory-'), 'rollout.jsonl')
  fs.writeFileSync(file, text)
  return file
}

test('relay retains a complete answer across many chunks and UTF-8 boundaries', () => {
  const answer = 'é🧠漢字'.repeat(40000) + '\nFinal finding: preserve the whole handoff.'
  const file = transcript([record('user', 'Review this'), record('assistant', answer),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] } }),
    '{unfinished', ''].join('\r\n'))
  assert.equal(lastAssistantMessage(file), answer)
})

test('exports keep the exact old tail, marker, ordering and separator semantics', () => {
  const first = '### user\nQuestion 🧠'
  const last = '### assistant\nAnswer é\nSecond line'
  const expected = `${first}\n\n${last}`
  const file = transcript([record('user', 'Question 🧠'), '{bad JSON}',
    JSON.stringify({ type: 'summary', message: { content: 'not a turn' } }),
    record('assistant', 'Answer é\nSecond line')].join('\n'))
  for (const limit of [0, 1, 10, last.length, expected.length - 1, expected.length, 60000]) {
    assert.equal(transcriptToMarkdown(file, limit), expected.length > limit
      ? `…(earlier turns trimmed)…\n\n${expected.slice(expected.length - limit)}` : expected)
  }
})

test('exactly-full final turn distinguishes absent, ignored and rendered older turns', () => {
  const rendered = '### assistant\nComplete answer'
  for (const prefix of ['', '{malformed}\n', JSON.stringify({ type: 'system' }) + '\n']) {
    assert.equal(transcriptToMarkdown(transcript(prefix + record('assistant', 'Complete answer')), rendered.length), rendered)
  }
  const file = transcript(record('user', 'Older question') + '\n' + record('assistant', 'Complete answer'))
  assert.equal(transcriptToMarkdown(file, rendered.length), `…(earlier turns trimmed)…\n\n${rendered}`)
})

test('relay skips trailing tool results and preserves Claude prose', () => {
  const file = transcript([
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Claude answer' }] } }),
    JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', content: 'tool output' }] } })
  ].join('\n'))
  assert.equal(lastAssistantMessage(file), 'Claude answer')
})

test('short replies do not read old megabytes and release their file descriptor', (t) => {
  const file = transcript('')
  const fd = fs.openSync(file, 'w')
  fs.writeSync(fd, '\n' + record('assistant', 'The complete latest answer') + '\n', 16 * 1024 * 1024)
  fs.closeSync(fd)
  const readSync = fs.readSync
  const openSync = fs.openSync
  let bytes = 0, opened
  t.mock.method(fs, 'openSync', (...args) => { opened = openSync(...args); return opened })
  t.mock.method(fs, 'readSync', (...args) => { const read = readSync(...args); bytes += read; return read })
  assert.equal(lastAssistantMessage(file), 'The complete latest answer')
  assert.ok(bytes <= 65536, `Read ${bytes} bytes for a short final answer`)
  assert.throws(() => fs.fstatSync(opened), { code: 'EBADF' })
})

test('handoff stops before old history once its existing export limit is satisfied', (t) => {
  const answer = 'Keep this answer complete in the transcript. '.repeat(2200)
  const file = transcript('')
  const fd = fs.openSync(file, 'w')
  fs.writeSync(fd, '\n' + record('assistant', answer) + '\n', 16 * 1024 * 1024)
  fs.closeSync(fd)
  const readSync = fs.readSync
  let bytes = 0
  t.mock.method(fs, 'readSync', (...args) => { const read = readSync(...args); bytes += read; return read })
  const rendered = `### assistant\n${answer.trim()}`
  assert.equal(transcriptToMarkdown(file), `…(earlier turns trimmed)…\n\n${rendered.slice(-60000)}`)
  assert.ok(bytes < 200000, `Export read ${bytes} bytes from old history`)
})

test('partial file reads are completed without corrupting text', (t) => {
  const answer = 'A complete answer with 🧠 Unicode.'
  const file = transcript(record('assistant', answer))
  const readSync = fs.readSync
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) =>
    readSync(fd, buffer, offset, Math.min(7, length), position))
  assert.equal(lastAssistantMessage(file), answer)
})

test('missing, empty and interrupted records retain the existing empty result', () => {
  for (const file of [path.join(tempDir(), 'missing.jsonl'), transcript(''), transcript('{broken')]) {
    assert.equal(lastAssistantMessage(file), null)
    assert.equal(transcriptToMarkdown(file), '')
  }
})
