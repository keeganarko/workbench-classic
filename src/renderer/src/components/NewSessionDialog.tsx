import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { actions } from '../lib/actions'
import { shortPath } from '../lib/ui'
import { profileOf, useProfiles } from '../lib/agents'
import { ProjectSelect } from './ProjectFilter'
import type { AgentKind, PermissionMode, Workspace, WorkspaceMode } from '../../../shared/types'

const api = window.term

/**
 * Where the agents' files live.
 *
 * This choice used to be made silently: "Start both" opened two agents in one
 * folder, and the first time you noticed was when they overwrote each other.
 * The label for each option says what happens to *your* checkout, because that
 * is the part people care about and the part that used to be a surprise.
 */
const MODES: { mode: WorkspaceMode; label: string; hint: string; bothHint: string }[] = [
  {
    mode: 'current',
    label: 'This folder',
    hint: 'The agent edits your working copy directly.',
    bothHint: 'Both agents edit your working copy — they will see and overwrite each other.'
  },
  {
    mode: 'shared',
    label: 'A new worktree',
    hint: 'A separate checkout on a new branch. Your folder stays exactly as it is.',
    bothHint: 'Both agents work together in one separate checkout. Your folder stays as it is.'
  },
  {
    mode: 'isolated',
    label: 'One each',
    hint: 'A separate checkout on a new branch.',
    bothHint: 'Each agent gets its own checkout and branch — two attempts you can compare.'
  }
]

const PERMISSIONS: { mode: PermissionMode; label: string; hint: string }[] = [
  { mode: 'default', label: 'Ask', hint: 'The agent asks before editing files or running commands.' },
  {
    mode: 'auto',
    label: 'Auto-edit',
    hint: 'Edits inside the working folder are applied without asking; commands still prompt.'
  },
  {
    mode: 'full-access',
    label: 'Full access',
    hint: 'No approval prompts at all — the agent edits files and runs commands on its own. Only use this in a folder you are willing to let it change unsupervised.'
  }
]

