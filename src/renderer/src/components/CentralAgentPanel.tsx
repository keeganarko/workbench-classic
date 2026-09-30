import { useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { actions } from '../lib/actions'
import { focusStatus, focusText, FOCUS_STATUS } from '../../../shared/focusJournal'
import { taskText } from '../../../shared/sessionTitle'
import type { Session } from '../../../shared/types'
import { Icon } from './Icon'

const api = window.term
function saved(key: string): string { try { return localStorage.getItem(key) ?? '' } catch { return '' } }
function remember(key: string, value: string): void { try { localStorage.setItem(key, value) } catch { /* optional local preference */ } }

/** This is a human composer bound to one explicitly selected central session.
 * Worker creation and instructions belong to that agent's authenticated bus,
 * not a renderer broadcast. Its latest saved reply comes from the same pushed
 * session snapshot as the terminal list: no transcript reader or model call. */
export function CentralAgentPanel({ onOverview }: { onOverview: () => void }): JSX.Element {
  const sessions = useStore(s => s.sessions)
  const archived = useStore(s => s.experience.archivedIds)
  const enabled = useStore(s => s.prefs.busEnabled === true)
  const profiles = useStore(s => s.profiles)
  const [chosen, setChosen] = useState(() => saved('workbench.centralAgent'))
  const managers = sessions.filter(s => s.bus === 'app-manager' && s.busProjectId === null && s.agent !== 'shell' && !archived.includes(s.id))
  const central = managers.find(s => s.id === chosen) ?? (managers.length === 1 ? managers[0] : undefined)
  const setup = (): void => useStore.getState().setOverlay({ kind: 'bus' })

  return <section className="focus-central" aria-label="Central agent">
    <div className="focus-central-heading"><button className="focus-central-identity" onClick={onOverview} title="Show all project previews" aria-label="Show all project previews"><span className="focus-central-avatar" aria-hidden="true"><svg viewBox="0 0 64 64"><path d="M10 48L32 58L54 48V27L32 16L10 27Z" fill="#a8bfc2"/><path d="M32 36L54 27V48L32 58Z" fill="#6d949c"/><path d="M22 8H42V29H22Z" fill="#f2d9aa"/><path d="M26 17H29M35 17H38M28 24H36" stroke="#40565d" strokeWidth="2"/><path d="M16 40H25M39 40H48" stroke="#eff1dd" strokeWidth="3"/></svg></span><span><span className="focus-kicker">YOUR ONE POINT OF CONTACT</span><h3>{central?.title ?? 'Choose your central agent'}</h3><small>Click for project previews</small></span></button>
      <button className="px-button focus-central-access" onClick={setup}><Icon name="permissions" size={13} />{central ? 'Permissions' : 'Set up App Manager'}</button></div>
    {!central && <p>Choose one terminal in Permissions and grant it App Manager. It can create and direct workers inside every project.</p>}
    {managers.length > 1 && <label className="focus-central-picker">Central agent
      <select value={central?.id ?? ''} onChange={e => { setChosen(e.target.value); remember('workbench.centralAgent', e.target.value) }}>
        <option value="" disabled>Choose an App Manager</option>{managers.map(s => <option key={s.id} value={s.id}>{s.title} · {s.id.slice(0, 5)}</option>)}
      </select></label>}
    {!central && <button className="focus-textbutton" onClick={() => {
      const agent = profiles.find(p => p.available && p.id === 'codex')?.id ?? profiles.find(p => p.available && p.id !== 'shell')?.id ?? 'shell'
      actions.openNewSession(agent)
    }}>Start a fresh terminal</button>}
    {central && <CentralChat key={central.id} session={central} enabled={enabled} />}
    {!enabled && <p className="focus-central-notice">Agent communication is off. Enable it in Permissions so your central agent can direct workers.</p>}
  </section>
}

function CentralChat({ session, enabled }: { session: Session; enabled: boolean }): JSX.Element {
  const draftKey = `workbench.centralDraft.${session.id}`
  const [draft, setDraft] = useState(() => saved(draftKey))
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState('')
  const status = focusStatus(session)
  const reply = focusText(taskText(session.lastMessage ?? ''), 1200)
  const send = async (): Promise<void> => {
    const body = draft.trim()
    if (!body || sending || !session.alive || !enabled) return
    setSending(true); setNotice('')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Keep the draft until there is a receipt for exactly this recipient.
      // A slow/failed send is not an invitation to fan out or retry silently.
      const results = await Promise.race([
        api.sendPrompt([session.id], body),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Delivery is taking longer than expected.')), 20000) })
      ])
      const receipt = results.find(r => r.sessionId === session.id)
      if (!receipt?.ok) throw new Error(receipt?.error ?? 'No delivery receipt received.')
      setDraft(current => {
        if (current !== draft) return current
        remember(draftKey, ''); return ''
      })
      setNotice('Sent to your central agent.')
    } catch (error) { setNotice(`Not confirmed: ${(error as Error).message} Your draft is saved; check the terminal before retrying.`) }
    finally { if (timer) clearTimeout(timer); setSending(false) }
  }
  return <>
    <div className="focus-central-status"><span><i className={`dot dot--${status}`} />{FOCUS_STATUS[status].label} · All projects</span>
      <button className="focus-textbutton" onClick={() => useStore.getState().revealSession(session.id)}>Open conversation <Icon name="external" size={12} /></button></div>
    {reply && <div className="focus-central-reply"><small>Latest saved reply</small><p>{reply}</p></div>}
    <label className="focus-central-input"><span>What should we work on?</span><textarea rows={3} maxLength={100000} value={draft}
      placeholder="Tell your central agent. It will coordinate the right workers."
      onChange={e => { setDraft(e.target.value); remember(draftKey, e.target.value) }}
      onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send() } }} /></label>
    <div className="focus-central-send"><span role="status">{notice || (session.alive ? 'One conversation, across all your projects.' : 'Open the stopped central terminal to restart it.')}</span>
      <button className="px-button px-primary" disabled={!enabled || !session.alive || !draft.trim() || sending} onClick={() => void send()}>{sending ? 'Sending…' : 'Send to central agent'}<Icon name="chevron" size={13} /></button></div>
  </>
}
