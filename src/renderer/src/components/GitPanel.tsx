import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { activeSessionId } from '../lib/actions'
import { preview } from '../lib/preview'
import { shortPath } from '../lib/ui'
import { Icon } from './Icon'
import { PanelEmpty as Empty } from './PanelEmpty'
import type { GitChange, GitFileChange, GitStatus } from '../../../shared/types'

const api = window.term

/**
 * The review surface: what the focused agent changed, and what to do about it.
 *
 * Scoped deliberately narrower than a git client. Everything here is either
 * read-only or one command away from being undone — stage, unstage, commit,
 * push — because the question this panel answers is "is this work good?", not
 * "how do I rewrite this history". Anything destructive belongs in a terminal
 * where you can see exactly what you typed.
 *
 * It follows the focused pane rather than taking a repository of its own, so
 * the answer is always about the agent you are looking at. That also means it
 * needs no directory of its own: every call names a session, and main resolves
 * the working directory from the session record.
 */
export function GitPanel(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const openDiff = useStore((s) => s.preview.diff)

  const sessionId = activeSessionId()
  const session = sessions.find((s) => s.id === sessionId) ?? null

  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [message, setMessage] = useState('')
  const [confirmPush, setConfirmPush] = useState(false)
  // Guards against a slow status landing after focus has already moved on.
  const forSession = useRef<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!sessionId) {
      setStatus(null)
      setError(null)
      setLoaded(true)
      return
    }
    forSession.current = sessionId
    try {
      const next = await api.gitStatus(sessionId)
      if (forSession.current !== sessionId) return
      setStatus(next)
      setError(null)
    } catch (err) {
      if (forSession.current !== sessionId) return
      setStatus(null)
      setError((err as Error).message)
    } finally {
      if (forSession.current === sessionId) setLoaded(true)
    }
  }, [sessionId])

  // Re-read when focus moves, and whenever a session's state changes — an agent
  // that just finished a turn has almost certainly written something.
  useEffect(() => {
    void refresh()
  }, [refresh, tabs, activeTabId, sessions])

  // A push offer only stands for the branch it was made about.
  useEffect(() => setConfirmPush(false), [sessionId, status?.branch, status?.ahead])

  const run = async (fn: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      await refresh()
      // Whatever diff is on screen was taken before this; make it true again.
      if (openDiff) await preview.refresh()
      if (done) useStore.getState().setToast(done, 'success')
    } catch (err) {
      useStore.getState().setToast((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!sessionId || !session) {
    return <Empty title="No session focused" note="Focus a pane to see what it has changed." />
  }
  if (!loaded) return <Empty title="Reading the repository…" note="" />
  if (error) return <Empty title="Could not read git" note={error} />
  if (!status) {
    return (
      <Empty
        title="Not a repository"
        note={`${shortPath(session.cwd)} is not inside a git repository, so there is nothing to review here.`}
      />
    )
  }

  const staged = status.files.filter((f) => f.staged && f.staged !== 'conflicted')
  const unstaged = status.files.filter((f) => f.unstaged && f.unstaged !== 'conflicted')
  const conflicted = status.files.filter((f) => f.staged === 'conflicted')

  return (
    <div className="git">
      <div className="git__head">
        <Icon name="git" size={13} />
        <span className="git__branch" title={status.root}>
          {status.branch ?? 'detached HEAD'}
        </span>
        {status.ahead > 0 && (
          <span className="git__count" title="Commits not pushed">
            ↑{status.ahead}
          </span>
        )}
        {status.behind > 0 && (
          <span className="git__count" title="Commits on the remote you do not have">
            ↓{status.behind}
          </span>
        )}
        <button
          className="iconbtn git__refresh"
          title="Re-read the repository"
          onClick={() => void refresh()}
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>

      <div className="git__scope">
        <button
          className="git__scope-btn"
          title="Everything this working copy has changed since it left the default branch"
          disabled={status.unborn || !status.defaultBranch}
          onClick={() =>
            void preview.openDiff(
              { sessionId, side: 'branch', file: null, base: status.defaultBranch },
              `${status.branch ?? 'HEAD'} vs ${status.defaultBranch}`
            )
          }
        >
          <Icon name="diff" size={12} /> Everything since {status.defaultBranch ?? 'the base'}
        </button>
      </div>

      {status.files.length === 0 ? (
        <div className="git__clean">
          <Icon name="check" size={13} /> Working tree clean
        </div>
      ) : (
        <div className="git__scroll">
          {conflicted.length > 0 && (
            <Group label="Conflicts" count={conflicted.length}>
              {conflicted.map((f) => (
                <Row
                  key={`c-${f.path}`}
                  file={f}
                  side="worktree"
                  change="conflicted"
                  sessionId={sessionId}
                  busy
                />
              ))}
              <div className="git__hint">
                Resolve these in the session, then stage them. The panel will not
                stage a half-merged file for you.
              </div>
            </Group>
          )}

          {staged.length > 0 && (
            <Group
              label="Staged"
              count={staged.length}
              action={
                <button
                  className="git__group-action"
                  disabled={busy}
                  title="Unstage every staged file"
                  onClick={() =>
                    void run(() => api.gitUnstage(sessionId, staged.map((f) => f.path)))
                  }
                >
                  Unstage all
                </button>
              }
            >
              {staged.map((f) => (
                <Row
                  key={`s-${f.path}`}
                  file={f}
                  side="staged"
                  change={f.staged as GitChange}
                  sessionId={sessionId}
                  busy={busy}
                  onToggle={() => void run(() => api.gitUnstage(sessionId, [f.path]))}
                />
              ))}
            </Group>
          )}

          {unstaged.length > 0 && (
            <Group
              label="Changes"
              count={unstaged.length}
              action={
                <button
                  className="git__group-action"
                  disabled={busy}
                  title="Stage every change"
                  onClick={() =>
                    void run(() => api.gitStage(sessionId, unstaged.map((f) => f.path)))
                  }
                >
                  Stage all
                </button>
              }
            >
              {unstaged.map((f) => (
                <Row
                  key={`u-${f.path}`}
                  file={f}
                  side="worktree"
                  change={f.unstaged as GitChange}
                  sessionId={sessionId}
                  busy={busy}
                  onToggle={() => void run(() => api.gitStage(sessionId, [f.path]))}
                />
              ))}
            </Group>
          )}
        </div>
      )}

      <div className="git__commit">
        <textarea
          className="git__message"
          placeholder={
            staged.length
              ? `Commit ${staged.length} staged file${staged.length === 1 ? '' : 's'}…`
              : 'Stage something first…'
          }
          value={message}
          rows={2}
          spellCheck={false}
          disabled={staged.length === 0 || busy}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && message.trim()) {
              e.preventDefault()
              void run(async () => {
                await api.gitCommit(sessionId, message)
                setMessage('')
              }, 'Committed.')
            }
          }}
        />
        <div className="git__commit-row">
          <button
            className="btn btn--primary git__commit-btn"
            disabled={staged.length === 0 || !message.trim() || busy}
            title="Commit the staged files (⌘⏎)"
            onClick={() =>
              void run(async () => {
                await api.gitCommit(sessionId, message)
                setMessage('')
              }, 'Committed.')
            }
          >
            Commit
          </button>
          {/* Push is the only thing in this app that leaves the machine, so it
              says where it is going and takes two clicks to get there. */}
          <button
            className={`btn${confirmPush ? ' btn--danger' : ' btn--ghost'} git__push`}
            disabled={busy || status.unborn || status.ahead === 0}
            title={
              status.upstream
                ? `Push ${status.ahead} commit${status.ahead === 1 ? '' : 's'} to ${status.upstream}`
                : `Publish ${status.branch} to origin — it has no upstream yet`
            }
            onClick={() => {
              if (!confirmPush) {
                setConfirmPush(true)
                return
              }
              setConfirmPush(false)
              void run(async () => {
                const res = await api.gitPush(sessionId)
                useStore
                  .getState()
                  .setToast(`Pushed ${res.branch} to ${res.remote}.`, 'success')
              })
            }}
          >
            {confirmPush
              ? `Push to ${status.upstream ?? `origin/${status.branch}`}?`
              : status.upstream
                ? `Push ${status.ahead}`
                : 'Publish'}
          </button>
        </div>
      </div>

      <button
        className="git__review"
        disabled={status.files.length === 0 && status.ahead === 0}
        title="Fork a child session and ask it to review this work"
        onClick={() => void reviewEverything(sessionId, status)}
      >
        <Icon name="fork" size={12} /> Review this work
      </button>
    </div>
  )
}