export function NewSessionDialog({
  agent: initial,
  projectId: initialProjectId
}: {
  agent: AgentKind
  projectId?: string
}): JSX.Element {
  const prefs = useStore((s) => s.prefs)
  const profiles = useStore((s) => s.profiles)
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.sessionProjects)
  const [agent, setAgent] = useState<AgentKind>(initial)
  const initialProject = projects.find((project) => project.id === initialProjectId)
  const [cwd, setCwd] = useState(initialProject?.defaultCwd ?? prefs.defaultCwd)
  const [projectId, setProjectId] = useState(initialProject?.id ?? '')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [both, setBoth] = useState(false)
  const [mode, setMode] = useState<WorkspaceMode>('current')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    prefs.defaultPermissionMode ?? 'default'
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** undefined while we ask git, null once we know the folder is not a repo. */
  const [repo, setRepo] = useState<{ branch: string | null } | null | undefined>(undefined)
  /** Repositories one level down, offered when the folder itself is not one. */
  const [nested, setNested] = useState<{ name: string; path: string }[]>([])
  const cwdRef = useRef<HTMLInputElement>(null)

  useEffect(() => cwdRef.current?.focus(), [])

  // Worktrees need a repository, so find out before offering them. Debounced
  // because this runs on every keystroke in the folder field, and settled
  // against a stale-response guard so slow answers cannot overwrite fast ones.
  useEffect(() => {
    const dir = cwd.trim()
    if (!dir) {
      setRepo(null)
      setNested([])
      return
    }
    let live = true
    setRepo(undefined)
    const timer = setTimeout(() => {
      api
        .describeFolder(dir)
        .then(async (info) => {
          if (!live) return
          setRepo(info ? { branch: info.branch } : null)
          // Only worth asking when the answer was no: a folder that *is* a
          // repository already has everything the dialog needs.
          if (info) {
            setNested([])
            return
          }
          const found = await api.findRepos(dir).catch(() => [])
          // Checked again: the folder may have changed during that round trip.
          if (live) setNested(found)
        })
        .catch(() => {
          if (live) setRepo(null)
        })
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [cwd])

  const isRepo = repo !== null && repo !== undefined
  // "One each" only means something when there is more than one agent.
  const modes = MODES.filter((m) => m.mode !== 'isolated' || both)
  // A folder with no repository has nothing to branch, so the choice collapses
  // to "this folder" — and the hint below says so rather than failing at launch.
  const effectiveMode: WorkspaceMode = !isRepo
    ? 'current'
    : mode === 'isolated' && !both
      ? 'shared'
      : mode

  const profile = profileOf(agent, profiles)
  const unavailable = !profile.available
  // The two assistants "Start both" means. Taken from the registry rather than
  // named, so an install with Gemini and no Codex still offers the pairing.
  const pair = profiles.filter((p) => p.id !== 'shell' && p.available).slice(0, 2)

  // Recently used folders make the common case one click.
  const recentDirs = Array.from(new Set(sessions.map((s) => s.cwd))).slice(0, 5)

  const start = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    const dir = cwd.trim() || prefs.defaultCwd
    const opts = {
      cwd: dir,
      sessionProjectId: projectId || undefined,
      title: title.trim() || undefined,
      initialPrompt: prompt.trim() || undefined,
      permissionMode
    }

    // Workspaces are resolved up front, in one call. Two independent calls
    // could not agree on which worktree "shared" means, and a failure here has
    // to stop the launch rather than quietly drop the agents into the folder
    // the user was trying to protect.
    let made: Workspace[] = []
    if (effectiveMode !== 'current') {
      try {
        made = await api.prepareWorkspaces({
          cwd: dir,
          title: title.trim() || prompt.trim().slice(0, 60) || undefined,
          mode: effectiveMode,
          count: both ? 2 : 1
        })
      } catch (err) {
        setError((err as Error).message)
        setBusy(false)
        return
      }
    }

    const agents: AgentKind[] = both ? pair.map((p) => p.id) : [agent]
    for (let i = 0; i < agents.length; i += 1) {
      if (i > 0) useStore.getState().split('h')
      await actions.createSession({
        ...opts,
        agent: agents[i],
        workspaceId: made[i]?.id
      })
    }
    setBusy(false)
  }

  return (
    <div className="overlay" onMouseDown={() => useStore.getState().setOverlay({ kind: 'none' })}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__head">New session</div>
        <div className="modal__body">
          <div className="field">
            <span className="field__label">Agent</span>
            <div className="segmented segmented--wrap">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  className={`segmented__opt${agent === p.id && !both ? ' segmented__opt--on' : ''}`}
                  disabled={both}
                  onClick={() => setAgent(p.id)}
                  title={p.available ? p.command : `${p.command} was not found on PATH`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {pair.length === 2 && (
              <label className="switch" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} />
                Start {pair[0].label} and {pair[1].label} side by side
              </label>
            )}
            {unavailable && !both && (
              <span className="field__hint" style={{ color: 'var(--status-waiting)' }}>
                {profile.command || agent} was not found on PATH — the session will open but the
                command will fail.
              </span>
            )}
          </div>

          <div className="field">
            <span className="field__label">Working folder</span>
            <div className="field__row">
              <input
                ref={cwdRef}
                className="mono"
                style={{ flex: 1 }}
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
              <button
                className="btn btn--ghost"
                style={{ flex: '0 0 auto' }}
                onClick={async () => {
                  const picked = await api.pickFolder(cwd)
                  if (picked) setCwd(picked)
                }}
              >
                Browse…
              </button>
            </div>
            {recentDirs.length > 0 && (
              <div className="composer__targets" style={{ marginTop: 2 }}>
                {recentDirs.map((d) => (
                  <button key={d} className="chip" onClick={() => setCwd(d)}>
                    {shortPath(d)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="field">
            <span className="field__label">Project</span>
            <ProjectSelect projects={projects}
              value={projectId}
              onChange={(next) => {
                setProjectId(next)
                const project = projects.find((item) => item.id === next)
                if (project) setCwd(project.defaultCwd)
              }}
            />
            <span className="field__hint">
              Projects organize conversations independently of repositories and worktrees.
            </span>
          </div>

          <div className="field">
            <span className="field__label">Files</span>
            <div className="segmented">
              {modes.map((m) => (
                <button
                  key={m.mode}
                  className={`segmented__opt${mode === m.mode ? ' segmented__opt--on' : ''}`}
                  disabled={m.mode !== 'current' && !isRepo}
                  onClick={() => setMode(m.mode)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span
              className={`field__hint${
                both && effectiveMode === 'current' ? ' field__hint--error' : ''
              }`}
            >
              {repo === undefined
                ? 'Checking the folder…'
                : !isRepo
                  ? 'Not a Git repository — worktrees need one, so the agents will use this folder.'
                  : both
                    ? MODES.find((m) => m.mode === mode)?.bothHint
                    : MODES.find((m) => m.mode === effectiveMode)?.hint}
            </span>
            {!isRepo && repo !== undefined && nested.length > 0 && (
              <>
                <span className="field__hint" style={{ marginTop: 4 }}>
                  {nested.length === 1 ? 'A repository is' : `${nested.length} repositories are`}{' '}
                  one level down — pick one to enable worktrees:
                </span>
                <div className="composer__targets" style={{ marginTop: 2 }}>
                  {nested.map((r) => (
                    <button key={r.path} className="chip" onClick={() => setCwd(r.path)}>
                      {r.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {agent !== 'shell' && !both && (
            <div className="field">
              <span className="field__label">Approvals</span>
              <div className="segmented">
                {PERMISSIONS.map((p) => (
                  <button
                    key={p.mode}
                    className={`segmented__opt${
                      permissionMode === p.mode ? ' segmented__opt--on' : ''
                    }`}
                    onClick={() => setPermissionMode(p.mode)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <span
                className={`field__hint${
                  permissionMode === 'full-access' ? ' field__hint--error' : ''
                }`}
              >
                {PERMISSIONS.find((p) => p.mode === permissionMode)?.hint}
              </span>
            </div>
          )}

          <div className="field">
            <span className="field__label">Role hint (optional)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Assigned automatically from your work" />
            <span className="field__hint">A short job title, such as Financial Advisor. Recent work appears underneath.</span>
          </div>

          <div className="field">
            <span className="field__label">Opening prompt (optional)</span>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Typed into the agent once it finishes booting…"
            />
          </div>
        </div>
        <div className="modal__foot">
          {error && (
            <span className="field__hint field__hint--error" style={{ flex: 1 }}>
              {error}
            </span>
          )}
          <button
            className="btn btn--ghost"
            style={{ flex: '0 0 auto' }}
            onClick={() => useStore.getState().setOverlay({ kind: 'none' })}
          >
            Cancel
          </button>
          <button
            className="btn btn--primary"
            style={{ flex: '0 0 auto' }}
            disabled={busy}
            onClick={() => void start()}
          >
            {busy ? 'Starting…' : both ? 'Start both' : `Start ${profile.label}`}
          </button>
        </div>
      </div>
    </div>
  )
}
