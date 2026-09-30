/**
 * The context shelf, against a real shelf on a temp disk.
 *
 * Both directories the shelf touches are injected, so nothing here can reach
 * the user's own checkpoints or their `~/.claude/projects`.
 */

import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ContextShelf } from '../src/main/shelf.js'
import {
  isValidCheckpointName,
  projectSlug,
  toCheckpointName,
  clampNote,
  MAX_NOTE_CHARS
} from '../src/shared/shelf.js'

const roots = []
function freshShelf() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-test-'))
  roots.push(base)
  const shelf = new ContextShelf(path.join(base, 'ctx'), path.join(base, 'projects'))
  return { shelf, base }
}

/** Writes a transcript where the agent would have written it. */
function writeTranscript(base, cwd, sessionId, records) {
  const dir = path.join(base, 'projects', projectSlug(cwd))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  )
}

const CWD = '/Users/someone/Dev/thing'
const SID = '11111111-2222-3333-4444-555555555555'

function sampleRecords(cwd = CWD, sessionId = SID) {
  return [
    { type: 'user', cwd, sessionId, message: { content: 'design the bird API' } },
    { type: 'assistant', cwd, sessionId, message: { content: [{ type: 'text', text: 'ok' }] } },
    { type: 'user', cwd, sessionId, message: { content: '<system-reminder>ignored</system-reminder>' } },
    { type: 'user', cwd, sessionId, message: { content: [{ type: 'text', text: 'now add auth' }] } },
    { type: 'bridge-session', sessionId, ownerAccountUuid: 'SECRET-ACCOUNT-ID' }
  ]
}

after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

describe('names', () => {
  test('a plain name is valid', () => {
    assert.ok(isValidCheckpointName('bird-api'))
    assert.ok(isValidCheckpointName('v2.1_draft'))
  })

  test('anything that could climb out of the shelf is not', () => {
    for (const bad of ['../escape', 'a/b', '.hidden', '', 'x'.repeat(65), '/abs']) {
      assert.equal(isValidCheckpointName(bad), false, `${bad} should be rejected`)
    }
  })

  test('free text is turned into a name rather than refused', () => {
    assert.equal(toCheckpointName('Before the Refactor!'), 'before-the-refactor')
    assert.equal(toCheckpointName('  ///  '), toCheckpointName('  ///  '))
    assert.ok(isValidCheckpointName(toCheckpointName('  ///  ')))
  })

  test('a note is collapsed and capped', () => {
    assert.equal(clampNote('  two   words \n here '), 'two words here')
    assert.equal(clampNote('x'.repeat(500)).length, MAX_NOTE_CHARS)
    assert.equal(clampNote(undefined), '')
  })
})

describe('saving', () => {
  let shelf, base
  beforeEach(() => ({ shelf, base } = freshShelf()))

  test('a session with no transcript is a sentence, not a crash', () => {
    assert.throws(
      () => shelf.save({ name: 'x', cwd: CWD, agentSessionId: SID }),
      /send it a message first/
    )
  })

  test('saves, counts human turns, and keeps the first prompt', () => {
    writeTranscript(base, CWD, SID, sampleRecords())
    const meta = shelf.save({ name: 'bird-api', note: 'good start', cwd: CWD, agentSessionId: SID })
    assert.equal(meta.name, 'bird-api')
    assert.equal(meta.note, 'good start')
    // Two human turns: the tagged record is injected context, not something typed.
    assert.equal(meta.turns, 2)
    assert.equal(meta.firstPrompt, 'design the bird API')
    assert.equal(meta.originCwd, CWD)
  })

  test('the account id never reaches the shelf', () => {
    writeTranscript(base, CWD, SID, sampleRecords())
    shelf.save({ name: 'bird-api', cwd: CWD, agentSessionId: SID })
    const saved = fs.readFileSync(path.join(base, 'ctx', 'bird-api', 'transcript.jsonl'), 'utf8')
    assert.ok(!saved.includes('SECRET-ACCOUNT-ID'))
    assert.ok(!saved.includes('bridge-session'))
    assert.ok(saved.includes('design the bird API'))
  })

  test('a name that would escape the shelf is refused', () => {
    writeTranscript(base, CWD, SID, sampleRecords())
    assert.throws(
      () => shelf.save({ name: '../../escape', cwd: CWD, agentSessionId: SID }),
      /not a usable checkpoint name/
    )
  })

  test('listing is newest first', () => {
    writeTranscript(base, CWD, SID, sampleRecords())
    shelf.save({ name: 'older', cwd: CWD, agentSessionId: SID })
    shelf.save({ name: 'newer', cwd: CWD, agentSessionId: SID })
    const names = shelf.list().map((c) => c.name)
    assert.deepEqual(new Set(names), new Set(['older', 'newer']))
    assert.equal(shelf.list().length, 2)
  })
})

