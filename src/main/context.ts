/**
 * Reading the end of a transcript, cheaply and often.
 *
 * A working agent's JSONL grows without bound — the two in this project's
 * history are seven megabytes each — and the poll loop wants an answer every
 * two seconds, per session. So this never reads the file: it reads the last
 * quarter-megabyte of it, and only when the file has changed since last time.
 *
 * Everything that decides what the bytes *mean* lives in `shared/context.ts`.
 * This file is the part that needs a disk.
 */

import fs from 'node:fs'
import type { LaunchStrategy } from '../shared/agents.js'

import { claudeContext, codexContext } from '../shared/context.js'
import type { ContextUsage } from '../shared/context.js'

/**
 * How much of the tail to read.
 *
 * Big enough to hold many entries, so the newest one carrying a token count is
 * almost always inside it. When it is not — one enormous entry can push it out
 * — the answer is "unknown" for a turn, and the next turn's entry brings it
 * back. A missing chip beats a stale one.
 */
const TAIL_BYTES = 256 * 1024

export interface ContextReader {
  /** Null when the file has not changed, or has nothing to say yet. */
  read(launch: LaunchStrategy, file: string): ContextUsage | null
}

/**
 * Caches by file, keyed on the modification time and size together.
 *
 * Either alone is defeatable — a same-second append that lands on the same
 * length is unlikely but a same-second append is not — and both together cost
 * one `stat`, which is what the freshness check is for in the first place.
 */
export function createContextReader(): ContextReader {
  const seen = new Map<string, { key: string; usage: ContextUsage | null }>()

  return {
    read(launch, file) {
      let stat: fs.Stats
      try {
        stat = fs.statSync(file)
      } catch {
        seen.delete(file)
        return null // the CLI has not written it yet, or it has been cleaned up
      }

      const key = `${stat.mtimeMs}:${stat.size}`
      const cached = seen.get(file)
      if (cached && cached.key === key) return cached.usage

      const usage = parseTail(launch, file, stat.size)
      seen.set(file, { key, usage })
      return usage
    }
  }
}

function parseTail(launch: LaunchStrategy, file: string, size: number): ContextUsage | null {
  if (size === 0) return null
  const start = Math.max(0, size - TAIL_BYTES)
  const length = size - start

  let text: string
  let handle: number
  try {
    handle = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.allocUnsafe(length)
    const read = fs.readSync(handle, buf, 0, length, start)
    text = buf.subarray(0, read).toString('utf8')
  } catch {
    return null
  } finally {
    fs.closeSync(handle)
  }

  const lines = text.split('\n')
  // Starting mid-file means the first line is the tail of one that began before
  // the window. It is not parseable and, worse, might parse into something
  // wrong, so it goes.
  if (start > 0) lines.shift()

  // Keyed on the launch strategy, not the agent id: the format is a fact about
  // which CLI wrote the file, and only the two built-ins write one at all.
  return launch === 'codex' ? codexContext(lines) : claudeContext(lines)
}
