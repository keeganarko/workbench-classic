/**
 * Trust pre-seeding.
 *
 * Both CLIs gate the *first* launch in any working directory behind an
 * interactive "do you trust this folder?" prompt, recorded per absolute path in
 * the user's own config:
 *   Claude → ~/.claude.json        projects[<cwd>].hasTrustDialogAccepted
 *   Codex  → ~/.codex/config.toml  [projects."<cwd>"] trust_level = "trusted"
 *
 * Workbench creates a brand-new directory for almost every session — its
 * worktrees live under the app data dir and have never existed before — so that
 * dialog fires on essentially every agent launch, not just once. Left
 * unanswered the pane just sits on the dialog and never starts, so no hooks fire
 * and the session reads as idle forever. Worse, the "send the initial prompt"
 * automation types into the dialog: for Codex that silently swallows the prompt,
 * and for Claude the Enter it sends selects the dialog's *default* — "No, exit" —
 * which kills the session outright. That is the whole "creating a Claude/Codex
 * terminal doesn't work" symptom.
 *
 * Neither CLI exposes a per-invocation flag for this (verified against Claude
 * 2.1.x and Codex 0.153.x: --dangerously-skip-permissions,
 * --dangerously-bypass-approvals-and-sandbox and a `-c projects…trust_level`
 * override all still show the dialog). The record has to be written to the
 * config file itself, which is the one place Workbench touches the user's global
 * CLI config.
 *
 * It is deliberately conservative. It writes only when the record is missing or
 * when an earlier version of this file left Codex's config unparseable, writes
 * atomically so a concurrent CLI never reads a half-written file, preserves the
 * file's existing permissions, and never rewrites or downgrades a trust
 * decision the user already made by hand.
 */

import fs from 'node:fs'
import path from 'node:path'

import { toHostPath } from './host.js'

export type TrustableAgent = 'claude' | 'codex'

/**
 * The paths a CLI might key its trust record on for a launch in `cwd`.
 *
 * tmux does the chdir for us, and on macOS `getcwd()` resolves symlinks
 * (`/tmp` → `/private/tmp`), so the path the CLI actually records is the
 * realpath — not the string we handed to `-c`. Seed both when they differ so
 * the lookup hits whichever form the CLI uses.
 *
 * Takes a *native* cwd, because resolving the symlink is this process's job,
 * and returns *host* spellings, because the key is written by the CLI running
 * on the host. Both are the same string except on Windows, where the CLI lives
 * inside the distro and records `/home/…` for a directory this process knows
 * as `\\wsl.localhost\…`. Getting that backwards writes a record no CLI ever
 * looks up, and the trust dialog — which kills Claude sessions outright — comes
 * back.
 */
export function trustCwds(cwd: string): string[] {
  const out = [cwd]
  try {
    const real = fs.realpathSync(cwd)
    if (real !== cwd) out.push(real)
  } catch {
    // The directory may not exist yet; the raw form is the best we have.
  }
  // Two spellings can differ as strings and still be one directory on the host:
  // a project stored as `C:/Dev/x` realpaths to `C:\Dev\x`, and both map to
  // /mnt/c/Dev/x. Codex keys its record on that host path and rejects the whole
  // config file — `duplicate key`, every Codex pane dead on launch — if the
  // same table header appears twice, so collapse them here rather than handing
  // the writer below two keys it will faithfully write out as a broken file.
  return Array.from(new Set(out.map(toHostPath)))
}

/** Seeds the trust record for `cwd` in the config of whichever CLI we launch. */
export function ensureAgentTrust(agent: TrustableAgent, home: string, cwd: string): void {
  if (agent === 'claude') ensureClaudeTrust(home, cwd)
  else ensureCodexTrust(home, cwd)
}

