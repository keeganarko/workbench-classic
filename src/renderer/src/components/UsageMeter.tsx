/** Account allowance and actual local tokens have different units and scopes.
 * Keep the allowance visible beside each provider, with token details one click
 * away. In particular, a five-hour account window is not a terminal's lifetime.
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { activeSessionId } from '../lib/actions'
import { percentLeft, quotaExpired, quotaWindow, usageFreshness, untilReset } from '../../../shared/usage'
import { formatTokens, type ProviderTokens, type TokenCounts } from '../../../shared/usageTokens'
import type { AgentUsage, UsageWindow } from '../../../shared/types'
import '../styles/usage.css'

const api = window.term
const LABEL = { claude: 'Claude', codex: 'OpenAI' }

function Reading({ window: w, now, label }: { window: UsageWindow | null; now: number; label: string }): JSX.Element {
  const expired = quotaExpired(w, now)
  const left = w && !expired ? Math.floor(percentLeft(w)) : null
  return <span className="usage-meter__reading" title={expired ? 'Reset passed; waiting for a new provider reading' : w ? `${label}: ${left}% left` : `${label}: not reported by this account`}>
    <span>{label}</span>
    <span className={`usage-meter__mini${w && !expired ? ` is-${w.severity}` : ' is-unknown'}`}>
      <span style={{ width: `${left ?? 0}%` }} />
    </span>
    <strong>{left === null ? '—' : `${left}% left`}</strong>
  </span>
}

function LimitRow({ window: w, label, now }: { window: UsageWindow | null; label: string; now: number }): JSX.Element {
  const expired = quotaExpired(w, now)
  const left = w && !expired ? percentLeft(w) : null
  const reset = w ? untilReset(w.resetsAt, now) : null
  return <div className="usage-meter__limit">
    <div><span>{label}</span><strong>{expired ? 'Awaiting refresh' : left === null ? 'Not reported' : `${Math.floor(left)}% left`}</strong></div>
    <div className={`usage-meter__track${w && !expired ? ` is-${w.severity}` : ''}`}
      role={left === null ? undefined : 'meter'} aria-label={`${label} allowance remaining`}
      aria-valuemin={left === null ? undefined : 0} aria-valuemax={left === null ? undefined : 100} aria-valuenow={left ?? undefined}>
      <span style={{ width: `${left ?? 0}%` }} />
    </div>
    {w && <small title={w.resetsAt ? new Date(w.resetsAt).toLocaleString() : undefined}>
      {expired ? 'The previous reading has expired.' : `${Math.ceil(w.percentUsed)}% used${reset ? ` · Resets in ${reset}` : ''}`}
    </small>}
  </div>
}

function Tokens({ label, counts }: { label: string; counts: TokenCounts | null | undefined }): JSX.Element {
  const total = counts ? counts.input + counts.output : null
  return <div className="usage-meter__tokens">
    <div><span>{label}</span><strong title={total?.toLocaleString()}>{total === null ? 'Not recorded' : `${formatTokens(total)} tokens`}</strong></div>
    {counts && <small>{formatTokens(counts.input)} input · {formatTokens(counts.output)} output<br />
      Input includes {formatTokens(counts.cachedInput)} cache reads and {formatTokens(counts.cacheWriteInput)} cache writes.</small>}
  </div>
}

function Provider({ usage, tokens, sessionId, now }: { usage: AgentUsage; tokens?: ProviderTokens; sessionId: string | null; now: number }): JSX.Element {
  const freshness = usageFreshness(usage, now)
  const sessionWindow = quotaWindow(usage, 'session')
  const weekWindow = quotaWindow(usage, 'week')
  const sessionTokens = sessionId && tokens && Object.hasOwn(tokens.sessions, sessionId) ? tokens.sessions[sessionId] : null
  return <section className="usage-meter__provider">
    <header><strong>{LABEL[usage.agent]}</strong><span>{usage.agent === 'codex' ? 'Codex · ChatGPT plan' : 'Claude Code'}{usage.plan ? ` · ${usage.plan}` : ''}</span></header>
    <LimitRow window={sessionWindow} label="Session window · 5h" now={now} />
    <LimitRow window={weekWindow} label="Weekly allowance" now={now} />
    {usage.windows.filter((w) => w !== sessionWindow && w !== weekWindow).map((w, index) => <LimitRow key={`${w.label}-${index}`} window={w} label={w.label} now={now} />)}
    <p className={`usage-meter__hint${freshness.stale ? ' usage-meter__hint--stale' : ''}`}>{freshness.detail}</p>
    <Tokens label="Tokens · last 7 days" counts={tokens?.last7Days} />
    {sessionId && <Tokens label="Tokens · this terminal" counts={sessionTokens} />}
    {tokens?.partial && <p className="usage-meter__hint">Some local history could not be read; token totals are incomplete.</p>}
  </section>
}

export function UsageMeter(): JSX.Element {
  const usage = useStore((s) => s.usage)
  const sessions = useStore((s) => s.sessions)
  useStore((s) => s.tabs)
  useStore((s) => s.activeTabId)
  const focused = sessions.find((s) => s.id === activeSessionId())
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const onDown = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      const report = await api.refreshUsage()
      // The state broadcast is debounced in main. Apply the returned reading
      // immediately so Refresh cannot finish while still drawing the old values.
      useStore.setState({ usage: report })
      setNow(Date.now())
    }
    catch { useStore.getState().setToast('Could not refresh usage', 'error') }
    finally { setBusy(false) }
  }
  const agents = [usage.claude, usage.codex]
  return <div className="usage-meter" ref={root}>
    <button className="usage-meter__summary" ref={trigger} onClick={() => {
      setOpen(!open)
      if (!open && Date.now() - (usage.checkedAt ?? 0) >= 15_000) void refresh()
    }} aria-expanded={open} aria-controls="usage-meter-details" aria-label="Claude and OpenAI usage: session and weekly allowance, plus token totals">
      <span className="usage-meter__caption">Usage <small>remaining</small></span>
      {agents.map((agent) => {
        const freshness = usageFreshness(agent, now)
        return <span className="usage-meter__compact" key={agent.agent}>
        <span className="usage-meter__identity"><strong>{LABEL[agent.agent]}</strong><small title={freshness.detail} className={freshness.stale ? 'usage-meter__hint--stale' : undefined}>{freshness.label}</small></span>
        <Reading label="Session" window={quotaWindow(agent, 'session')} now={now} />
        <Reading label="Week" window={quotaWindow(agent, 'week')} now={now} />
      </span>})}
      <span className="usage-meter__details-label">{open ? 'Close' : 'Details'} {open ? '⌄' : '⌃'}</span>
    </button>
    {open && <div className="usage-meter__panel" ref={panel} tabIndex={-1} id="usage-meter-details" role="dialog" aria-label="Claude and OpenAI usage">
      <div className="usage-meter__head"><strong>Usage & allowance</strong><button onClick={() => void refresh()} disabled={busy}>{busy ? 'Checking…' : 'Refresh'}</button>
        <button aria-label="Close usage details" onClick={() => { setOpen(false); trigger.current?.focus() }}>×</button></div>
      <div className="usage-meter__providers">{agents.map((agent) => <Provider key={agent.agent} usage={agent} tokens={usage.tokens?.[agent.agent]} sessionId={focused?.agent === agent.agent ? focused.agentSessionId : null} now={now} />)}</div>
      <p className="usage-meter__note">Session means the account’s 5-hour window. Remaining allowance is reported as a percentage; the providers do not expose a fixed number of tokens left. Missing limits stay “Not reported”.</p>
      <p className="usage-meter__note">Token totals come from local Claude Code and Codex history, including cached input. They exclude web chats and other computers. “Last 7 days” is a rolling local total, separate from your account’s weekly reset. Tokens refresh every 15 seconds; account limits every 90 seconds. Cached readings are labeled while a provider check is unavailable.</p>
    </div>}
  </div>
}