/**
 * The review fork, taken from the panel rather than from an open diff.
 *
 * Prefers the branch comparison when there is one, because "everything this
 * agent did" is the question you are asking at the end of a run — the working
 * tree alone would omit whatever it already committed.
 */
async function reviewEverything(sessionId: string, status: GitStatus): Promise<void> {
  const st = useStore.getState()
  const query =
    !status.unborn && status.defaultBranch && status.defaultBranch !== status.branch
      ? { sessionId, side: 'branch' as const, file: null, base: status.defaultBranch }
      : { sessionId, side: 'worktree' as const, file: null }
  try {
    const session = await api.gitReviewDiff(query)
    st.revealSession(session.id)
    st.setToast('Reviewing that work in a new child session.', 'success')
  } catch (err) {
    st.setToast(`Could not start the review: ${(err as Error).message}`, 'error')
  }
}

function Group({
  label,
  count,
  action,
  children
}: {
  label: string
  count: number
  action?: JSX.Element
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="git__group">
      <div className="git__group-head">
        <span className="git__group-label">{label}</span>
        <span className="git__group-count">{count}</span>
        {action}
      </div>
      {children}
    </div>
  )
}

const CHANGE_LETTER: Record<GitChange, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: 'U',
  conflicted: '!'
}

const CHANGE_TITLE: Record<GitChange, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  typechange: 'Type changed',
  untracked: 'Not tracked yet',
  conflicted: 'Conflicted — resolve it in the session'
}