describe('opening', () => {
  let shelf, base
  beforeEach(() => {
    ;({ shelf, base } = freshShelf())
    writeTranscript(base, CWD, SID, sampleRecords())
    shelf.save({ name: 'bird-api', cwd: CWD, agentSessionId: SID })
  })

  test('every open mints a new id, so the checkpoint is never the live session', () => {
    const a = shelf.fork('bird-api', '/Users/other/checkout')
    const b = shelf.fork('bird-api', '/Users/other/checkout')
    assert.notEqual(a, b)
    assert.notEqual(a, SID)
  })

  test('the transcript is re-pointed at the directory it is opened in', () => {
    const target = '/Users/other/checkout'
    const id = shelf.fork('bird-api', target)
    const installed = path.join(base, 'projects', projectSlug(target), `${id}.jsonl`)
    const lines = fs.readFileSync(installed, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(lines.length > 0)
    for (const rec of lines) {
      if (rec.cwd) assert.equal(rec.cwd, target)
      if (rec.sessionId) assert.equal(rec.sessionId, id)
    }
  })

  test('the saved copy is untouched by opening it', () => {
    const before = fs.readFileSync(path.join(base, 'ctx', 'bird-api', 'transcript.jsonl'), 'utf8')
    shelf.fork('bird-api', '/somewhere/else')
    const after = fs.readFileSync(path.join(base, 'ctx', 'bird-api', 'transcript.jsonl'), 'utf8')
    assert.equal(before, after)
  })

  test('opening something that is gone says so', () => {
    assert.throws(() => shelf.fork('nope', CWD), /No checkpoint named/)
  })
})

describe('handing one over', () => {
  let shelf, base
  beforeEach(() => {
    ;({ shelf, base } = freshShelf())
    writeTranscript(base, CWD, SID, sampleRecords())
    shelf.save({ name: 'bird-api', note: 'good start', cwd: CWD, agentSessionId: SID })
  })

  test('the label and the note travel with the transcript', () => {
    const out = path.join(base, 'bundle.jsonl')
    shelf.exportBundle('bird-api', out)
    const first = JSON.parse(fs.readFileSync(out, 'utf8').split('\n')[0])
    assert.equal(first.type, 'ctx-manifest')
    assert.equal(first.name, 'bird-api')
    assert.equal(first.note, 'good start')
  })

  test('a bundle lands on someone else&apos;s shelf with its name intact', () => {
    const out = path.join(base, 'bundle.jsonl')
    shelf.exportBundle('bird-api', out)

    const theirs = freshShelf().shelf
    const added = theirs.importBundle(out)
    assert.equal(added.name, 'bird-api')
    assert.equal(added.note, 'good start')
    assert.equal(added.turns, 2)
    assert.equal(added.firstPrompt, 'design the bird API')
    assert.deepEqual(theirs.list().map((c) => c.name), ['bird-api'])
  })

  test('an imported checkpoint can be opened like any other', () => {
    const out = path.join(base, 'bundle.jsonl')
    shelf.exportBundle('bird-api', out)
    const { shelf: theirs, base: theirBase } = freshShelf()
    theirs.importBundle(out)
    const target = '/Users/them/their-checkout'
    const id = theirs.fork('bird-api', target)
    const installed = path.join(theirBase, 'projects', projectSlug(target), `${id}.jsonl`)
    assert.ok(fs.existsSync(installed))
  })

  test('a file that is not a transcript is refused', () => {
    const junk = path.join(base, 'junk.jsonl')
    fs.writeFileSync(junk, JSON.stringify({ hello: 'world' }) + '\n')
    assert.throws(() => shelf.importBundle(junk), /not a transcript/)
  })

  test('an empty file is refused', () => {
    const empty = path.join(base, 'empty.jsonl')
    fs.writeFileSync(empty, '')
    assert.throws(() => shelf.importBundle(empty), /Nothing readable/)
  })

  test('a bundle claiming an escaping name is refused', () => {
    const out = path.join(base, 'evil.jsonl')
    fs.writeFileSync(
      out,
      [
        JSON.stringify({ type: 'ctx-manifest', name: '../../../escape' }),
        JSON.stringify({ type: 'user', cwd: CWD, sessionId: SID, message: { content: 'hi' } })
      ].join('\n') + '\n'
    )
    assert.throws(() => shelf.importBundle(out), /unusable name/)
  })
})

describe('removing', () => {
  test('removes one and leaves the rest', () => {
    const { shelf, base } = freshShelf()
    writeTranscript(base, CWD, SID, sampleRecords())
    shelf.save({ name: 'keep', cwd: CWD, agentSessionId: SID })
    shelf.save({ name: 'drop', cwd: CWD, agentSessionId: SID })
    shelf.remove('drop')
    assert.deepEqual(shelf.list().map((c) => c.name), ['keep'])
    assert.equal(shelf.get('drop'), null)
  })
})

describe('collisions', () => {
  test('saving the same name twice keeps both, never overwrites', () => {
    const { shelf, base } = freshShelf()
    const a = '11111111-1111-1111-1111-111111111111'
    const b = '22222222-2222-2222-2222-222222222222'
    writeTranscript(base, CWD, a, [
      { type: 'user', cwd: CWD, sessionId: a, message: { content: 'FIRST POINT' } }
    ])
    writeTranscript(base, CWD, b, [
      { type: 'user', cwd: CWD, sessionId: b, message: { content: 'SECOND POINT' } }
    ])

    const first = shelf.save({ name: 'trunk', cwd: CWD, agentSessionId: a })
    const second = shelf.save({ name: 'trunk', cwd: CWD, agentSessionId: b })

    assert.equal(first.name, 'trunk')
    assert.equal(second.name, 'trunk-2')
    assert.deepEqual(
      shelf.list().map((c) => c.name).sort(),
      ['trunk', 'trunk-2']
    )
    // The point of the whole feature: the first save still says what it said.
    assert.equal(shelf.get('trunk').firstPrompt, 'FIRST POINT')
    assert.equal(shelf.get('trunk-2').firstPrompt, 'SECOND POINT')
  })
})
