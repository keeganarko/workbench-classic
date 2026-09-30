import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { findFileReferences, replaceFileReference } from '../../../shared/dictation'
import type { FileReference, FlowStatus } from '../../../shared/dictation'
import '../styles/dictation.css'

const api = window.term
export function useFlowStatus(): { status: FlowStatus | null; refresh: () => void; checking: boolean } {
  const [status, setStatus] = useState<FlowStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    setChecking(true)
    api.flowStatus().then(value => { if (current) setStatus(value) }).catch(() => {
      if (current) setStatus({ platform: 'unsupported', installed: false, appName: null, shortcut: 'Your Flow shortcut', detail: 'Installation check unavailable. Open Flow yourself and paste your transcript.', autoTransform: null })
    }).finally(() => { if (current) setChecking(false) })
    return () => { current = false }
  }, [revision])
  return { status, checking, refresh: () => setRevision(value => value + 1) }
}
export async function launchFlow(): Promise<void> {
  try { await api.openFlow() }
  catch (error) { useStore.getState().setToast(error instanceof Error ? error.message : 'Could not open Flow', 'error') }
}
export function DictationPanel({ text, sessionId, onReplace, onFocus, onPaste, onClose }: {
  text: string; sessionId: string | null
  onReplace: (text: string) => void; onFocus: () => void
  onPaste: () => void; onClose: () => void
}): JSX.Element {
  const { status, checking } = useFlowStatus()
  const [finding, setFinding] = useState(false)
  const [references, setReferences] = useState<FileReference[]>([])
  const [note, setNote] = useState('')
  const current = useRef({ text, sessionId })
  current.current = { text, sessionId }
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setReferences([]); setNote('') }, [text, sessionId])
  const find = async (): Promise<void> => {
    if (!sessionId) return
    const snapshot = { text, sessionId }
    setFinding(true); setNote('')
    try {
      const listing = await api.dictationFiles(sessionId)
      // File discovery can finish after a new prompt or a different recipient
      // was selected. A stale range is never allowed to edit the current draft.
      if (!mounted.current || current.current.text !== snapshot.text || current.current.sessionId !== snapshot.sessionId) return
      const matches = findFileReferences(text, listing.files)
      setReferences(matches)
      setNote((matches.length ? 'Choose a file to insert its project path.' : 'No matching project filenames. Try “index dot tsx” or “tag composer”.') + (listing.truncated ? ' The folder scan reached its limit.' : ''))
    } catch (error) {
      if (mounted.current) setNote(error instanceof Error ? error.message : 'Could not find project files.')
    } finally { if (mounted.current) setFinding(false) }
  }
  return <section className="dictation-panel" aria-label="Wispr Flow dictation helper">
    <div className="dictation-panel__head">
      <strong>Wispr Flow</strong>
      <span className="dictation-panel__status">{checking ? 'Checking desktop…' : status?.installed ? 'Desktop app found' : 'Copy/paste available'}</span>
      <button className="btn btn--sm" onMouseDown={e => e.preventDefault()} onClick={onClose} aria-label="Close dictation helper">×</button>
    </div>
    <p>Focus the prompt, use <strong>{status?.shortcut || 'your Flow shortcut'}</strong>, then review and send.</p>
    {status?.platform === 'wsl' && <p className="dictation-panel__note">For this WSL window, use Flow’s Copy last transcript, then Paste transcript below. The native Windows app supports the direct-paste route.</p>}
    <div className="dictation-panel__actions">
      <button className="btn btn--sm" onClick={onFocus}>Focus prompt</button>
      <button className="btn btn--sm" disabled={!status?.installed} onClick={() => void launchFlow()}>Open Flow</button>
      <button className="btn btn--sm" onMouseDown={e => e.preventDefault()} onClick={onPaste}>Paste transcript</button>
      <button className="btn btn--sm" disabled={!sessionId || !text.trim() || finding} title={!sessionId ? 'Choose one prompt recipient to resolve its project files' : 'Match dictated filenames against this session’s folder'} onClick={() => void find()}>{finding ? 'Finding files…' : 'Find file references'}</button>
      <button className="btn btn--sm" onClick={() => useStore.getState().setOverlay({ kind: 'settings', tab: 'flow' })}>Setup</button>
    </div>
    {!sessionId && <p className="dictation-panel__note">Choose one recipient to resolve project filenames.</p>}
    <div aria-live="polite">
      {note && <p className="dictation-panel__note">{note}</p>}
      {references.map(reference => <div className="dictation-reference" key={reference.start + ':' + reference.end}>
        <span>“{reference.spoken}” {reference.files.length > 1 ? '— choose the intended file' : ''}</span>
        {reference.files.slice(0, 8).map(file => <button className="dictation-reference__file" key={file} title={'Use ' + file} onClick={() => {
          const next = replaceFileReference(current.current.text, reference, file)
          if (next !== null) { onReplace(next); onFocus() }
        }}>{file}</button>)}
        {reference.files.length > 8 && <span className="dictation-panel__note">More matches exist. Dictate or type a longer path.</span>}
      </div>)}
    </div>
    <p className="dictation-panel__note">File matching runs in Workbench after transcription. Paste transcript reads your current clipboard; it does not retrieve Flow history.</p>
  </section>
}
