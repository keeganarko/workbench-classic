/**
 * Turning attachment paths into text an agent's composer will accept.
 *
 * Both Claude Code and Codex read images and files from ordinary filesystem
 * paths, so "paste a screenshot" reduces to "type a path". That means the
 * formatting rules live on the renderer side of the bridge as well as the main
 * side, which is why they are here rather than in `main/attachments.ts`.
 *
 * Keep this file free of runtime imports — the renderer imports it directly.
 */

/**
 * Characters that need no quoting in a prompt or a shell word.
 *
 * Deliberately conservative: anything outside this set gets quoted rather than
 * guessed at. A path is user data, and the pane it is typed into may be a bare
 * shell, where an unquoted `$(...)` or `;` in a filename is a command.
 */
const BARE_PATH = /^[A-Za-z0-9._~@+=:,/-]+$/

/** Renders one path so it survives being typed into a TUI composer or a shell. */
export function quoteForPrompt(p: string): string {
  if (p === '') return "''"
  if (BARE_PATH.test(p)) return p
  // POSIX single-quoting: everything is literal inside, and an embedded quote
  // is closed, escaped and reopened.
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/**
 * The exact text typed into a pane after files are attached.
 *
 * Ends with a space so the user's next keystroke starts a word rather than
 * gluing itself onto the filename, and so pasting twice does not run two paths
 * together.
 */
export function formatAttachmentText(paths: string[]): string {
  if (paths.length === 0) return ''
  return `${paths.map(quoteForPrompt).join(' ')} `
}
