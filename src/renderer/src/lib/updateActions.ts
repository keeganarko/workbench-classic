import { saveComposerWorkspace, type ComposerWorkspace } from './updateWorkspace'
import type { UpdateState } from '../../../shared/updates'
import type { Tab } from '../../../shared/types'

interface UpdateWorkspace extends ComposerWorkspace {
  composerSending: boolean
  tabs: Tab[]
  activeTabId: string | null
}
interface UpdateActions {
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  getState(): Promise<{ updates?: UpdateState | null }>
  setTabs(tabs: Tab[], activeTabId: string | null): Promise<boolean>
}

/** One explicit Update and restart click owns the whole transaction. Main
 * finishes its verified download before the renderer asks for a fresh snapshot;
 * relying on a pushed React render can otherwise race and silently skip install.
 * Keep the selected version fixed, and capture the latest draft after saving
 * layout: typing or sending can continue across either asynchronous operation.
 * A failed checkpoint must leave the app open. */
export async function performUpdateAction(action: 'check' | 'download' | 'install', api: UpdateActions,
  workspace: () => UpdateWorkspace, checkpoint = saveComposerWorkspace): Promise<void> {
  if (action === 'check') { await api.checkForUpdates(); return }
  const selected = (await api.getState()).updates
  if (!selected?.version) throw new Error(selected?.error || 'Check for updates before downloading or installing.')
  const version = selected.version, installMode = selected.installMode
  if (installMode === 'restart' && workspace().composerSending) throw new Error('Wait until your prompt finishes sending before updating.')
  if (action === 'download') await api.downloadUpdate()
  const update = (await api.getState()).updates
  if (update?.status !== 'ready') throw new Error(update?.error || 'The update is not ready. Try downloading again.')
  if (update.version !== version || update.installMode !== installMode) throw new Error('The selected update changed. Check for updates and try again.')
  if (update.installMode === 'manual' && action === 'download') return
  if (update.installMode === 'restart') {
    const state = workspace()
    if (state.composerSending) throw new Error('Your update is downloaded. Wait until your prompt finishes sending, then choose Restart to update.')
    if (!await api.setTabs(state.tabs, state.activeTabId)) throw new Error('Workbench could not save your layout. The update is downloaded; try restarting again after resolving the storage error.')
    const latest = workspace()
    if (latest.composerSending) throw new Error('Your update is downloaded. Wait until your prompt finishes sending, then choose Restart to update.')
    checkpoint(latest)
  }
  await api.installUpdate()
}
