/**
 * Read only numeric accounting from local CLI transcripts. No prompts, responses,
 * credentials or file paths cross IPC. Reads are asynchronous and unchanged files
 * are cached, so a quota poll cannot synchronously read months of conversations on
 * Electron's main thread (especially over the Windows → WSL filesystem boundary).
 *
 * Only files touched in the last seven days are needed for the weekly view. A
 * resumed terminal touches its file again and then also gets a lifetime total.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { addTokens, zeroTokens, type ProviderTokens, type TokenCounts, type UsageTokens } from '../shared/usageTokens.js'

const WEEK = 7 * 24 * 60 * 60 * 1000
type Row = { id: string; session: string; at: number; counts: TokenCounts }
type Cache = { key: string; rows: Row[] }
type ObjectValue = Record<string, unknown>
function obj(value: unknown): ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ObjectValue : {}
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}
function hasCounts(value: ObjectValue): boolean {
  return ['input_tokens', 'output_tokens'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && (value[key] as number) >= 0)
}
function date(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN
}

async function readRows(file: string, provider: 'claude' | 'codex'): Promise<Row[]> {
  const rows = new Map<string, Row>()
  let session = ''
  let startedAt = 0
  let previous = zeroTokens()
  let epoch = 0
  const input = fs.createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      // Most lines contain conversation content, often large tool output. Avoid
      // parsing it at all; the provider's accounting has distinctive field names.
      if (!line.includes('"usage"') && !line.includes('"token_count"') && !line.includes('"session_meta"')) continue
      let record: ObjectValue
      try { record = obj(JSON.parse(line)) } catch { continue }
      const payload = obj(record.payload)
      if (provider === 'codex' && record.type === 'session_meta') {
        if (typeof payload.id === 'string') session = payload.id
        startedAt = date(payload.timestamp) || date(record.timestamp) || 0
        continue
      }
      const at = date(record.timestamp)
      if (!Number.isFinite(at)) continue
      if (provider === 'claude') {
        const message = obj(record.message)
        const usage = obj(message.usage)
        if (record.type !== 'assistant' || typeof message.id !== 'string' || !hasCounts(usage)) continue
        const id = message.id
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
        const counts: TokenCounts = {
          input: count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens),
          output: count(usage.output_tokens),
          cachedInput: count(usage.cache_read_input_tokens),
          cacheWriteInput: count(usage.cache_creation_input_tokens)
        }
        // Streaming can emit the same message several times. Keep its largest
        // counters instead of charging for each text/tool block independently.
        const old = rows.get(id)
        if (old) for (const key of Object.keys(counts) as (keyof TokenCounts)[]) counts[key] = Math.max(counts[key], old.counts[key])
        rows.set(id, { id, session: sessionId, at: old?.at ?? at, counts })
      } else if (payload.type === 'token_count') {
        const usage = obj(obj(payload.info).total_token_usage)
        if (!hasCounts(usage) || !session) continue
        const current: TokenCounts = {
          input: count(usage.input_tokens), output: count(usage.output_tokens),
          cachedInput: count(usage.cached_input_tokens), cacheWriteInput: count(usage.cache_write_input_tokens)
        }
        const counts = zeroTokens()
        // A CLI restart can begin a new cumulative counter in the same rollout.
        // Count that epoch independently instead of suppressing tokens until it
        // catches up with the old lifetime total.
        if (current.input + current.output < previous.input + previous.output) {
          previous = zeroTokens()
          epoch += 1
        }
        for (const key of Object.keys(counts) as (keyof TokenCounts)[]) {
          counts[key] = Math.max(0, current[key] - previous[key])
          previous[key] = Math.max(previous[key], current[key])
        }
        // Cumulative snapshots repeat at turn boundaries. Differences count each
        // token once; pre-fork history establishes the baseline without charging
        // the inherited conversation a second time in the weekly total.
        if (at < startedAt || counts.input + counts.output === 0) continue
        const id = `${session}:${epoch}:${previous.input}:${previous.output}`
        rows.set(id, { id, session, at, counts })
      }
    }
  } finally {
    lines.close()
    input.destroy()
  }
  return [...rows.values()]
}

/** One reader per monitor: cache entries disappear when their files age out. */
export function createTokenReader(): (home: string, now: number) => Promise<UsageTokens> {
  const cache = new Map<string, Cache>()
  return async (home, now) => {
    const since = now - WEEK
    const seen = new Set<string>()
    async function provider(name: 'claude' | 'codex'): Promise<ProviderTokens> {
      const report: ProviderTokens = { last7Days: null, sessions: {}, observedAt: null, partial: false }
      const unique = new Map<string, Row>()
      async function walk(dir: string, depth = 0): Promise<void> {
        if (depth > 6) return
        let entries: fs.Dirent[]
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report.partial = true
          return
        }
        for (const entry of entries) {
          const file = path.join(dir, entry.name)
          if (entry.isDirectory()) { await walk(file, depth + 1); continue }
          // Ignore symlinks: this reader must stay within the CLI history roots.
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
          try {
            const stat = await fs.promises.stat(file)
            if (stat.mtimeMs < since) continue
            seen.add(file)
            const key = `${stat.mtimeMs}:${stat.size}`
            let item = cache.get(file)
            if (item?.key !== key) {
              item = { key, rows: await readRows(file, name) }
              cache.set(file, item)
            }
            for (const row of item.rows) {
              // Claude branches can copy messages, and archived Codex files can
              // coexist with active copies. Weekly accounting deduplicates both.
              const old = unique.get(row.id)
              if (!old || row.counts.input + row.counts.output > old.counts.input + old.counts.output) unique.set(row.id, row)
            }
          } catch { report.partial = true }
        }
      }
      if (name === 'claude') await walk(path.join(home, '.claude', 'projects'))
      else {
        await walk(path.join(home, '.codex', 'sessions'))
        await walk(path.join(home, '.codex', 'archived_sessions'))
      }
      for (const row of unique.values()) {
        if (row.at > now) continue
        report.observedAt = Math.max(report.observedAt ?? 0, row.at)
        if (row.session) {
          // Use an own-property check: transcript identifiers are external input.
          if (!Object.hasOwn(report.sessions, row.session)) Object.defineProperty(report.sessions, row.session, { value: zeroTokens(), enumerable: true })
          addTokens(report.sessions[row.session], row.counts)
        }
        if (row.at >= since) {
          report.last7Days ??= zeroTokens()
          addTokens(report.last7Days, row.counts)
        }
      }
      return report
    }
    const [claude, codex] = await Promise.all([provider('claude'), provider('codex')])
    for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file)
    return { claude, codex, since }
  }
}
