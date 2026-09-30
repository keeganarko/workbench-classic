/**
 * The context shelf, on disk.
 *
 * Reads and writes `~/.workbench/ctx/<name>/` — a `transcript.jsonl` and a
 * `meta.json` per checkpoint — which is the same directory the `ctx` command on
 * every session's PATH uses. One shelf, two front doors.
 *
 * Everything here is synchronous fs work on files measured in megabytes. That
 * is deliberate: the alternative is a streaming API for an operation the user
 * triggers by hand a few times a day, and the complexity buys nothing.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import {
  SHELF_ENV,
  clampNote,
  isValidCheckpointName,
  projectSlug,
  type Checkpoint
} from '../shared/shelf.js'

/** One line of a transcript. Shapes vary by record type; only these are read. */
interface Record_ {
  type?: string
  cwd?: string
  sessionId?: string
  ownerAccountUuid?: string
  message?: { content?: unknown }
  [k: string]: unknown
}

export class ContextShelf {
  private root: string
  private projects: string

  constructor(root?: string, projects?: string) {
    this.root = root ?? process.env[SHELF_ENV] ?? path.join(os.homedir(), '.workbench', 'ctx')
    this.projects = projects ?? path.join(os.homedir(), '.claude', 'projects')
  }

  private dir(name: string): string {
    if (!isValidCheckpointName(name)) throw new Error('That is not a usable checkpoint name.')
    // Validated above, but joined and re-checked anyway: this path is built
    // from a name that can arrive inside a bundle someone else wrote.
    const d = path.join(this.root, name)
    if (path.dirname(d) !== this.root) throw new Error('That is not a usable checkpoint name.')
    return d
  }

  list(): Checkpoint[] {
    if (!fs.existsSync(this.root)) return []
    const out: Checkpoint[] = []
    for (const name of fs.readdirSync(this.root)) {
      const meta = path.join(this.root, name, 'meta.json')
      if (!fs.existsSync(meta)) continue
      try {
        out.push(JSON.parse(fs.readFileSync(meta, 'utf8')) as Checkpoint)
      } catch {
        /* a half-written shelf entry is not worth failing the whole list over */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  get(name: string): Checkpoint | null {
    const meta = path.join(this.dir(name), 'meta.json')
    if (!fs.existsSync(meta)) return null
    try {
      return JSON.parse(fs.readFileSync(meta, 'utf8')) as Checkpoint
    } catch {
      return null
    }
  }

  /** Where an agent session's transcript should be, given where it ran. */
  transcriptPath(cwd: string, agentSessionId: string): string {
    return path.join(this.projects, projectSlug(cwd), `${agentSessionId}.jsonl`)
  }

  /**
   * Saves a session's transcript under a name.
   *
   * Identity is stripped on the way in rather than on the way out, so a
   * checkpoint is safe to hand over the moment it exists and there is no state
   * where the shelf holds something the export would have removed.
   */
  /** `name`, or the first `name-2`, `name-3`… that is not taken. */
  private freeName(name: string): string {
    if (!fs.existsSync(this.dir(name))) return name
    for (let n = 2; n < 1000; n++) {
      const candidate = `${name.slice(0, 60)}-${n}`
      if (!fs.existsSync(this.dir(candidate))) return candidate
    }
    throw new Error(`Too many checkpoints called ${name}.`)
  }

  save(opts: { name: string; note?: string; cwd: string; agentSessionId: string }): Checkpoint {
    const src = this.transcriptPath(opts.cwd, opts.agentSessionId)
    if (!fs.existsSync(src)) {
      throw new Error('No transcript on disk for this session yet — send it a message first.')
    }
    const records = scrub(readRecords(src))
    // Never overwrite. The whole promise of a checkpoint is that the copy you
    // saved does not change, and the panel derives the name from the session
    // title — so saving the same session twice is the *common* case, not the
    // rare one. A silent overwrite there would destroy the earlier point at
    // exactly the moment the user thought they were preserving it.
    const name = this.freeName(opts.name)
    const d = this.dir(name)
    fs.mkdirSync(d, { recursive: true })
    const file = path.join(d, 'transcript.jsonl')
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')

    const { firstPrompt, turns } = digest(records)
    const meta: Checkpoint = {
      name,
      note: clampNote(opts.note),
      createdAt: Date.now(),
      originCwd: opts.cwd,
      originSessionId: opts.agentSessionId,
      records: records.length,
      turns,
      bytes: fs.statSync(file).size,
      firstPrompt
    }
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta, null, 1))
    return meta
  }

  /**
   * Installs a checkpoint into `cwd` under a brand new agent session id and
   * returns it, ready to be resumed.
   *
   * Both rewrites matter. The session id has to change or opening a checkpoint
   * twice would have two panes writing one transcript. The `cwd` on every
   * record has to change or the resumed session opens against a directory that
   * exists on whoever's machine recorded it and not on this one.
   */
  fork(name: string, cwd: string): string {
    const src = path.join(this.dir(name), 'transcript.jsonl')
    if (!fs.existsSync(src)) throw new Error(`No checkpoint named ${name}.`)
    const next = crypto.randomUUID()
    const dst = path.join(this.projects, projectSlug(cwd))
    fs.mkdirSync(dst, { recursive: true })
    const out = readRecords(src).map((d) => {
      if (d.cwd) d.cwd = cwd
      if (d.sessionId) d.sessionId = next
      return d
    })
    fs.writeFileSync(
      path.join(dst, `${next}.jsonl`),
      out.map((r) => JSON.stringify(r)).join('\n') + '\n'
    )
    return next
  }

  /**
   * Writes a bundle to hand over. The manifest rides in front so the label and
   * the note survive the trip — a checkpoint that arrives as an opaque id has
   * lost the thing that made it worth sending.
   */
  exportBundle(name: string, outPath: string): { path: string; bytes: number } {
    const meta = this.get(name)
    if (!meta) throw new Error(`No checkpoint named ${name}.`)
    const src = path.join(this.dir(name), 'transcript.jsonl')
    const manifest = {
      type: 'ctx-manifest',
      name: meta.name,
      note: meta.note,
      turns: meta.turns,
      originCwd: meta.originCwd
    }
    const lines = [JSON.stringify(manifest), ...scrub(readRecords(src)).map((r) => JSON.stringify(r))]
    fs.writeFileSync(outPath, lines.join('\n') + '\n')
    return { path: outPath, bytes: fs.statSync(outPath).size }
  }

  /** Puts someone else's bundle on this shelf, keeping their label unless taken. */
  importBundle(file: string, rename?: string): Checkpoint {
    const all = readRecords(file)
    if (all.length === 0) throw new Error('Nothing readable in that file.')
    const head = all[0]?.type === 'ctx-manifest' ? all[0] : null
    const records = head ? all.slice(1) : all
    const fallback = path.basename(file).split('.')[0]
    const name = rename || (typeof head?.name === 'string' ? head.name : '') || fallback
    if (!isValidCheckpointName(name)) throw new Error('That bundle has an unusable name.')
    const origin = records.find((d) => d.sessionId)?.sessionId
    if (!origin) throw new Error('No session id in that file — it is not a transcript.')

    const d = this.dir(name)
    fs.mkdirSync(d, { recursive: true })
    const out = path.join(d, 'transcript.jsonl')
    fs.writeFileSync(out, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const { firstPrompt, turns } = digest(records)
    const meta: Checkpoint = {
      name,
      note: clampNote(head?.note),
      createdAt: Date.now(),
      originCwd: typeof head?.originCwd === 'string' ? head.originCwd : '(sent to you)',
      originSessionId: origin,
      records: records.length,
      turns,
      bytes: fs.statSync(out).size,
      firstPrompt
    }
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta, null, 1))
    return meta
  }