/**
 * One file. Clicking the name opens its diff; the button on the right moves it
 * between staged and unstaged.
 */
function Row({
  file,
  side,
  change,
  sessionId,
  busy,
  onToggle
}: {
  file: GitFileChange
  side: 'staged' | 'worktree'
  change: GitChange
  sessionId: string
  busy: boolean
  onToggle?: () => void
}): JSX.Element {
  const name = file.path.split('/').pop() ?? file.path
  const dir = file.path.slice(0, file.path.length - name.length).replace(/\/$/, '')

  return (
    <div className={`git__row git__row--${change}`}>
      <button
        className="git__file"
        title={file.from ? `${file.path} (from ${file.from})` : file.path}
        onClick={() =>
          void preview.openDiff(
            {
              sessionId,
              side,
              file: file.path,
              untracked: change === 'untracked'
            },
            name
          )
        }
      >
        <span className={`git__letter git__letter--${change}`} title={CHANGE_TITLE[change]}>
          {CHANGE_LETTER[change]}
        </span>
        <span className="git__name">{name}</span>
        {dir && <span className="git__dir">{dir}</span>}
      </button>
      {onToggle && (
        <button
          className="iconbtn git__toggle"
          disabled={busy}
          title={side === 'staged' ? 'Unstage' : 'Stage'}
          onClick={onToggle}
        >
          <Icon name={side === 'staged' ? 'minus' : 'plus'} size={12} />
        </button>
      )}
    </div>
  )
}

