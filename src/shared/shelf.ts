/**
 * The context shelf — named, portable checkpoints of an agent conversation.
 *
 * A Claude session is one JSONL file holding the entire conversation, which
 * makes an interesting moment in one a saveable thing: give it a name and it
 * becomes something you can come back to, hand to someone else, and — the part
 * that matters — open more than once.
 *
 * Two decisions are baked into the shapes here.
 *
 * **Opening always forks.** A checkpoint is never the live session. Every open
 * mints a fresh agent session id and re-points the transcript at the target
 * directory, so the saved copy stays pristine and two people can open the same
 * checkpoint from an identical starting state without touching each other's
 * work. That is the whole point: same context, different next move.
 *
 * **The shelf is the CLI's shelf.** `ctx` on the session PATH and this panel
 * read and write the same directory, because a checkpoint saved from a terminal
 * and one saved from the app are the same object. Two shelves would be a bug
 * the user has to remember.
 */

/** Where checkpoints live. Overridable so tests never touch a real shelf. */
export const SHELF_ENV = 'WORKBENCH_CTX_HOME'

/** Ceiling on a note. It is a reminder, not a document. */
export const MAX_NOTE_CHARS = 280

/**
 * A checkpoint's name becomes a directory name and travels inside a bundle
 * someone else wrote, so it is validated rather than trusted: no separators, no
 * leading dot, nothing that could climb out of the shelf.
 */
export const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export interface Checkpoint {
  name: string
  /** Why this moment was worth keeping. Free text, may be empty. */
  note: string
  createdAt: number
  /** Directory the conversation was recorded in — theirs, if it was sent. */
  originCwd: string
  /** The agent session id it was taken from. Never reused when opening. */
  originSessionId: string
  records: number
  /** User turns, which is the number a human recognises the session by. */
  turns: number
  bytes: number
  /** First thing the human asked, as the shelf's human-readable handle. */
  firstPrompt: string
}

export function isValidCheckpointName(name: unknown): name is string {
  return typeof name === 'string' && NAME_PATTERN.test(name)
}

/**
 * Turns a free-typed label into a valid name rather than rejecting it. The user
 * is naming a moment, not a directory, and should not have to know the rules.
 */
export function toCheckpointName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
    .slice(0, 64)
  return cleaned || `checkpoint-${new Date().toISOString().slice(0, 10)}`
}

/**
 * A transcript lives under a directory named for the working directory it was
 * recorded in, with separators turned to dashes. That mapping is the only thing
 * connecting a session to its file, so it lives in one place.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

export function clampNote(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS)
}