  /**
   * Renames a checkpoint, or just re-labels it.
   *
   * The name is the directory, so this moves it; the note is only metadata.
   * Both travel together because in the UI they are one edit — a person
   * relabelling a saved moment is usually adjusting both.
   */
  relabel(name: string, next: { name?: string; note?: string }): Checkpoint {
    const meta = this.get(name)
    if (!meta) throw new Error(`No checkpoint named ${name}.`)
    let dir = this.dir(name)
    let finalName = name
    if (next.name && next.name !== name) {
      const target = this.dir(next.name)
      if (fs.existsSync(target)) throw new Error(`There is already a checkpoint called ${next.name}.`)
      fs.renameSync(dir, target)
      dir = target
      finalName = next.name
    }
    const updated: Checkpoint = {
      ...meta,
      name: finalName,
      note: next.note === undefined ? meta.note : clampNote(next.note)
    }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(updated, null, 1))
    return updated
  }

  remove(name: string): void {
    fs.rmSync(this.dir(name), { recursive: true, force: true })
  }
}

function readRecords(file: string): Record_[] {
  const out: Record_[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as Record_)
    } catch {
      /* a truncated final line is normal on a live transcript */
    }
  }
  return out
}

/**
 * Drops the only identity a transcript carries.
 *
 * The conversation records hold no account information at all; `bridge-session`
 * records — Workbench's own — carry `ownerAccountUuid`, which is the local
 * account id. It is not needed to resume and there is no reason to hand it to
 * anyone, so it never reaches the shelf.
 */
function scrub(records: Record_[]): Record_[] {
  const out: Record_[] = []
  for (const d of records) {
    if (d.type === 'bridge-session') continue
    delete d.ownerAccountUuid
    out.push(d)
  }
  return out
}

/** The two facts that let a human recognise a checkpoint in a list. */
function digest(records: Record_[]): { firstPrompt: string; turns: number } {
  let firstPrompt = ''
  let turns = 0
  for (const d of records) {
    if (d.type !== 'user') continue
    const raw = d.message?.content
    const text = Array.isArray(raw)
      ? raw
          .map((b) => (isTextBlock(b) ? b.text : ''))
          .join(' ')
      : typeof raw === 'string'
        ? raw
        : ''
    const line = text.replace(/\s+/g, ' ').trim()
    // Tool results and injected context arrive as user records too. They open
    // with a tag and are not something a person typed, so they do not count.
    if (!line || line.startsWith('<')) continue
    turns++
    if (!firstPrompt) firstPrompt = line.slice(0, 120)
  }
  return { firstPrompt: firstPrompt || '(no prompt yet)', turns }
}

function isTextBlock(b: unknown): b is { text: string } {
  return typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string'
}
