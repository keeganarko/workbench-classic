import { useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { actions } from '../lib/actions'
import { launchFlow, useFlowStatus } from './DictationPanel'
import {
  FLOW_AUTO_APPLY_MENU,
  PROMPT_ENGINEER,
  SCREEN_READER_COMMAND,
  SCREEN_READER_INDICATOR,
  VARIABLE_RECOGNITION_STEPS,
  promptEngineerState
} from '../../../shared/flowContext'
import { accel } from '../lib/ui'
import '../styles/dictation.css'

const api = window.term
export function FlowSettings(): JSX.Element {
  const { status, refresh, checking } = useFlowStatus()
  const enabled = useStore(s => s.prefs.terminalAccessibility !== false)
  const [setupOpen, setSetupOpen] = useState(false)
  const transform = promptEngineerState(status?.autoTransform ?? null)
  const prepare = async (): Promise<void> => {
    try {
      await api.setPrefs({ terminalAccessibility: true })
      useStore.getState().setOverlay({ kind: 'none' })
      useStore.getState().focusDictation()
    } catch (error) {
      useStore.getState().setToast(error instanceof Error ? error.message : 'Could not prepare dictation', 'error')
    }
  }
  return <section className="flow-settings" aria-label="Wispr Flow integration">
    <h3>Dictate with Wispr Flow</h3>
    <p>Use the Flow app you already have. Workbench accepts its text in the prompt and terminal, and helps turn spoken filenames into project references.</p>
    <div className="flow-settings__status" role="status">
      <strong>{checking ? 'Checking for Flow…' : status?.installed ? 'Wispr Flow installation found' : 'Manual setup available'}</strong>
      <span>{status?.detail}</span>
    </div>
    <ol>
      <li>Open Flow and choose your dictation shortcut in its settings.</li>
      <li>Click <strong>Prepare prompt</strong> below, then use <strong>{status?.shortcut || 'your Flow shortcut'}</strong>.</li>
      <li>Review the draft. Use <strong>Find file references</strong> for spoken filenames, then send.</li>
    </ol>
    <div className="dictation-panel__actions">
      <button className="btn btn--primary" onClick={() => void prepare()}>Prepare prompt</button>
      <button className="btn" disabled={!status?.installed || checking} onClick={() => void launchFlow()}>Open Flow</button>
      <button className="btn" disabled={checking} onClick={refresh}>Check again</button>
    </div>
    <label className="flow-settings__toggle">
      <input type="checkbox" checked={enabled} onChange={event => {
        void api.setPrefs({ terminalAccessibility: event.target.checked }).catch(() => useStore.getState().setToast('Could not save accessibility setting', 'error'))
      }} />
      Expose terminal text for accessibility and dictation
    </label>
    <p className="dictation-panel__note">Enabled immediately for existing terminals. Flow’s own microphone and accessibility permissions are managed in the operating system.</p>

    <h3>Vibe coding</h3>
    <p>Flow’s Vibe coding page sets up variable recognition for Cursor, VS Code and Windsurf. Workbench follows the same steps with the same names, so what you did there works here.</p>
    <div className="flow-settings__card">
      <div className="flow-settings__card-head">
        <div>
          <strong>Variable recognition</strong>
          <span>{enabled ? `${SCREEN_READER_INDICATOR} — terminal text and the prompt are readable by Flow.` : 'Screen reader mode is off, so Flow only sees the prompt box.'}</span>
        </div>
        <button className="btn btn--sm" onClick={() => setSetupOpen(open => !open)}>{setupOpen ? 'Hide' : 'Set up'}</button>
      </div>
      {setupOpen && <div className="flow-settings__setup">
        <strong>Set up variable recognition</strong>
        <p>Variable recognition reads your open terminal to better understand code as you dictate. It requires Screen Reader mode to be enabled in Workbench.</p>
        <p className="flow-settings__setup-label">In Workbench:</p>
        <ol>
          <li>{VARIABLE_RECOGNITION_STEPS[0]} <kbd>{accel('CmdOrCtrl+K')}</kbd></li>
          <li>Search for and run <code>{SCREEN_READER_COMMAND}</code></li>
          <li>Confirm the <code>{SCREEN_READER_INDICATOR}</code> flag appears in the bottom bar</li>
        </ol>
        <div className="dictation-panel__actions">
          <button className="btn btn--primary" onClick={() => actions.toggleScreenReaderMode()}>{enabled ? 'Turn screen reader mode off' : 'Turn screen reader mode on'}</button>
        </div>
        <p className="dictation-panel__note">Flow reads Workbench through the accessibility tree, the way it reads any app. Its IDE-only file list and automatic <code>@file</code> tagging stay with Cursor and Windsurf; use <strong>Find file references</strong> here instead.</p>
      </div>}
    </div>
    <div className="flow-settings__card">
      <div className="flow-settings__card-head">
        <div>
          <strong>File tagging</strong>
          <span>Say a filename, then use <strong>Find file references</strong> in the prompt. Matches from this project become references before you send.</span>
        </div>
      </div>
    </div>

    <h3>{PROMPT_ENGINEER} on every dictation</h3>
    <div className="flow-settings__status" role="status">
      <strong>{checking ? 'Reading Flow’s setting…' :
        transform === 'on' ? `${PROMPT_ENGINEER} is applied to every dictation` :
        transform === 'other' ? `Flow auto-applies “${status?.autoTransform?.promptName ?? ''}”, not ${PROMPT_ENGINEER}` :
        transform === 'off' ? 'Auto-apply is off in Flow' : 'Flow’s setting could not be read'}</strong>
      <span>{transform === 'on' ? 'Flow rewrites what you say into a structured prompt before pasting it — in Workbench and in every other app, because the setting is global in Flow.' :
        transform === 'other' ? `Pick ${PROMPT_ENGINEER} in the menu below to rewrite dictations into prompts instead.` :
        transform === 'off' ? 'Dictations paste as spoken. Flow’s Prompt Engineer shortcut still rewrites the last one on demand.' :
        'Workbench reads this from Flow’s saved settings when Flow is installed on this desktop. Flow owns the setting; Workbench never changes it.'}</span>
    </div>
    <ol>
      <li>Open the menu on the Flow bar (the chevron, or right-click the bar) and choose <strong>{FLOW_AUTO_APPLY_MENU}</strong>.</li>
      <li>Select <strong>{PROMPT_ENGINEER}</strong>. Use <strong>Configure transforms</strong> there to edit the prompt Flow applies.</li>
      <li>Click <strong>Check again</strong> above. The status here reflects what Flow saved.</li>
    </ol>

    <details>
      <summary>If text does not arrive</summary>
      <p>In Flow, use Copy last transcript. Return to Workbench and choose Paste transcript. Existing text and your selected insertion point are preserved. On WSLg, use this clipboard route or switch to the native Windows Workbench build.</p>
      <p>Flow’s shortcut can be customized, so Workbench displays its usual default and leaves recording control with Flow.</p>
    </details>
    <details>
      <summary>How this compares with Cursor and Windsurf</summary>
      <p>Desktop dictation, terminal accessibility, and project-file matching are available through Workbench’s own controls. Wispr’s automatic IDE tagging and code-symbol recognition still depend on Wispr recognizing the application. This integration does not impersonate another editor.</p>
      <p>Wispr also offers a separately billed transcription API. This integration uses your desktop app and does not require an API key. No account is connected to Workbench.</p>
      <button className="btn btn--sm" onClick={() => void api.openExternal('https://docs.wisprflow.ai/articles/6434410694-use-flow-with-cursor-vs-code-and-other-ides')}>Wispr integration documentation</button>
    </details>
  </section>
}
