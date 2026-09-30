/**
 * Who the preview pane belongs to at any given moment.
 *
 * The dock is one pane, but what it holds belongs to a chat. Several agents
 * run at once here, and each of them finishes turns, writes reports and asks
 * for files on its own schedule — so "a document appeared" is not enough to
 * decide anything. The question is always: appeared *for whom*, and is that
 * who you are looking at?
 *
 * Three answers, and the rule is small enough to state in one place and pin
 * with tests rather than leave scattered through the client.
 */

export type PreviewRoute =
  /** Show it now: it belongs to the chat on screen. */
  | 'open'
  /** Build it into that chat's slot and raise a dot. Do not touch the pane. */
  | 'stash'
  /** Do nothing at all. */
  | 'ignore'

export interface PreviewRouteInput {
  /** The "open the pane when a session produces a document" preference. */
  autoShow: boolean
  /** Whether the session this document belongs to is the focused one. */
  focused: boolean
  /** What that session's slot already holds, or null if it holds nothing. */
  held: { path: string; auto: boolean } | null
  /** The document that just appeared. */
  path: string
  /**
   * True when a session named the file outright — `workbench show <path>`.
   *
   * That is not the pane guessing, so it is not covered by the preference and
   * it does not defer to a document you opened by hand in that same chat.
   * It still does not reach across chats: nothing does.
   */
  asked: boolean
}

export function previewRoute(input: PreviewRouteInput): PreviewRoute {
  const { autoShow, focused, held, path, asked } = input

  // Turning auto-show off turns off the guessing, not the asking.
  if (!autoShow && !asked) return 'ignore'

  // An explicit choice stands, per chat, whether made by the user or named
  // by the agent. Only a guessed document can be replaced by another guess.
  if (!asked && held && !held.auto && held.path !== path) return 'ignore'

  return focused ? 'open' : 'stash'
}