/** Marks each candidate cwd trusted in `~/.claude.json`, if not already. */
export function ensureClaudeTrust(home: string, cwd: string): void {
  const file = path.join(home, '.claude.json')

  let doc: Record<string, unknown>
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    doc = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    // Missing or unreadable — start a minimal document Claude will fill out.
    doc = {}
  }

  const projects =
    doc.projects && typeof doc.projects === 'object'
      ? (doc.projects as Record<string, Record<string, unknown>>)
      : ((doc.projects = {}) as Record<string, Record<string, unknown>>)

  let changed = false
  for (const key of trustCwds(cwd)) {
    const entry =
      projects[key] && typeof projects[key] === 'object' ? projects[key] : (projects[key] = {})
    if (entry.hasTrustDialogAccepted === true) continue
    entry.hasTrustDialogAccepted = true
    // Claude fills the rest in on its own, but a freshly minted entry needs the
    // arrays it always carries so nothing chokes reading the file back.
    if (!Array.isArray(entry.allowedTools)) entry.allowedTools = []
    if (!Array.isArray(entry.history)) entry.history = []
    changed = true
  }

  if (changed) writeAtomic(file, JSON.stringify(doc), 0o600)
}

/**
 * Appends a trusted `[projects."…"]` block to `~/.codex/config.toml`, if
 * absent, and repairs a duplicate block an older build of this file wrote.
 */
export function ensureCodexTrust(home: string, cwd: string): void {
  const file = path.join(home, '.codex', 'config.toml')

  let content = ''
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch {
    content = ''
  }

  // Repair first, because a file that already carries a duplicate header would
  // otherwise stay broken forever: the header *is* present, so the append below
  // correctly skips it, and Codex goes on refusing to start.
  const repaired = dropDuplicateTrustBlocks(content)

  let addition = ''
  for (const key of trustCwds(cwd)) {
    const header = `[projects.${tomlBasicString(key)}]`
    // Leave an existing block alone. Without a TOML parser a second header for
    // the same path would make the file invalid, and a decision the user made
    // by hand is not ours to overwrite.
    if (repaired.includes(header)) continue
    addition += `\n${header}\ntrust_level = "trusted"\n`
  }
  if (!addition && repaired === content) return

  const base = repaired.length === 0 ? '' : repaired.endsWith('\n') ? repaired : `${repaired}\n`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeAtomic(file, base + addition, 0o600)
}

/**
 * Removes a repeated `[projects."…"]` table whose body is exactly the record
 * this module writes, keeping the first.
 *
 * Codex parses config.toml strictly and treats a second header for a path it
 * has already seen as a fatal `duplicate key`. It does not skip the section or
 * warn: it exits 1 before doing anything, so *every* Codex session in the app
 * dies at launch pointing at a line in a file the user never edited. Workbench
 * used to write that second header itself, whenever two spellings of one
 * directory normalised onto the same host path; `trustCwds` no longer hands
 * them over, but files corrupted before that fix are still out there, and only
 * this app is in a position to notice.
 *
 * The repair is deliberately the narrowest one that works. It removes only
 * text this module wrote — a repeated header followed by nothing but blank
 * lines and our own `trust_level = "trusted"` — and leaves a duplicate
 * carrying anything else exactly where it is. A block with other keys in it is
 * something the user typed, and dropping settings silently to fix a parse
 * error would be the worse failure of the two.
 */
function dropDuplicateTrustBlocks(content: string): string {
  const lines = content.split('\n')
  const kept: string[] = []
  const seen = new Set<string>()

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].trim()
    if (!header.startsWith('[projects.') || !header.endsWith(']')) {
      kept.push(lines[i])
      continue
    }
    // The table runs to the next header of any kind, or the end of the file.
    // Trailing blank lines come with it, which is what keeps the spacing right
    // when the block is dropped.
    let end = i + 1
    while (end < lines.length && !lines[end].trimStart().startsWith('[')) end++
    const body = lines.slice(i + 1, end)
    const isOurs = body.every((l) => l.trim() === '' || l.trim() === 'trust_level = "trusted"')
    if (!seen.has(header) || !isOurs) {
      seen.add(header)
      kept.push(...lines.slice(i, end))
    }
    i = end - 1
  }

  return kept.join('\n')
}

/** A path as a TOML basic string: double-quoted, with `\` and `"` escaped. */
function tomlBasicString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Writes `data` to `file` atomically via a temp file and rename, so a CLI
 * reading concurrently sees either the old file or the new one, never a torn
 * write. Preserves the existing file's permissions; falls back to `mode` for a
 * file that does not exist yet.
 */
function writeAtomic(file: string, data: string, mode: number): void {
  let fileMode = mode
  try {
    fileMode = fs.statSync(file).mode & 0o777
  } catch {
    // New file — use the caller's default.
  }
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w', fileMode)
  try {
    fs.writeFileSync(fd, data, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}
