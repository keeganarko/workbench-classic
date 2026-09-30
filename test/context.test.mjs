/**
 * Reading context usage out of a CLI's own transcript.
 *
 * The line shapes below are trimmed from real files on disk — a Claude
 * `~/.claude/projects/**\/*.jsonl` and a Codex `~/.codex/sessions/**\/*.jsonl`
 * — rather than invented, because the whole feature is a claim about what those
 * two formats contain. The parts that matter are kept verbatim.
 *
 * The load-bearing rule, and the reason this is worth pinning: a percentage is
 * only ever shown when the transcript itself named a ceiling. Nothing here may
 * infer a window size from a model name.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { claudeContext, codexContext, formatTokens, percentLeft } from '../src/shared/context.js'
import { createContextReader } from '../src/main/context.js'
import { tempDir } from './helpers.mjs'

const claudeTurn = (usage, extra = {}) =>
  JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage }, ...extra })

const claudeBoundary = (preTokens, postTokens) =>
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: { trigger: 'auto', preTokens, postTokens }
  })

const codexCount = (total, window) =>
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: 419783 },
        last_token_usage: { input_tokens: 71977, output_tokens: 1748, total_tokens: total },
        ...(window === null ? {} : { model_context_window: window })
      }
    }
  })

describe('claude transcripts', () => {
  test('the last turn counts cache, uncached input and output together', () => {
    const lines = [
      claudeTurn({ input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 1 }),
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      claudeTurn({
        input_tokens: 2,
        cache_creation_input_tokens: 363,
        cache_read_input_tokens: 108273,
        output_tokens: 180
      })
    ]
    assert.deepEqual(claudeContext(lines), { tokens: 108818, limit: null })
  })

  test('no limit until the session has compacted once', () => {
    const lines = [claudeTurn({ input_tokens: 100, output_tokens: 10 })]
    assert.equal(claudeContext(lines).limit, null)
    assert.equal(percentLeft(claudeContext(lines)), null)
  })

  test('a compaction boundary is where the ceiling comes from', () => {
    const lines = [
      claudeTurn({ cache_read_input_tokens: 216_000, output_tokens: 705 }),
      claudeBoundary(216_705, 17_060),
      JSON.stringify({ type: 'user', isCompactSummary: true, message: { content: 'summary' } }),
      claudeTurn({ cache_read_input_tokens: 17_000, output_tokens: 60 })
    ]
    // Post-compaction the count restarts; the ceiling is what we learned on the
    // way here, and it stays.
    assert.deepEqual(claudeContext(lines), { tokens: 17_060, limit: 216_705 })
    assert.equal(percentLeft(claudeContext(lines)), 92)
  })

  test('the newest boundary wins when a session compacted twice', () => {
    const lines = [
      claudeBoundary(190_000, 12_000),
      claudeBoundary(216_705, 17_060),
      claudeTurn({ cache_read_input_tokens: 100, output_tokens: 8 })
    ]
    assert.equal(claudeContext(lines).limit, 216_705)
  })

  test('nothing to say about a transcript with no assistant turn yet', () => {
    assert.equal(claudeContext([JSON.stringify({ type: 'user', message: {} })]), null)
    assert.equal(claudeContext([]), null)
  })

  test('a half-written line is skipped, not thrown on', () => {
    const lines = [claudeTurn({ input_tokens: 40, output_tokens: 2 }), '{"type":"assis']
    assert.deepEqual(claudeContext(lines), { tokens: 42, limit: null })
  })
})

describe('codex transcripts', () => {
  test('the window is stated outright, so a percentage is available at once', () => {
    assert.deepEqual(codexContext([codexCount(73_725, 258_400)]), {
      tokens: 73_725,
      limit: 258_400
    })
    assert.equal(percentLeft(codexContext([codexCount(73_725, 258_400)])), 71)
  })

  test('the last request, not the session total', () => {
    // `total_token_usage` climbs past the window and never comes back down;
    // reading it would show a session as permanently over its limit.
    const usage = codexContext([codexCount(73_725, 258_400)])
    assert.notEqual(usage.tokens, 419_783)
  })

  test('an event with no window still gives a token count', () => {
    assert.deepEqual(codexContext([codexCount(1_000, null)]), { tokens: 1_000, limit: null })
  })

  test('a claude turn in a codex file is not mistaken for one', () => {
    assert.equal(codexContext([claudeTurn({ input_tokens: 10, output_tokens: 1 })]), null)
  })
})

describe('presentation', () => {
  test('percent left is clamped, never negative', () => {
    assert.equal(percentLeft({ tokens: 300, limit: 200 }), 0)
    assert.equal(percentLeft({ tokens: 0, limit: 200 }), 100)
    assert.equal(percentLeft(null), null)
    assert.equal(percentLeft({ tokens: 10, limit: null }), null)
  })

  test('tokens read in thousands', () => {
    assert.equal(formatTokens(999), '999')
    assert.equal(formatTokens(108_818), '109k')
  })
})

describe('reading the tail of a file', () => {
  test('answers from the end of a file far too big to read', () => {
    const dir = tempDir()
    const file = path.join(dir, 'session.jsonl')
    // A megabyte of history in front of the only line that matters.
    const filler = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } })}\n`
    fs.writeFileSync(file, filler.repeat(600) + claudeTurn({ input_tokens: 77 }) + '\n')
    assert.ok(fs.statSync(file).size > 1_000_000)

    const reader = createContextReader()
    assert.deepEqual(reader.read('claude', file), { tokens: 77, limit: null })
  })

  test('a file that has not changed is not read again', () => {
    const dir = tempDir()
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, claudeTurn({ input_tokens: 10 }) + '\n')

    const reader = createContextReader()
    assert.deepEqual(reader.read('claude', file), { tokens: 10, limit: null })

    // Deleting it and asking again returns the cached answer only if the stat
    // succeeds, so this proves the stat happens every time.
    fs.rmSync(file)
    assert.equal(reader.read('claude', file), null)
  })

  test('an append is picked up', () => {
    const dir = tempDir()
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, claudeTurn({ input_tokens: 10 }) + '\n')
    const reader = createContextReader()
    assert.equal(reader.read('claude', file).tokens, 10)

    fs.appendFileSync(file, claudeTurn({ input_tokens: 20 }) + '\n')
    assert.equal(reader.read('claude', file).tokens, 20)
  })

  test('a missing transcript is not an error', () => {
    const reader = createContextReader()
    assert.equal(reader.read('claude', path.join(tempDir(), 'nope.jsonl')), null)
  })

  test('an empty transcript is not an error', () => {
    const dir = tempDir()
    const file = path.join(dir, 'empty.jsonl')
    fs.writeFileSync(file, '')
    assert.equal(createContextReader().read('claude', file), null)
  })
})
