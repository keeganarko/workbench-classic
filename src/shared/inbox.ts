import type { Session } from './types.js'

export type InboxKind = 'waiting' | 'failed' | 'review'
export interface InboxMessage { label: string; text: string; isFallback: boolean }

const ORDER: Record<InboxKind, number> = { waiting: 0, failed: 1, review: 2 }

/** One queue rule serves the inbox, badges and home summary. Archived sessions
 * still run, but a person explicitly removed them from their active lists.
 * Keep that choice here too; otherwise a badge can point to invisible work.
 */
export function selectInboxSessions(sessions: Session[], archivedIds: string[], projectId: string | null): Session[] {
  const archived = new Set(archivedIds)
  return sessions.filter((session) =>
    !archived.has(session.id) && (projectId === null || session.sessionProjectId === projectId) &&
    (session.status === 'waiting' || session.status === 'failed' || session.status === 'review'))
    .sort((a, b) => ORDER[a.status as InboxKind] - ORDER[b.status as InboxKind] || b.lastStatusChangeAt - a.lastStatusChangeAt)
}

/** These fields come from a terminal or an agent, not a rich-content editor.
 * Strip terminal control sequences and bound them, then let React render plain
 * text. Preserve line breaks so a real multi-line request remains readable.
 */
function cleanMessage(value: string | null | undefined): string {
  const text = (value ?? '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n').trim()
  return text.length > 1600 ? `${text.slice(0, 1599)}…` : text
}

/** Intent is not an outcome: lastTask can be the user's original request.
 * An inbox entry therefore uses the actual captured reason or response and
 * explicitly says when the capture is missing. A previous reply must never be
 * presented as the current approval request just to fill an empty card.
 */
export function inboxMessage(session: Pick<Session, 'status' | 'statusReason' | 'lastMessage'>): InboxMessage {
  if (session.status === 'waiting') {
    const reason = cleanMessage(session.statusReason)
    const fragment = /^(?:please (?:confirm|choose|clarify)|would you like|which (?:option|approach))[.!?:\s]*$/i.test(reason)
    return {
      label: 'Input request',
      text: reason || 'An input request was detected. Open the terminal to see what the agent needs.',
      isFallback: !reason || fragment
    }
  }
  if (session.status === 'failed') {
    const reason = cleanMessage(session.statusReason)
    return { label: 'Problem reported', text: reason || 'The session stopped with an error. Open the terminal for details.', isFallback: !reason }
  }
  const response = cleanMessage(session.lastMessage)
  return {
    label: 'Latest captured response',
    text: response || 'A turn is ready for review. Its response was not captured here; open the terminal to read it.',
    isFallback: !response
  }
}
