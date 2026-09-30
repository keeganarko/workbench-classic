import { UpdatesPanel } from './UpdatesPanel'
import { FlowSettings } from './FlowSettings'
import { useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { shortPath } from '../lib/ui'
import { AGENT_PRESETS, slugifyAgentId } from '../../../shared/agents'
import type { CustomAgent } from '../../../shared/agents'
import type { AgentProfile, Prefs, TriggerRule, Workspace } from '../../../shared/types'

const api = window.term

export function SettingsDialog({ initialTab = 'general' }: { initialTab?: 'general' | 'updates' | 'flow' }): JSX.Element {
  const prefs = useStore((s) => s.prefs)
  const env = useStore((s) => s.env)
  const profiles = useStore((s) => s.profiles)
  const [tab, setTab] = useState<
    'general' | 'terminal' | 'flow' | 'agents' | 'triggers' | 'worktrees' | 'env' | 'updates'
  >(initialTab)

  const set = (patch: Partial<Prefs>): void => {
    void api.setPrefs(patch)
  }

  return (
    <div className="overlay" onMouseDown={() => useStore.getState().setOverlay({ kind: 'none' })}>
      <div className="modal" style={{ width: 620 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__head">Settings</div>
        <div className="modal__body">
          <div className="segmented segmented--wrap">
            {(['general', 'terminal', 'flow', 'agents', 'triggers', 'worktrees', 'env', 'updates'] as const).map((t) => (
              <button
                key={t}
                className={`segmented__opt${tab === t ? ' segmented__opt--on' : ''}`}
                onClick={() => setTab(t)}
              >
                {t === 'env' ? 'Environment' : t === 'flow' ? 'Wispr Flow' : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {tab === 'updates' && <UpdatesPanel />}
          {tab === 'flow' && <FlowSettings />}

          {tab === 'general' && (
            <>
              <Toggle
                label="Notify me when a session is waiting on my response"
                checked={prefs.notifyOnWaiting}
                onChange={(v) => set({ notifyOnWaiting: v })}
              />
              <Toggle
                label="Notify me when a session finishes"
                checked={prefs.notifyOnDone}
                onChange={(v) => set({ notifyOnDone: v })}
              />
              <Toggle
                label="Only notify when Workbench is in the background"
                checked={prefs.notifyOnlyWhenUnfocused}
                onChange={(v) => set({ notifyOnlyWhenUnfocused: v })}
              />
              <Toggle
                label="Play a sound with notifications"
                checked={prefs.notifySound}
                onChange={(v) => set({ notifySound: v })}
              />
              <Toggle
                label="Keep the sidebar pinned"
                checked={prefs.sidebarPinned}
                onChange={(v) => set({ sidebarPinned: v, sidebarVisible: true })}
              />
              <Toggle
                label="Open the preview pane when a session produces a document"
                checked={prefs.previewAutoShow}
                onChange={(v) => set({ previewAutoShow: v })}
              />
              <Toggle
                label="Re-render the previewed file when it changes on disk"
                checked={prefs.previewFollowFile}
                onChange={(v) => set({ previewFollowFile: v })}
              />
              <div className="field">
                <span className="field__label">Default working folder</span>
                <div className="field__row">
                  <input
                    className="mono"
                    style={{ flex: 1 }}
                    value={prefs.defaultCwd}
                    onChange={(e) => set({ defaultCwd: e.target.value })}
                  />
                  <button
                    className="btn btn--ghost"
                    style={{ flex: '0 0 auto' }}
                    onClick={async () => {
                      const p = await api.pickFolder(prefs.defaultCwd)
                      if (p) set({ defaultCwd: p })
                    }}
                  >
                    Browse…
                  </button>
                </div>
              </div>
              <div className="field">
                <span className="field__label">Global hotkey (show/hide Workbench)</span>
                <div className="field__row">
                  <input
                    className="mono"
                    style={{ flex: 1 }}
                    value={prefs.globalHotkey}
                    onChange={(e) => set({ globalHotkey: e.target.value })}
                    placeholder="Alt+Space"
                  />
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={prefs.hotkeyWindowEnabled}
                      onChange={(e) => set({ hotkeyWindowEnabled: e.target.checked })}
                    />
                    on
                  </label>
                </div>
                {/* A hotkey another app already owns fails silently at the OS
                    level. Saying so here is the difference between "broken app"
                    and "pick a different combination". */}
                {env?.hotkeyError ? (
                  <span className="field__hint field__hint--error">{env.hotkeyError}</span>
                ) : (
                  <span className="field__hint">
                    Electron accelerator syntax, e.g. <span className="kbd">Alt+Space</span> or{' '}
                    <span className="kbd">CommandOrControl+Shift+K</span>.
                  </span>
                )}
              </div>

              <div className="field">
                <span className="field__label">Default permission mode for new sessions</span>
                <select
                  value={prefs.defaultPermissionMode ?? 'default'}
                  onChange={(e) =>
                    set({ defaultPermissionMode: e.target.value as Prefs['defaultPermissionMode'] })
                  }
                >
                  <option value="default">Ask me every time</option>
                  <option value="auto">Auto-accept edits in the working folder</option>
                  <option value="full-access">Full access — skip all approvals</option>
                </select>
                <span className="field__hint">
                  Full access passes <span className="kbd">--dangerously-skip-permissions</span> to
                  Claude and{' '}
                  <span className="kbd">--dangerously-bypass-approvals-and-sandbox</span> to Codex.
                  The agent will run commands and edit files without asking. Set per session in the
                  new-session dialog; this only picks the default.
                </span>
              </div>
            </>
          )}

          {tab === 'terminal' && (
            <>
              <div className="field">
                <span className="field__label">Font family</span>
                <input
                  className="mono"
                  value={prefs.fontFamily}
                  onChange={(e) => set({ fontFamily: e.target.value })}
                />
              </div>
              <div className="field__row">
                <div className="field" style={{ flex: 1 }}>
                  <span className="field__label">Font size</span>
                  <input
                    type="number"
                    min={8}
                    max={24}
                    value={prefs.fontSize}
                    onChange={(e) => set({ fontSize: Number(e.target.value) })}
                  />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <span className="field__label">Line height</span>
                  <input
                    type="number"
                    step={0.05}
                    min={1}
                    max={2}
                    value={prefs.lineHeight}
                    onChange={(e) => set({ lineHeight: Number(e.target.value) })}
                  />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <span className="field__label">Scrollback</span>
                  <input
                    type="number"
                    step={1000}
                    min={1000}
                    value={prefs.scrollback}
                    onChange={(e) => set({ scrollback: Number(e.target.value) })}
                  />
                </div>
              </div>
              <Toggle
                label="Blinking cursor"
                checked={prefs.cursorBlink}
                onChange={(v) => set({ cursorBlink: v })}
              />
              <Toggle
                label="Terminal accessibility and dictation support"
                checked={prefs.terminalAccessibility !== false}
                onChange={(v) => set({ terminalAccessibility: v })}
              />
              <p className="field__hint">
                Exposes visible terminal text to accessibility tools. For Wispr Flow, focus the
                prompt composer and use your Flow shortcut. Long dictations can be reviewed
                before sending. Automatic IDE file tagging is controlled by Flow.
              </p>
              <Toggle
                label="Copy on select (iTerm2 behaviour)"
                checked={prefs.copyOnSelect}
                onChange={(v) => set({ copyOnSelect: v })}
              />
              <div className="field">
                <span className="field__label">Click to move the text cursor</span>
                <select
                  value={prefs.clickToMoveCursor ?? 'click'}
                  onChange={(e) =>
                    set({ clickToMoveCursor: e.target.value as Prefs['clickToMoveCursor'] })
                  }
                >
                  <option value="click">Any click</option>
                  <option value="alt">⌥-click only (iTerm2 behaviour)</option>
                  <option value="off">Off</option>
                </select>
                <span className="field__hint">
                  A terminal has no way to place a cursor, so a click is translated into the arrow
                  keys that cover the distance. Exact within the line you are on; across wrapped
                  lines it
                  counts the terminal grid, so a bordered composer can land a few characters out.
                  Drags, selections and apps that handle their own mouse input are left alone.
                </span>
              </div>
              <Toggle
                label="Broadcast keystrokes to every pane"
                checked={prefs.broadcastInput}
                onChange={(v) => set({ broadcastInput: v })}
              />
              <Toggle
                label="Log every session to disk (tmux pipe-pane)"
                checked={prefs.sessionLogging}
                onChange={(v) => set({ sessionLogging: v })}
              />
              <span className="field__hint">
                Logging also feeds the trigger rules — turning it off disables regex triggers for
                new sessions. Logs contain everything the agent printed, including anything it read
                from your files.
              </span>
              <div className="field__row">
                <div className="field" style={{ flex: 1 }}>
                  <span className="field__label">Rotate a session log above (MB)</span>
                  <input
                    type="number"
                    min={1}
                    max={2048}
                    value={prefs.sessionLogMaxMb ?? 25}
                    onChange={(e) => set({ sessionLogMaxMb: Number(e.target.value) })}
                  />
                </div>
                <button
                  className="btn btn--ghost"
                  style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}
                  onClick={async () => {
                    const n = await api.deleteLogs()
                    useStore
                      .getState()
                      .setToast(n === 0 ? 'No logs to delete.' : `Deleted ${n} log file(s).`, 'success')
                  }}
                >
                  Delete all session logs
                </button>
              </div>
            </>
          )}

          {tab === 'agents' && (
            <Agents
              profiles={profiles}
              custom={prefs.customAgents ?? []}
              onChange={(customAgents) => set({ customAgents })}
            />
          )}

          {tab === 'triggers' && (
            <Triggers
              triggers={prefs.triggers ?? []}
              onChange={(triggers) => set({ triggers })}
            />
          )}

          {tab === 'worktrees' && <Worktrees />}

          {tab === 'env' && (
            <>
              {profiles.map((p) => (
                <div className="field" key={p.id}>
                  <span className="field__label">{p.label}</span>
                  <span className="mono selectable">
                    {p.available ? `${p.command} — ${p.version ?? 'version unknown'}` : 'not found on PATH'}
                  </span>
                </div>
              ))}
              {env && (
                <>
                  <div className="field">
                    <span className="field__label">tmux</span>
                    <span className="mono selectable">
                      {env.tmux.available
                        ? `${env.tmux.version} · socket "${env.tmux.socket}"`
                        : 'not found on PATH'}
                    </span>
                    <span className="field__hint">
                      Attach from iTerm2 with{' '}
                      <span className="kbd">tmux -L {env.tmux.socket} attach -t &lt;name&gt;</span>
                    </span>
                  </div>
                  <div className="field">
                    <span className="field__label">Shell / Node</span>
                    <span className="mono selectable">
                      {env.shell} · node {env.node}
                    </span>
                  </div>
                  {/* A failed save means the layout on disk is stale. Silently
                      losing it on quit is the one outcome worth shouting about. */}
                  {env.storeError && (
                    <div className="field">
                      <span className="field__label">Saved state</span>
                      <span className="field__hint field__hint--error selectable">
                        {env.storeError}
                      </span>
                    </div>
                  )}
                </>
              )}
              <div className="field__row">
                <button className="btn btn--ghost" onClick={() => void api.openDataDir()}>
                  Open data folder
                </button>
                <button className="btn btn--ghost" onClick={() => void api.openHandoffDir()}>
                  Open handoffs
                </button>
              </div>
            </>
          )}
        </div>
        <div className="modal__foot">
          <button
            className="btn btn--primary"
            style={{ flex: '0 0 auto' }}
            onClick={() => useStore.getState().setOverlay({ kind: 'none' })}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The worktrees Workbench made, and the only place they can be deleted.
 *
 * Deliberately manual. A worktree holds work that exists nowhere else until it
 * is committed, so nothing here happens on a timer or as a side effect of
 * closing a session — you have to come and ask.
 */
function Worktrees(): JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const mine = workspaces.filter((w) => w.kind === 'worktree' && w.createdByApp)
  const [pending, setPending] = useState<Record<string, string>>({})

  const remove = async (ws: Workspace, force: boolean): Promise<void> => {
    try {
      const res = await api.removeWorkspace(ws.id, force)
      if (res.removed) {
        useStore.getState().setToast(`Removed ${ws.branch ?? ws.name}`, 'success')
        setPending((p) => {
          const next = { ...p }
          delete next[ws.id]
          return next
        })
      } else {
        // The refusal is the useful part — keep it on screen next to the
        // button that can override it.
        setPending((p) => ({ ...p, [ws.id]: res.reason ?? 'Could not remove it' }))
      }
    } catch (err) {
      setPending((p) => ({ ...p, [ws.id]: (err as Error).message }))
    }
  }

  if (mine.length === 0) {
    return (
      <div className="field">
        <span className="field__hint">
          No worktrees yet. Starting a session with “A new worktree” or “One each” creates one, and
          it will be listed here so you can delete it when you are done with it.
        </span>
      </div>
    )
  }

  return (
    <>
      {mine.map((ws) => {
        const users = sessions.filter((s) => s.workspaceId === ws.id)
        const warning = pending[ws.id]
        return (
          <div className="field" key={ws.id}>
            <span className="field__label">⎇ {ws.branch ?? ws.name}</span>
            <span className="mono selectable" style={{ fontSize: 11 }}>
              {shortPath(ws.path)}
            </span>
            <div className="field__row" style={{ marginTop: 4 }}>
              <span className="field__hint" style={{ flex: 1 }}>
                {users.length > 0
                  ? `In use by ${users.length} session${users.length === 1 ? '' : 's'}: ${users
                      .map((s) => s.title)
                      .join(', ')}`
                  : 'Not in use'}
              </span>
              <button
                className="btn btn--ghost"
                style={{ flex: '0 0 auto' }}
                onClick={() => void remove(ws, false)}
              >
                Remove
              </button>
            </div>
            {warning && (
              <div className="field__row" style={{ marginTop: 2 }}>
                <span className="field__hint field__hint--error" style={{ flex: 1 }}>
                  {warning}
                </span>
                {/* Only offered after a refusal, and only for the dirty case —
                    an imported worktree has no override at all. */}
                {/uncommitted/i.test(warning) && (
                  <button
                    className="btn btn--ghost"
                    style={{ flex: '0 0 auto' }}
                    onClick={() => void remove(ws, true)}
                  >
                    Delete it anyway
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
      <div className="field">
        <span className="field__hint">
          Removing a worktree deletes its files, never its branch — anything you committed there is
          still in the repository.
        </span>
      </div>
    </>
  )
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <label className="switch">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

/**
 * Agents this install knows about, and the place to add one.
 *
 * The built-ins are shown as facts, not settings: their command is found on
 * PATH and their capabilities are code, so there is nothing here to change. A
 * custom agent is the opposite — a name, a command, and a colour — and the list
 * of what it *cannot* do is printed next to it rather than left to be
 * discovered, because "why did my fork turn into a handoff" is a bad surprise.
 */
function Agents({
  profiles,
  custom,
  onChange
}: {
  profiles: AgentProfile[]
  custom: CustomAgent[]
  onChange: (next: CustomAgent[]) => void
}): JSX.Element {
  const [label, setLabel] = useState('')
  const [command, setCommand] = useState('')

  const add = (next: Omit<CustomAgent, 'id'>): void => {
    const id = slugifyAgentId(next.label)
    if (!id || profiles.some((p) => p.id === id)) return
    onChange([...custom, { ...next, id }])
    setLabel('')
    setCommand('')
  }

  const builtins = profiles.filter((p) => p.builtin)
  const taken = new Set(profiles.map((p) => p.id))

  return (
    <>
      <div className="field">
        <span className="field__label">Built in</span>
        <span className="field__hint">
          These three have hook bridges and transcript readers written for them, which is what
          gives them exact status, native fork, transcript export and a context figure.
        </span>
      </div>
      {builtins.map((p) => (
        <div className="agentrow" key={p.id}>
          <span className="agentrow__dot" style={{ background: p.color }} />
          <span className="agentrow__name">{p.label}</span>
          <span className="agentrow__meta mono">
            {p.available ? p.command : 'not found on PATH'}
          </span>
        </div>
      ))}

      <div className="field" style={{ marginTop: 14 }}>
        <span className="field__label">Your agents</span>
        <span className="field__hint">
          Any command that runs a coding assistant in a terminal. It launches in tmux, appears
          everywhere the built-ins appear, and takes broadcast prompts. Status comes from the
          text patterns on the Triggers tab — there is no resume, fork or transcript, because
          those need Workbench to know the CLI&rsquo;s own file formats.
        </span>
      </div>

      {custom.length === 0 && <span className="field__hint">None yet.</span>}
      {custom.map((c) => {
        const profile = profiles.find((p) => p.id === c.id)
        return (
          <div className="agentrow" key={c.id}>
            <span className="agentrow__dot" style={{ background: c.color }} />
            <span className="agentrow__name">{c.label}</span>
            <span className="agentrow__meta mono">
              {profile && !profile.available ? `${c.command} — not found on PATH` : c.command}
            </span>
            <button
              className="btn btn--ghost btn--tiny"
              onClick={() => onChange(custom.filter((x) => x.id !== c.id))}
              title="Remove this profile. Sessions it started keep running."
            >
              Remove
            </button>
          </div>
        )
      })}

      <div className="field" style={{ marginTop: 12 }}>
        <span className="field__label">Add one</span>
        <div className="row">
          <input
            className="input"
            placeholder="Name, e.g. Gemini CLI"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            className="input mono"
            placeholder="Command, e.g. gemini"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <button
            className="btn"
            disabled={!label.trim() || !command.trim()}
            onClick={() => add({ label: label.trim(), command: command.trim(), args: [], color: '#8b949e' })}
          >
            Add
          </button>
        </div>
        {/* Presets carry a command name and a colour and nothing else. A preset
            that guessed at another CLI's resume flag would be worse than none:
            a wrong resume flag starts a fresh conversation and looks like it
            worked. */}
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          {AGENT_PRESETS.filter((p) => !taken.has(slugifyAgentId(p.label))).map((p) => (
            <button key={p.command} className="chip" onClick={() => add(p)}>
              <span style={{ color: p.color }}>●</span> {p.label}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function Triggers({
  triggers,
  onChange
}: {
  triggers: TriggerRule[]
  onChange: (t: TriggerRule[]) => void
}): JSX.Element {
  const update = (id: string, patch: Partial<TriggerRule>): void =>
    onChange(triggers.map((t) => (t.id === id ? { ...t, ...patch } : t)))

  return (
    <>
      <span className="field__hint">
        iTerm2-style triggers: a regex that matches new output flips the session's status. These
        are the safety net behind the CLI hooks.
      </span>
      {triggers.map((t) => (
        <div className="field" key={t.id}>
          <div className="field__row">
            <label className="switch" style={{ flex: 1 }}>
              <input
                type="checkbox"
                checked={t.enabled}
                onChange={(e) => update(t.id, { enabled: e.target.checked })}
              />
              {t.name}
            </label>
            <select
              value={t.action}
              onChange={(e) => update(t.id, { action: e.target.value as TriggerRule['action'] })}
            >
              <option value="waiting">→ waiting</option>
              <option value="failed">→ failed</option>
              <option value="working">→ working</option>
              <option value="review">→ review</option>
              <option value="notify">→ notify</option>
            </select>
            <select
              value={t.agent}
              onChange={(e) => update(t.id, { agent: e.target.value as TriggerRule['agent'] })}
            >
              <option value="any">any</option>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="shell">shell</option>
            </select>
            <button
              className="btn btn--ghost"
              style={{ flex: '0 0 auto' }}
              title="Delete this trigger"
              onClick={() => onChange(triggers.filter((x) => x.id !== t.id))}
            >
              Remove
            </button>
          </div>
          <input
            className="mono"
            value={t.pattern}
            onChange={(e) => update(t.id, { pattern: e.target.value })}
          />
        </div>
      ))}
      <button
        className="btn btn--ghost"
        onClick={() =>
          onChange([
            ...triggers,
            {
              id: `t_${Math.random().toString(36).slice(2, 8)}`,
              name: 'New trigger',
              pattern: '',
              flags: 'i',
              agent: 'any',
              action: 'waiting',
              captureReason: true,
              enabled: false
            }
          ])
        }
      >
        Add trigger
      </button>
    </>
  )
}
