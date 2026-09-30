import { toHostPath, toNativePath } from '../src/main/host.js'
/**
 * Trust pre-seeding.
 *
 * Both CLIs refuse to start in a directory until its trust record exists, and
 * Workbench launches into a fresh worktree almost every time — so getting this
 * wrong means every Claude/Codex session either stalls on the dialog or, for
 * Claude, is killed by the Enter the prompt automation sends. These tests pin
 * the exact record each CLI reads, that we never clobber a decision already
 * made, and that a re-seed of an already-trusted dir writes nothing.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  ensureAgentTrust,
  ensureClaudeTrust,
  ensureCodexTrust,
  trustCwds
} from '../src/main/trust.js'
import { tempDir } from './helpers.mjs'

const readClaude = (home) =>
  JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))
const readCodex = (home) => fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')

describe('Claude trust', () => {
  test('creates ~/.claude.json with the folder accepted when none exists', () => {
    const home = tempDir('trust-claude-')
    ensureClaudeTrust(home, '/some/project')
    const doc = readClaude(home)
    assert.equal(doc.projects['/some/project'].hasTrustDialogAccepted, true)
    // A fresh entry carries the arrays Claude always expects to read back.
    assert.deepEqual(doc.projects['/some/project'].allowedTools, [])
    assert.deepEqual(doc.projects['/some/project'].history, [])
  })

  test('adds the folder without disturbing existing projects or top-level keys', () => {
    const home = tempDir('trust-claude-')
    const file = path.join(home, '.claude.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        numStartups: 7,
        projects: {
          '/other': { hasTrustDialogAccepted: true, allowedTools: ['Bash'], custom: 1 }
        }
      })
    )
    ensureClaudeTrust(home, '/new/project')
    const doc = readClaude(home)
    assert.equal(doc.numStartups, 7)
    assert.equal(doc.projects['/other'].custom, 1)
    assert.deepEqual(doc.projects['/other'].allowedTools, ['Bash'])
    assert.equal(doc.projects['/new/project'].hasTrustDialogAccepted, true)
  })

  test('an already-accepted folder is left byte-for-byte untouched', () => {
    const home = tempDir('trust-claude-')
    ensureClaudeTrust(home, '/p')
    const before = fs.readFileSync(path.join(home, '.claude.json'), 'utf8')
    ensureClaudeTrust(home, '/p')
    const after = fs.readFileSync(path.join(home, '.claude.json'), 'utf8')
    assert.equal(after, before)
  })

  test('a corrupt file is replaced rather than throwing', () => {
    const home = tempDir('trust-claude-')
    fs.writeFileSync(path.join(home, '.claude.json'), '{ this is not json')
    ensureClaudeTrust(home, '/p')
    assert.equal(readClaude(home).projects['/p'].hasTrustDialogAccepted, true)
  })
})

describe('Codex trust', () => {
  test('creates config.toml with a trusted block when none exists', () => {
    const home = tempDir('trust-codex-')
    ensureCodexTrust(home, '/some/project')
    const toml = readCodex(home)
    assert.match(toml, /\[projects\."\/some\/project"\]\ntrust_level = "trusted"/)
  })

  test('appends to an existing config without touching what is there', () => {
    const home = tempDir('trust-codex-')
    const file = path.join(home, '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'model = "gpt-5"\n\n[projects."/old"]\ntrust_level = "trusted"\n')
    ensureCodexTrust(home, '/new')
    const toml = readCodex(home)
    assert.match(toml, /model = "gpt-5"/)
    assert.match(toml, /\[projects\."\/old"\]/)
    assert.match(toml, /\[projects\."\/new"\]\ntrust_level = "trusted"/)
  })

  test('does not add a second block for a path already present', () => {
    const home = tempDir('trust-codex-')
    ensureCodexTrust(home, '/p')
    ensureCodexTrust(home, '/p')
    const toml = readCodex(home)
    assert.equal((toml.match(/\[projects\."\/p"\]/g) || []).length, 1)
  })

  test('leaves an existing decision alone even if it is not "trusted"', () => {
    const home = tempDir('trust-codex-')
    const file = path.join(home, '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '[projects."/p"]\ntrust_level = "untrusted"\n')
    ensureCodexTrust(home, '/p')
    const toml = readCodex(home)
    assert.match(toml, /trust_level = "untrusted"/)
    assert.doesNotMatch(toml, /trust_level = "trusted"/)
  })

  test('quotes a path containing a quote as a valid TOML string', () => {
    const home = tempDir('trust-codex-')
    ensureCodexTrust(home, '/we"ird')
    const toml = readCodex(home)
    assert.match(toml, /\[projects\."\/we\\"ird"\]/)
  })

  // Codex refuses to start at all on a repeated table header — `duplicate key`,
  // exit 1, every pane in the app dead — and an older build of trust.ts wrote
  // one whenever two spellings of a directory normalised onto the same host
  // path. Nothing but this app is going to notice, so seeding also repairs.
  test('collapses a duplicate trust block an older build left behind', () => {
    const home = tempDir('trust-codex-')
    const file = path.join(home, '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      'model = "gpt-5"\n\n[projects."/a"]\ntrust_level = "trusted"\n\n' +
        '[projects."/dup"]\ntrust_level = "trusted"\n\n' +
        '[projects."/dup"]\ntrust_level = "trusted"\n'
    )
    ensureCodexTrust(home, '/new')
    const toml = readCodex(home)
    assert.equal((toml.match(/\[projects\."\/dup"\]/g) || []).length, 1)
    // The repair is not licence to lose anything else in the file.
    assert.match(toml, /model = "gpt-5"/)
    assert.match(toml, /\[projects\."\/a"\]/)
    assert.match(toml, /\[projects\."\/new"\]\ntrust_level = "trusted"/)
  })

  test('repairs a duplicate even when there is nothing new to seed', () => {
    const home = tempDir('trust-codex-')
    const file = path.join(home, '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '[projects."/p"]\ntrust_level = "trusted"\n\n[projects."/p"]\ntrust_level = "trusted"\n')
    ensureCodexTrust(home, '/p')
    const toml = readCodex(home)
    assert.equal((toml.match(/\[projects\."\/p"\]/g) || []).length, 1)
    assert.equal(toml.endsWith('\n'), true)
  })

  // A block with keys we never write is the user's, and a parse error they can
  // read beats settings we deleted behind their back.
  test('leaves a duplicate block carrying other settings alone', () => {
    const home = tempDir('trust-codex-')
    const file = path.join(home, '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      '[projects."/p"]\ntrust_level = "trusted"\n\n[projects."/p"]\napproval_policy = "never"\n'
    )
    ensureCodexTrust(home, '/p')
    const toml = readCodex(home)
    assert.equal((toml.match(/\[projects\."\/p"\]/g) || []).length, 2)
    assert.match(toml, /approval_policy = "never"/)
  })

  test('a healthy config is left byte-for-byte untouched', () => {
    const home = tempDir('trust-codex-')
    ensureCodexTrust(home, '/p')
    const before = readCodex(home)
    ensureCodexTrust(home, '/p')
    assert.equal(readCodex(home), before)
  })
})

describe('trustCwds', () => {
  test('a real directory is seeded under both the raw and the resolved path', () => {
    // macOS resolves /tmp → /private/tmp; use a real temp dir so realpath runs.
    const dir = tempDir('trust-real-')
    const keys = trustCwds(dir)
    assert.ok(keys.includes(toHostPath(dir)))
    const real = fs.realpathSync(dir)
    assert.ok(keys.includes(toHostPath(real)))
  })

  test('a non-existent directory falls back to the raw path only', () => {
    const keys = trustCwds('/no/such/dir/anywhere')
    assert.deepEqual(keys, ['/no/such/dir/anywhere'])
  })

  // Two keys that are one host path make the Codex writer emit the same table
  // header twice, which costs the user every Codex session until they edit the
  // file by hand. Whatever the spellings, the list has to come back unique.
  test('never returns the same host path twice', () => {
    const dir = tempDir('trust-dedupe-')
    for (const spelling of [dir, `${dir}/`, fs.realpathSync(dir)]) {
      const keys = trustCwds(spelling)
      assert.equal(new Set(keys).size, keys.length)
    }
  })
})

describe('ensureAgentTrust dispatch', () => {
  test('routes claude and codex to their own config files', () => {
    const home = tempDir('trust-dispatch-')
    ensureAgentTrust('claude', home, '/x')
    ensureAgentTrust('codex', home, '/x')
    assert.equal(readClaude(home).projects['/x'].hasTrustDialogAccepted, true)
    assert.match(readCodex(home), /\[projects\."\/x"\]/)
  })
})
