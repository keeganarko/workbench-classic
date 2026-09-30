/**
 * `@mention` parsing and target ranking.
 *
 * Lives in `shared/` because the renderer's autocomplete and the main process's
 * delivery must agree exactly. If the popup highlights "@reviewer" and the
 * resolver then picks a different session, the user has been lied to about
 * where their prompt went — and with a relay that is a prompt delivered to the
 * wrong agent, not merely a cosmetic mismatch.
 */

import type { AgentKind } from './types.js'

/** The subset of a session a mention needs. Keeps this module type-light. */
export interface MentionTarget {
  id: string
  title: string
  lastTask?: string | null
  agent: AgentKind
  alive: boolean
}

/** A mention the caret is currently sitting inside. */
export interface MentionSpan {
  /** Index of the `@`. */
  start: number
  /** Index one past the last character of the query. */
  end: number
  /** Text between the `@` and the caret, lowercased. */
  query: string
}

/**
 * Characters allowed inside a mention token.
 *
 * Spaces are excluded deliberately. Session titles routinely contain them
 * ("Review pass 2"), but a mention that could swallow the following word would
 * make "@claude fix the bug" ambiguous — is the target "claude" or "claude fix"?
 * Slugs bridge the gap: "Review pass 2" is reachable as `@review-pass-2`.
 */
const TOKEN = /[A-Za-z0-9._-]/

/**
 * Turns a session title into the token users actually type.
 *
 * Not injective — two sessions titled "Reviewer" and "reviewer!" collapse to the
 * same slug. That is fine and intended: ranking handles ties by showing both,
 * and the user picks. Resolution never silently guesses between them.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Finds the mention the caret is inside, or null.
 *
 * A mention only counts at a word start, so `user@example.com` and a bare `@`
 * mid-identifier never open the popup.
 */
export function findMentionAt(text: string, caret: number): MentionSpan | null {
  if (caret < 0 || caret > text.length) return null
  let i = caret - 1
  while (i >= 0 && TOKEN.test(text[i])) i--
  if (i < 0 || text[i] !== '@') return null
  // The `@` itself must start a word, otherwise this is an email or a path.
  if (i > 0 && !/[\s(["'`]/.test(text[i - 1])) return null
  return { start: i, end: caret, query: text.slice(i + 1, caret).toLowerCase() }
}

/**
 * Ranks candidates for a query, best first.
 *
 * The ordering is deliberate rather than a plain fuzzy score: with a relay, the
 * top hit is what an agent-issued `@name` resolves to unattended, so exactness
 * has to beat closeness. Dead sessions rank last but are not dropped — seeing
 * "@reviewer (exited)" greyed out explains a failure that an empty list does not.
 */
export function rankMentions(query: string, sessions: MentionTarget[]): MentionTarget[] {
  const q = query.toLowerCase()
  const scored: { s: MentionTarget; score: number }[] = []

  for (const s of sessions) {
    const slug = slugify(s.title)
    const title = s.title.toLowerCase()
    let score = -1

    if (!q) score = 0
    else if (slug === q || title === q) score = 6
    else if (slug.startsWith(q) || title.startsWith(q)) score = 5
    // A hit at a word boundary ("@pass" → "review-pass-2") beats one buried
    // inside a word ("@ass" → the same session), which is almost always noise.
    else if (slug.includes(`-${q}`) || title.includes(` ${q}`)) score = 4
    else if (slug.includes(q) || title.includes(q)) score = 3
    else if (s.agent === q) score = 2
    else if (s.id.startsWith(q)) score = 1

    if (score >= 0) scored.push({ s, score })
  }

  return scored
    .sort(
      (a, b) =>
        Number(b.s.alive) - Number(a.s.alive) ||
        b.score - a.score ||
        a.s.title.localeCompare(b.s.title)
    )
    .map((x) => x.s)
}

/** One mention resolved — or explicitly not resolved — against the session list. */
export interface ResolvedMention {
  /** The token as typed, without the `@`. */
  token: string
  target: MentionTarget | null
  /** Set when `target` is null: why nothing was picked. */
  reason: 'unknown' | 'ambiguous' | null
  /** Every candidate that tied for the top score, for an "ambiguous" message. */
  candidates: MentionTarget[]
}

/**
 * Resolves a single `@token` to at most one session.
 *
 * Returns `ambiguous` rather than picking a winner when two sessions tie at the
 * top score. Silently choosing one would deliver a prompt to an agent the user
 * did not name, and a relay makes that mistake expensive: the wrong agent starts
 * doing work, and the right one never hears anything.
 */
export function resolveMention(token: string, sessions: MentionTarget[]): ResolvedMention {
  const q = token.toLowerCase()
  if (!q) return { token, target: null, reason: 'unknown', candidates: [] }

  // Live sessions first, then everything. Falling back only when *no* session
  // is live would report a name that belongs to an exited session as unknown,
  // and "no session matches @reviewer" sends you hunting for a typo when the
  // real answer is that @reviewer died.
  const live = sessions.filter((s) => s.alive)
  const liveHits = rankMentions(q, live)
  const ranked = liveHits.length > 0 ? liveHits : rankMentions(q, sessions)
  if (ranked.length === 0) return { token, target: null, reason: 'unknown', candidates: [] }

  // An exact slug match is unambiguous by fiat even if others also rank 6 —
  // except when two sessions share the slug, which is a genuine tie.
  const exact = ranked.filter((s) => slugify(s.title) === q || s.title.toLowerCase() === q)
  if (exact.length === 1) return { token, target: exact[0], reason: null, candidates: exact }
  if (exact.length > 1) return { token, target: null, reason: 'ambiguous', candidates: exact }

  // A unique id prefix is always safe — ids are opaque, so anyone typing one
  // has copied it from somewhere specific.
  const byId = sessions.filter((s) => s.id.startsWith(q))
  if (byId.length === 1) return { token, target: byId[0], reason: null, candidates: byId }

  if (ranked.length === 1) return { token, target: ranked[0], reason: null, candidates: ranked }
  return { token, target: null, reason: 'ambiguous', candidates: ranked.slice(0, 5) }
}

/** Every `@token` in a string, with the spans that produced them. */
export function extractMentions(text: string): { token: string; start: number; end: number }[] {
  const out: { token: string; start: number; end: number }[] = []
  const re = /(^|[\s(["'`])@([A-Za-z0-9._-]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[1].length
    out.push({ token: m[2], start, end: start + m[2].length + 1 })
  }
  return out
}
