import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { FolderHint } from './ExperienceViews'
import { readProjectAppearance } from '../../../shared/projectAppearance'
import { ProjectDesignEditor } from './ProjectDesignEditor'

const api = window.term

/** Keeps project details and design in one draft until the user saves them. */
export function ProjectDialog({ projectId, confirmDelete: deleting = false }: { projectId?: string; confirmDelete?: boolean }): JSX.Element {
  const project = useStore((s) => s.sessionProjects.find((item) => item.id === projectId))
  const prefs = useStore((s) => s.prefs)
  const [name, setName] = useState(project?.name ?? '')
  const [cwd, setCwd] = useState(project?.defaultCwd ?? prefs.defaultCwd)
  const [appearance, setAppearance] = useState(() => readProjectAppearance(project?.appearance))
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(deleting)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const folderTouched = useRef(false)

  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    if (project) return
    let active = true
    void api.defaultProjectFolder().then((folder) => { if (active && !folderTouched.current) setCwd(folder) }).catch(() => { /* existing preference remains usable */ })
    return () => { active = false }
  }, [project])

  const close = (): void => { if (!busy) useStore.getState().setOverlay({ kind: 'none' }) }
  const commit = async (): Promise<void> => {
    const clean = name.trim()
    if (!clean || busy) return
    setBusy(true)
    setError(null)
    try {
      if (project) {
        const updated = await api.renameProject(project.id, clean, cwd.trim() || prefs.defaultCwd, appearance)
        // Reflect the saved identity immediately; the normal state push still
        // reconciles the rest of the workspace after the main process commits.
        useStore.setState((s) => ({ sessionProjects: s.sessionProjects.map((p) => p.id === updated.id ? updated : p) }))
      }
      else {
        const created = await api.createProject(clean, cwd.trim() || prefs.defaultCwd, appearance)
        // The IPC reply can arrive before the debounced state push. Navigation
        // needs the new project's identity before it creates its workspace.
        useStore.getState().applyState(await api.getState())
        useStore.getState().openProject(created.id)
      }
      close()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="overlay project-dialog-overlay" onMouseDown={close}>
      <div className="modal project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title"
        onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); close() }
          if (e.key !== 'Tab') return
          const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'))
          const first = controls[0], last = controls[controls.length - 1]
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }}>
        <div className="modal__head" id="project-dialog-title">{confirmDelete ? 'Delete project?' : project ? 'Edit project' : 'New project'}</div>
        <div className="modal__body">
          {confirmDelete && <p>Remove {project?.name} from Workbench? Its folders and terminals will be kept. Terminals will move to All terminals.</p>}
          {!confirmDelete && <fieldset className="project-dialog-fields" disabled={busy}>
          <div className="field">
            <label className="field__label" htmlFor="project-name">Name</label>
            <input
              id="project-name"
              ref={input}
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit()
              }}
              placeholder="Mission Control"
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="project-folder">Default working folder</label>
            <div className="field__row">
              <input
                id="project-folder"
                className="mono"
                style={{ flex: 1 }}
                value={cwd}
                onChange={(e) => { folderTouched.current = true; setCwd(e.target.value) }}
              />
              <button
                className="btn btn--ghost"
                style={{ flex: '0 0 auto' }}
                onClick={async () => {
                  try {
                    const picked = await api.pickFolder(cwd)
                    if (picked) { folderTouched.current = true; setCwd(picked) }
                  } catch (err) { setError((err as Error).message) }
                }}
              >
                Browse…
              </button>
            </div>
            <span className="field__hint">
              New terminals start here; they can still open another folder or worktree.
            </span>
            <FolderHint folder={cwd} />
          </div>
          <ProjectDesignEditor name={name} value={appearance} onChange={setAppearance} />
          </fieldset>}
          {error && <span className="field__hint field__hint--error" role="alert">{error}</span>}
        </div>
        <div className="modal__foot">
          {project && (
            <button
              className={`btn${confirmDelete ? ' btn--danger' : ' btn--ghost'}`}
              style={{ marginRight: 'auto' }}
              disabled={busy}
              onClick={async () => {
                if (!confirmDelete) return setConfirmDelete(true)
                setBusy(true)
                try {
                  await api.removeProject(project.id)
                  close()
                } catch (err) {
                  setError((err as Error).message)
                  setBusy(false)
                  setConfirmDelete(false)
                }
              }}
            >
              {confirmDelete ? 'Delete project; keep terminals' : 'Delete project…'}
            </button>
          )}
          <button className="btn btn--ghost" disabled={busy} autoFocus={confirmDelete} onClick={close}>
            Cancel
          </button>
          {!confirmDelete && <button className="btn btn--primary" disabled={!name.trim() || busy} onClick={() => void commit()}>
            {busy ? 'Saving…' : project ? 'Save changes' : 'Create project'}
          </button>}
        </div>
      </div>
    </div>
  )
}
