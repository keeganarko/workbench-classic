import { useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { performUpdateAction } from '../lib/updateActions'

export function UpdateNotice(): JSX.Element | null {
  const update = useStore((s) => s.updates)
  if (!update) return null
  // Keep the entry visible before a release exists too. Hiding it until an
  // update is available makes a newly installed updater look like it is absent.
  const label = update.status === 'ready' ? 'Update ready' : update.status === 'downloading' ? 'Downloading update…'
    : update.status === 'available' ? 'Update available' : 'Updates'
  return <button className="update-notice" onClick={() => useStore.getState().setOverlay({ kind: 'settings', tab: 'updates' })}>
    <span aria-hidden="true">↓</span>{label}
  </button>
}

export function UpdatesPanel(): JSX.Element {
  const update = useStore((s) => s.updates)
  const sending = useStore((s) => s.composerSending)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: 'check' | 'download' | 'install'): Promise<void> => {
    if (pending) return
    setPending(true); setError(null)
    try {
      await performUpdateAction(action, window.term, () => useStore.getState())
    } catch (e) { setError((e as Error).message) }
    finally { setPending(false) }
  }
  if (!update) return <p className="field__hint">Update information is loading…</p>
  const busy = pending || ['checking', 'downloading', 'installing'].includes(update.status)
  const platform = update.platform === 'darwin' ? 'macOS' : update.platform === 'win32' ? 'Windows' : 'Linux'
  const processor = update.arch === 'arm64' ? update.platform === 'darwin' ? 'Apple silicon' : 'ARM64' : update.platform === 'darwin' ? 'Intel' : 'Intel / AMD'
  const title = { idle: 'Keep Workbench up to date', checking: 'Checking for updates…', current: 'You’re up to date',
    available: 'A new Beta is available', downloading: 'Downloading your update…', ready: 'Your update is ready',
    installing: 'Saving and restarting…', unsupported: 'Update information', error: 'The update needs another try' }[update.status]
  return <section className="updates-panel" aria-label="Workbench updates">
    <div className="updates-panel__heading"><span className="updates-panel__symbol" aria-hidden="true">↓</span>
      <div><h2>{title}</h2><p>{update.version ? `Workbench ${update.version}` : `Workbench ${update.currentVersion}`}</p></div><span className="updates-panel__channel">Beta</span></div>
    <dl className="updates-panel__facts"><div><dt>Installed</dt><dd>{update.currentVersion}</dd></div><div><dt>This computer</dt><dd>{platform} · {processor}</dd></div><div><dt>Update channel</dt><dd>Beta</dd></div></dl>
    {update.notes && <div className="updates-panel__notes"><h3>What’s new</h3><p>{update.notes}</p></div>}
    {update.status === 'downloading' && <div aria-live="polite"><progress max={100} {...(update.progress === null ? {} : { value: update.progress })} /><p className="field__hint">{update.progress === null ? 'Downloading and verifying…' : `${update.progress}% downloaded`}</p></div>}
    <p className="field__hint">Workbench checks published Beta releases when it opens and every four hours. Choose Update and restart to download, verify, install, and reopen Workbench. Your computer selects the right installer automatically.</p>
    {update.installMode === 'manual' && ['available', 'ready', 'downloading'].includes(update.status) && <p className="updates-panel__manual">This installation cannot be replaced automatically (for example, its signing identity or location differs). After downloading, show it in {update.platform === 'darwin' ? 'Finder' : 'Explorer'}, finish active agent sessions, quit Workbench, then run the installer. Your projects stay on this computer.</p>}
    {update.installMode === 'restart' && update.status === 'ready' && <p className="field__hint">Restart saves your layout and unsent prompt. Terminals keep running in tmux and reconnect when Workbench opens.</p>}
    {(error || update.error) && <p className="field__hint field__hint--error" role="alert">{error ?? update.error}</p>}
    <div className="updates-panel__actions">
      <button className="btn btn--ghost" disabled={busy || ['ready', 'installing'].includes(update.status)} onClick={() => void run('check')}>Check for updates</button>
      {update.status === 'available' && <button className="btn btn--primary" disabled={busy || sending} onClick={() => void run('download')}>{update.installMode === 'restart' ? 'Update and restart' : 'Download installer'}</button>}
      {update.status === 'ready' && <button className="btn btn--primary" disabled={busy || (sending && update.installMode === 'restart')} onClick={() => void run('install')}>{update.installMode === 'restart' ? 'Restart to update' : 'Show installer'}</button>}
    </div>
    {sending && ['available', 'ready'].includes(update.status) && <p className="field__hint">Your prompt is still sending. Restart is available when it finishes.</p>}
    <p className="field__hint">{update.checkedAt ? `Last checked ${new Date(update.checkedAt).toLocaleString()}` : 'No update check yet.'}</p>
  </section>
}
