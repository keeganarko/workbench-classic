import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { SyncPreview } from '../../../shared/projectSync'
import { useStore } from '../state/store'

const api = window.term

/** Sharing is opt-in per folder. Show the actual first upload before creating
 * its private repository; credentials and invitations remain with GitHub. */
export function ProjectShareDialog({ projectId }: { projectId: string }): JSX.Element {
  const project = useStore((s) => s.sessionProjects.find((p) => p.id === projectId))
  const connection = useStore((s) => s.projectSync.find((c) => c.projectId === projectId))
  const loadError = useStore((s) => s.projectSyncError)
  const [account, setAccount] = useState('')
  const [mode, setMode] = useState<'create' | 'join'>('create')
  const [repository, setRepository] = useState(() => `workbench-${project?.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-') ?? 'project'}`)
  const [username, setUsername] = useState('')
  const [preview, setPreview] = useState<SyncPreview | null>(null)
  const [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)
  const close = (): void => { if (!pending.current) useStore.getState().setOverlay({ kind: 'none' }) }
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(null); setMessage('')
    try { await work(); useStore.getState().applyState(await api.getState()) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { pending.current = false; setBusy(false) }
  }
  useEffect(() => {
    let alive = true
    void api.projectSyncAccount().then((name) => { if (alive) setAccount(name) }).catch((err) => { if (alive) setError(String(err)) })
    return () => { alive = false }
  }, [])
  if (!project) return <></>
  return <div className="overlay" onMouseDown={close}><div className="modal project-share" style={{ width: 620, maxHeight: '90vh' }} onMouseDown={(e) => e.stopPropagation()}>
    <div className="modal__head">Share {project.name}</div>
    <div className="modal__body" style={{ overflowY: 'auto' }}>
      <p>Automatically sync saved project files through a private GitHub repository while Workbench is open. Each person keeps their own local folder.</p>
      <p className="field__hint">GitHub account: {account || 'Checking…'} · Terminals and agent permissions stay on this computer.</p>
      {loadError && <p className="field__hint--error">{loadError}</p>}
      {error && <p role="alert" className="field__hint--error">{error}</p>}
      {message && <p role="status">{message}</p>}
      {connection ? <>
        <div className="field"><span className="field__label">Shared repository</span><code>https://github.com/{connection.repository}</code>
          <span className="field__hint">{connection.status === 'idle' ? 'Up to date' : connection.status} {connection.lastSyncAt ? `· Last synced ${new Date(connection.lastSyncAt).toLocaleTimeString()}` : ''}</span>
          {connection.error && <span role="alert" className="field__hint--error">{connection.error}</span>}
        </div>
        <div className="field__row"><button className="btn" disabled={busy || !connection.enabled || connection.status === 'syncing'} onClick={() => void run(() => api.projectSyncNow(projectId))}>Sync now</button>
          <button className="btn" disabled={busy} onClick={() => void run(() => api.projectSyncPause(projectId, !connection.enabled))}>{connection.enabled ? 'Pause sync' : 'Resume sync'}</button>
        </div>
        {!!connection.conflicts.length && <div className="field"><span className="field__label">Choose which saved version to keep</span>
          <p className="field__hint">Both people changed these files. Replaced local files are backed up on this computer. “Use shared” uses the latest shared version.</p>
          {connection.conflicts.map((conflict) => <div key={conflict.path} className="sync-conflict"><code>{conflict.path}</code>
            <span>{conflict.localDeleted ? 'Deleted locally' : 'Edited locally'} · {conflict.remoteDeleted ? 'Deleted remotely' : 'Edited remotely'}</span>
            <button className="btn" disabled={busy || !connection.enabled} onClick={() => void run(() => api.projectSyncResolve(projectId, conflict.path, 'local'))}>Keep mine</button>
            <button className="btn" disabled={busy || !connection.enabled} onClick={() => void run(() => api.projectSyncResolve(projectId, conflict.path, 'shared'))}>Use shared</button>
          </div>)}
        </div>}
        <div className="field"><label className="field__label" htmlFor="sync-invite">Invite a friend by GitHub username</label>
          <div className="field__row"><input id="sync-invite" value={username} placeholder="GitHub username" onChange={(e) => setUsername(e.target.value)} />
            <button className="btn" disabled={busy || !username.trim()} onClick={() => void run(async () => { await api.projectSyncInvite(projectId, username.trim()); setMessage(`Invitation sent to ${username.trim()}. They need to accept it on GitHub.`); setUsername('') })}>Send invitation</button></div>
          <p className="field__hint">Your friend accepts the GitHub invitation, creates a Workbench project with an empty folder, then opens Share project → Join a shared project and enters the repository above.</p>
        </div>
        {disconnecting && <p>Disconnect this computer? Local files and the shared GitHub repository will be kept.</p>}
        <button className={`btn ${disconnecting ? 'btn--danger' : 'btn--ghost'}`} disabled={busy} onClick={() => {
          if (!disconnecting) return setDisconnecting(true)
          void run(async () => { await api.projectSyncDisconnect(projectId); setDisconnecting(false); setReviewed(false); setPreview(null) })
        }}>{disconnecting ? 'Confirm disconnect' : 'Disconnect this computer…'}</button>
      </> : <>
        <div className="field__row"><button className={`btn ${mode === 'create' ? 'btn--primary' : ''}`} disabled={busy} onClick={() => { setMode('create'); setReviewed(false) }}>Share this folder</button>
          <button className={`btn ${mode === 'join' ? 'btn--primary' : ''}`} disabled={busy} onClick={() => { setMode('join'); setReviewed(false); setRepository('') }}>Join a shared project</button></div>
        <div className="field"><span className="field__label">Local folder</span><code>{project.defaultCwd}</code></div>
        <div className="field"><label className="field__label" htmlFor="sync-repository">{mode === 'create' ? 'New private repository name' : 'GitHub owner/repository or URL'}</label>
          <input id="sync-repository" value={repository} onChange={(e) => setRepository(e.target.value)} />
        </div>
        {mode === 'create' ? <>
          <p className="field__hint">Review the files before sharing. Workbench excludes Git history, dependencies, build output, common credentials, and Git-ignored files. Future eligible saved files will also sync automatically.</p>
          <button className="btn" disabled={busy} onClick={() => void run(async () => { setReviewed(false); setPreview(await api.projectSyncPreview(projectId)) })}>Review files to share</button>
          {preview && <><p>{preview.files.length} files · {(preview.bytes / 1024 / 1024).toFixed(1)} MB · {preview.excluded} excluded</p>
            <pre className="sync-filelist">{preview.files.join('\n') || 'Empty folder — future saved files will sync.'}</pre>
            <label className="field__row"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />Share these files and automatically sync future saved changes.</label></>}
        </> : <p className="field__hint">The local folder must be empty. Accept the repository invitation on GitHub first. Downloaded files will sync here, and your saved edits will sync back.</p>}
        <button className="btn btn--primary" disabled={busy || !account || !repository.trim() || (mode === 'create' && !reviewed) || !!loadError}
          onClick={() => void run(() => api.projectSyncConnect(projectId, mode, repository.trim()))}>{busy ? 'Connecting…' : mode === 'create' ? 'Create private share' : 'Join and start syncing'}</button>
      </>}
    </div><div className="modal__foot"><button className="btn" disabled={busy} onClick={close}>Close</button></div>
  </div></div>
}
