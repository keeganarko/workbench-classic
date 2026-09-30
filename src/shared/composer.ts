import type { Session } from './types.js'
import { extractMentions, resolveMention, type MentionTarget } from './mentions.js'

export type ComposerScope = 'pane' | 'project' | 'all'

/**
 * The selected Workbench project is the delivery boundary. Repository paths
 * cannot stand in for it: two projects may share a checkout, and one project
 * may contain several repositories. An unfiled pane has no project broadcast.
 * Explicitly targeting a pane still permits a shell; broadcasts never do.
 */
export function resolveRecipients(
  sessions: Session[], scope: ComposerScope, focusedId: string | null,
  projectId: string | null, targets: Record<string, boolean>
): Session[] {
  return sessions.filter((s) => s.alive && (scope === 'pane'
    ? s.id === focusedId
    : s.agent !== 'shell' && (targets[s.agent] ?? true)
      && (scope === 'all' || (projectId !== null && s.sessionProjectId === projectId))))
}

/**
 * Resolve once for both the button and Enter. In particular, an ambiguous
 * address must never fall through to a broadcast. Unknown @tokens are ordinary
 * text (package names are common in coding prompts); resolved addresses still
 * override scope, and repeating the same address means one recipient.
 */
export function composerMention(text: string, targets: MentionTarget[]): {
  target: MentionTarget | null; error: string | null
} {
  const resolved = extractMentions(text).map((m) => resolveMention(m.token, targets))
  const ambiguous = resolved.find((r) => r.reason === 'ambiguous')
  if (ambiguous) return { target: null, error: `@${ambiguous.token} matches more than one session — use its session ID.` }
  const named = [...new Map(resolved.flatMap((r) => r.target ? [[r.target.id, r.target] as const] : [])).values()]
  if (named.length > 1) return { target: null, error: 'Naming several sessions at once is not supported — send them one at a time.' }
  const target = named[0] ?? null
  return { target, error: target && !target.alive ? `${target.title} has exited — restart it before sending.` : null }
}
