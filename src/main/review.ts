/**
 * The review half of the loop: what changed, and handing it to an agent.
 *
 * Workbench watches agents work and then, historically, stopped — leaving the
 * moment the work is *done* to another window. This module is the other half:
 * the status of the repository an agent is working in, the diff of what it did,
 * and a one-click fork that asks a fresh agent to review that diff.
 *
 * Two things it deliberately is not:
 *
 *   - **Not a git client.** Status, diff, stage, unstage, commit, push. No
 *     rebase, no cherry-pick, no branch surgery. Everything here is either
 *     read-only or trivially undoable, except `push`, which is spelled out at
 *     the call site and never happens without a click.
 *   - **Not a path API.** Every operation is addressed by *session*, never by
 *     directory. The renderer cannot name a folder for git to run in; it can
 *     only name a session it can already see, and the working directory comes
 *     from the session record in main. That is the whole authorisation model,
 *     and it is one line rather than a check that can be forgotten.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  commitStaged,
  pushCurrent,
  readDiff,
  readStatus,
  runGit,
  stagePaths,
  unstagePaths
} from './git.js'
import type { GitRunner, GitStatus } from './git.js'
import type { DiffQuery } from '../shared/types.js'

export type { DiffQuery }

/** The slice of a session this module needs. Structural, so a change breaks the build. */
export interface ReviewSession {
  id: string
  cwd: string
  title: string
  agent: string
}

export interface ReviewSessions {
  get(id: string): ReviewSession | undefined
}

export interface GitReviewDeps {
  sessions: ReviewSessions
  /** Where patch files handed to a reviewing agent are written. */
  dataDir: string
  run?: GitRunner
}

export interface DiffPayload {
  patch: string
  truncated: boolean
  /** What this is a diff of, for the pane's header. */
  label: string
  /** Repository root, so the pane can show paths the way the user thinks of them. */
  root: string
}

/**
 * Repository-relative and nothing else.
 *
 * git would refuse most of these itself, but "the argument never leaves the
 * repository" is a property worth holding here rather than trusting a message
 * from a subprocess to enforce.
 */
function assertRepoRelative(p: string): string {
  const value = String(p)
  if (!value || value.includes('\0')) throw new Error('Invalid path')
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error('Paths in a repository are relative to its root')
  }
  if (value.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error('That path leaves the repository')
  }
  return value
}

export class GitReview {
  private readonly deps: GitReviewDeps
  private readonly run: GitRunner

  constructor(deps: GitReviewDeps) {
    this.deps = deps
    this.run = deps.run ?? runGit
  }

  /**
   * The working directory a session is running in.
   *
   * Nothing else in this file resolves a directory, so every git invocation is
   * anchored to a session that exists.
   */
  private dirFor(sessionId: string): { dir: string; session: ReviewSession } {
    const session = this.deps.sessions.get(sessionId)
    if (!session) throw new Error('That session no longer exists')
    return { dir: session.cwd, session }
  }

  /** Null when the session is not in a repository — an ordinary answer, not an error. */
  async status(sessionId: string): Promise<GitStatus | null> {
    const { dir } = this.dirFor(sessionId)
    return readStatus(this.run, dir)
  }

  async diff(query: DiffQuery): Promise<DiffPayload> {
    const { dir } = this.dirFor(query.sessionId)
    const status = await readStatus(this.run, dir)
    if (!status) throw new Error('That session is not inside a git repository')

    const file = query.file ? assertRepoRelative(query.file) : null
    const base = query.side === 'branch' ? (query.base || status.defaultBranch) : null
    if (query.side === 'branch' && !base) {
      throw new Error('This repository has no branch to compare against')
    }

    const result = await readDiff(this.run, dir, {
      side: query.side,
      file,
      base,
      untracked: query.untracked === true
    })
    return { ...result, root: status.root }
  }

  async stage(sessionId: string, paths: string[]): Promise<void> {
    const { dir } = this.dirFor(sessionId)
    await stagePaths(this.run, dir, paths.map(assertRepoRelative))
  }

  async unstage(sessionId: string, paths: string[]): Promise<void> {
    const { dir } = this.dirFor(sessionId)
    await unstagePaths(this.run, dir, paths.map(assertRepoRelative))
  }

  async commit(sessionId: string, message: string): Promise<{ sha: string; subject: string }> {
    const { dir } = this.dirFor(sessionId)
    return commitStaged(this.run, dir, message)
  }

  /** The one call that leaves the machine. Reached only from a button that names the target. */
  async push(sessionId: string): Promise<{ remote: string; branch: string; created: boolean }> {
    const { dir } = this.dirFor(sessionId)
    return pushCurrent(this.run, dir)
  }

  /**
   * Writes a diff to a file and returns the prompt that asks an agent to review it.
   *
   * The patch goes to a file rather than into the prompt for the same reason a
   * handoff transcript does: a prompt is typed into a terminal one character at
   * a time, and a thousand-line patch delivered that way is slow, fragile, and
   * unreadable in the scrollback afterwards. A path is one line, and the agent
   * can read it as many times as it likes.
   */
  async patchFileFor(query: DiffQuery): Promise<{ file: string; prompt: string; empty: boolean }> {
    const { session } = this.dirFor(query.sessionId)
    const payload = await this.diff(query)

    const outDir = path.join(this.deps.dataDir, 'diffs')
    fs.mkdirSync(outDir, { recursive: true })
    const file = path.join(outDir, `${query.sessionId}-${Date.now()}.patch`)
    // Written as a plain patch with nothing prepended, so it is still something
    // `git apply` accepts. Everything a reviewer needs to know *about* the
    // patch goes in the prompt, where it does not corrupt the file.
    fs.writeFileSync(file, payload.patch, 'utf8')

    const scope = query.file ? `\`${query.file}\`` : 'the working tree'
    const caveat = payload.truncated
      ? ' The patch was too large to capture in full, so it is cut short — say so if the change looks incomplete.'
      : ''
    const prompt =
      `Review the changes to ${scope} in ${payload.root} (${payload.label}, from the session "${session.title}"). ` +
      `The patch is at ${file} — read it first, then read the surrounding code for anything it touches.${caveat} ` +
      'Report correctness bugs first, then anything that would break at runtime, then anything unclear. ' +
      'Do not change any files; this is a review.'

    return { file, prompt, empty: payload.patch.trim() === '' }
  }
}
