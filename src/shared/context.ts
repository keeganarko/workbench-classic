/**
 * How much of an agent's context window is in use, read out of the transcript
 * the CLI is already writing.
 *
 * Neither CLI reports this to us. Both write it down, though, in the JSONL each
 * one keeps for its own resume feature — and Workbench already knows where that
 * file is, because the transcript export and the fork-resume check both need
 * it. So this is a read of something that exists rather than a new channel.
 *
 * The two formats say different amounts, and the difference is worth stating
 * because it is why one agent shows a percentage sooner than the other:
 *
 *   - **Codex** writes `model_context_window` outright, next to the token count.
 *     Both numbers are exact and available from the first turn.
 *   - **Claude** writes the token count but never the limit. The only place the
 *     limit appears is in a `compact_boundary` entry, which is written when a
 *     session compacts — so before its first compaction, we honestly do not
 *     know where the ceiling is, and say tokens rather than guess a percentage.
 *
 * Guessing was the alternative, and it is worse than it sounds. A table of
 * model names to window sizes would be perishable, and it would be wrong on
 * this very machine: `message.model` reads `claude-opus-5` for a session whose
 * window is a million tokens, and a session observed here compacted at 216,705
 * — which is neither 200k nor 1M. A number that is confidently wrong about how
 * much room is left is worse than no number.
 *
 * Both parsers take lines rather than a path: the file reading, and its bounds,
 * belong to `main/context.ts`, and everything here is then testable with a
 * string.
 */

export interface ContextUsage {
  /** Tokens in play on the most recent turn. Exact for both agents. */
  tokens: number
  /**
   * Where this session runs out of room, or null when the transcript has not
   * said. Never inferred from the model name — see above.
   */
  limit: number | null
}

/**
 * Lines are scanned newest-first and the scan stops as soon as it has what it
 * needs, so a long window costs nothing once the answer is near the end.
 */
export function claudeContext(lines: string[]): ContextUsage | null {
  let tokens: number | null = null
  let limit: number | null = null

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    // `JSON.parse` on every line of a quarter-megabyte window is the expensive
    // part; a substring test is not, and it rejects nearly all of them.
    const wantsUsage = tokens === null && line.includes('"usage"')
    const wantsBoundary = limit === null && line.includes('"compactMetadata"')
    if (!wantsUsage && !wantsBoundary) continue

    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // a line still being written is not an error
    }

    if (wantsUsage) {
      const usage = pick(pick(entry, 'message'), 'usage')
      if (usage) {
        // Everything the model was charged for on that request is everything
        // that was in the window: the cached prefix, the part newly cached,
        // whatever was uncached, and what it wrote back.
        const total =
          num(usage.input_tokens) +
          num(usage.cache_creation_input_tokens) +
          num(usage.cache_read_input_tokens) +
          num(usage.output_tokens)
        if (total > 0) tokens = total
      }
    }

    if (wantsBoundary) {
      const meta = pick(entry, 'compactMetadata')
      // The size the conversation had reached when the CLI decided to compact
      // it. Not the window itself, but the number that actually matters: it is
      // the point at which this session stops being able to hold more.
      const pre = meta ? num(meta.preTokens) : 0
      if (pre > 0) limit = pre
    }

    if (tokens !== null && limit !== null) break
  }

  return tokens === null ? null : { tokens, limit }
}

/** Codex states both numbers in one event, so the newest one is the whole answer. */
export function codexContext(lines: string[]): ContextUsage | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"token_count"')) continue

    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    const payload = pick(entry, 'payload')
    if (!payload || payload.type !== 'token_count') continue
    const info = pick(payload, 'info')
    if (!info) continue

    // `last_token_usage`, not `total_token_usage`: the latter is everything the
    // session has ever spent, which climbs past the window and never comes back
    // down. The last request is what is in the window right now.
    const last = pick(info, 'last_token_usage')
    const tokens = last ? num(last.total_tokens) : 0
    if (tokens <= 0) continue

    const window = num(info.model_context_window)
    return { tokens, limit: window > 0 ? window : null }
  }
  return null
}

/** Percent of the window still free, or null when the ceiling is unknown. */
export function percentLeft(usage: ContextUsage | null): number | null {
  if (!usage || !usage.limit) return null
  const left = 1 - usage.tokens / usage.limit
  return Math.max(0, Math.min(100, Math.round(left * 100)))
}

/** `108818` → `109k`. Thousands only: nobody reads context to the token. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${Math.round(tokens / 1000)}k`
}

function pick(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  const inner = (value as Record<string, unknown>)[key]
  return typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>) : null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
