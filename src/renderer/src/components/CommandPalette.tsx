import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { actions, activeSessionId } from '../lib/actions'
import { preview } from '../lib/preview'
import { accel } from '../lib/ui'
import { byActivity } from '../../../shared/sessionOrder'
import { useLaunchableProfiles } from '../lib/agents'
import { LAYOUT_PRESETS } from '../lib/layout'
import type { ProjectScript } from '../../../shared/types'
import { sessionTaskSummary } from '../../../shared/sessionTitle'
import { SCREEN_READER_COMMAND } from '../../../shared/flowContext'

const api = window.term

interface Command {
  id: string
  label: string
  hint?: string
  description?: string
  run: () => void
}

export function CommandPalette(): JSX.Element {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const sessions = useStore((s) => s.sessions)
  const prefs = useStore((s) => s.prefs)
  const launchable = useLaunchableProfiles()

  useEffect(() => inputRef.current?.focus(), [])

  // The focused session's project scripts, fetched once when the palette
  // opens. They are commands like any other — the point of reading
  // `package.json` is that "run the dev server" stops being a thing you type.
  const [scripts, setScripts] = useState<ProjectScript[]>([])
  useEffect(() => {
    const id = activeSessionId()
    if (!id) return
    let live = true
    void api
      .projectScripts(id)
      .then((found) => live && setScripts(found))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  const commands = useMemo<Command[]>(() => {
    const st = useStore.getState()
    const close = (): void => st.setOverlay({ kind: 'none' })
    // The agents, and only the ones that are actually installed. Building these
    // from the registry rather than listing three literals is the point of the
    // registry: an agent the user added in Settings shows up here the moment
    // they add it, with no code that knows its name.
    const agents = launchable.filter((p) => p.id !== 'shell')
    const newSession: Command[] = agents.map((p, i) => ({
      id: `new-${p.id}`,
      label: `New ${p.label} session`,
      // Only the first two carry an accelerator, matching the menu bar — there
      // are two chords to give away, and they go to the first two agents.
      hint: i === 0 ? accel('CmdOrCtrl+N') : i === 1 ? accel('CmdOrCtrl+Shift+N') : undefined,
      run: () => actions.openNewSession(p.id)
    }))

    // One entry per possible destination, instead of "the other agent" — which
    // only meant something back when there were exactly two.
    const handoffs: Command[] = agents.map((p) => ({
      id: `handoff-${p.id}`,
      label: `Hand off this session to ${p.label}`,
      run: () => {
        const id = activeSessionId()
        const s = sessions.find((x) => x.id === id)
        if (!s) return st.setToast('Focus a session first.', 'error')
        if (s.agent === p.id) return st.setToast(`That session is already ${p.label}.`, 'error')
        void actions.fork({ sourceId: s.id, kind: 'child', targetAgent: p.id })
      }
    }))

    const base: Command[] = [
      ...newSession,
      {
        id: 'new-shell',
        label: 'New shell session',
        hint: accel('CmdOrCtrl+Alt+N'),
        run: () => actions.openNewSession('shell')
      },
      {
        id: 'fork-child',
        label: 'Fork: child session (inherits context)',
        hint: accel('CmdOrCtrl+Shift+F'),
        run: () => actions.openFork('child')
      },
      {
        id: 'fork-sibling',
        label: 'Fork: parallel session (same parent)',
        hint: accel('CmdOrCtrl+Alt+F'),
        run: () => actions.openFork('sibling')
      },
      {
        id: 'share-session',
        label: 'Share this session with someone…',
        run: () => {
          const id = activeSessionId()
          if (id) st.setOverlay({ kind: 'share', sessionId: id })
          else st.setToast('No session to share.')
        }
      },
      {
        id: 'context-shelf',
        label: 'Context shelf — save, reopen or send a conversation…',
        run: () => st.setOverlay({ kind: 'shelf' })
      },
      ...handoffs,
      {
        id: 'visual-pane',
        label: 'New visual pane',
        hint: accel('CmdOrCtrl+F'),
        run: () => void actions.openVisualPane()
      },
      { id: 'split-h', label: 'Split pane right', hint: accel('CmdOrCtrl+D'), run: () => st.split('h') },
      { id: 'split-v', label: 'Split pane down', hint: accel('CmdOrCtrl+Shift+D'), run: () => st.split('v') },
      { id: 'zoom', label: 'Zoom / unzoom pane', hint: accel('CmdOrCtrl+Shift+Return'), run: () => st.toggleZoom() },
      {
        id: 'close-pane',
        label: 'Close pane',
        hint: accel('CmdOrCtrl+W'),
        run: () => actions.closeActivePane()
      },
      { id: 'new-tab', label: 'New workspace tab', run: () => st.addTab() },
      { id: 'find', label: 'Find in scrollback', run: () => st.setFindOpen(true) },
      {
        id: 'switcher',
        label: 'Go to session…',
        hint: accel('CmdOrCtrl+Shift+P'),
        run: () => st.setOverlay({ kind: 'switcher' })
      },
      {
        id: 'attention',
        label: 'Go to next session needing you',
        hint: accel('CmdOrCtrl+Shift+A'),
        run: () => actions.gotoAttention()
      },
      {
        id: 'bus',
        label: 'Permissions — agent access…',
        description: 'Session Bus grants and activity across every project.',
        hint: accel('CmdOrCtrl+Alt+B'),
        run: () => st.setOverlay({ kind: 'bus' })
      },
      ...LAYOUT_PRESETS.map((preset) => ({
        id: `preset-${preset.key}`,
        label: `Arrange panes: ${preset.title}`,
        run: () => st.applyLayoutPreset(preset.key)
      })),
      {
        id: 'focus-composer',
        label: 'Focus prompt bar (broadcast a prompt)',
        hint: accel('CmdOrCtrl+L'),
        run: () => actions.focusComposer()
      },
      {
        id: 'dictate-prompt',
        label: 'Dictate prompt with Wispr Flow',
        run: () => st.focusDictation()
      },
      {
        id: 'wispr-flow-setup',
        label: 'Wispr Flow setup…',
        run: () => st.setOverlay({ kind: 'settings', tab: 'flow' })
      },
      {
        // Flow's variable-recognition dialog names this command verbatim.
        id: 'toggle-screen-reader',
        label: SCREEN_READER_COMMAND,
        run: () => actions.toggleScreenReaderMode()
      },
      {
        id: 'broadcast',
        label: `${prefs.broadcastInput ? 'Disable' : 'Enable'} broadcast input to all panes`,
        hint: accel('CmdOrCtrl+Alt+I'),
        run: () => actions.toggleBroadcast()
      },
      {
        id: 'pin',
        label: `${prefs.sidebarPinned ? 'Unpin' : 'Pin'} sidebar`,
        hint: accel('CmdOrCtrl+Shift+B'),
        run: () => actions.togglePin()
      },
      {
        id: 'toggle-sidebar',
        label: 'Toggle sidebar',
        hint: accel('CmdOrCtrl+B'),
        run: () => actions.toggleSidebar()
      },
      {
        id: 'view-files',
        label: "Browse the focused session's folder",
        run: () => actions.showSidebar('files')
      },
      {
        id: 'view-search',
        label: 'Find in folder…',
        hint: accel('CmdOrCtrl+Shift+F'),
        run: () => actions.showSidebar('search')
      },
      {
        id: 'view-git',
        label: 'Source control',
        run: () => actions.showSidebar('git')
      },
      {
        id: 'toggle-preview',
        label: `${prefs.previewVisible ? 'Hide' : 'Show'} preview pane`,
        hint: accel('CmdOrCtrl+P'),
        run: () => preview.toggle()
      },
      {
        id: 'preview-open',
        label: 'Open a file in the preview…',
        hint: accel('CmdOrCtrl+Alt+O'),
        run: () => void preview.openDialog()
      },
      {
        id: 'preview-refresh',
        label: 'Re-read the previewed file',
        run: () => void preview.refresh()
      },
      {
        id: 'preview-auto',
        label: `${prefs.previewAutoShow ? 'Stop' : 'Start'} opening the preview for new documents`,
        run: () => void api.setPrefs({ previewAutoShow: !prefs.previewAutoShow })
      },
      { id: 'interrupt', label: 'Interrupt agent (Ctrl-C)', hint: accel('CmdOrCtrl+.'), run: () => void actions.interrupt() },
      {
        id: 'attach',
        label: 'Copy tmux attach command',
        run: () => {
          const id = activeSessionId()
          if (id) void actions.attachInITerm(id)
        }
      },
      {
        id: 'export',
        label: 'Export transcript to markdown',
        run: () => {
          const id = activeSessionId()
          if (id) void actions.exportTranscript(id)
        }
      },
      {
        id: 'log',
        label: 'Reveal session log file',
        run: () => {
          const id = activeSessionId()
          if (id) void api.revealLog(id)
        }
      },
      { id: 'settings', label: 'Settings…', run: () => st.setOverlay({ kind: 'settings' }) },
      { id: 'data', label: 'Open Workbench data folder', run: () => void api.openDataDir() }
    ]

    // Running a script starts a plain shell session rather than typing into
    // the focused one: an agent's REPL is not a shell, and a long-running dev
    // server wants a pane of its own that you can watch and interrupt. It also
    // closes the loop — the new session prints a URL, and the pane offers it.
    const scriptCmds: Command[] = scripts.map((script) => ({
      id: `run:${script.name}`,
      label: `Run: npm run ${script.name}`,
      hint: script.command,
      run: () => {
        const id = activeSessionId()
        const cwd = id ? st.sessions.find((x) => x.id === id)?.cwd : undefined
        void actions.createSession({
          agent: 'shell',
          cwd,
          title: `npm run ${script.name}`,
          initialPrompt: `npm run ${script.name}`
        })
      }
    }))

    // Sessions are commands too — "go to" without leaving the palette.
    const sessionCmds: Command[] = [...sessions].sort(byActivity).map((s) => ({
      id: `go:${s.id}`,
      label: `Go to: ${s.title}`,
      description: sessionTaskSummary(s),
      hint: s.status,
      run: () => st.revealSession(s.id)
    }))

    return [...base, ...scriptCmds, ...sessionCmds].map((c) => ({
      ...c,
      run: () => {
        close()
        c.run()
      }
    }))
  }, [sessions, scripts, launchable, prefs.broadcastInput, prefs.sidebarPinned])

  const filtered = useMemo(() => filterCommands(commands, q), [commands, q])
  useEffect(() => setIdx(0), [q])

  return (
    <div className="overlay" onMouseDown={() => useStore.getState().setOverlay({ kind: 'none' })}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="Type a command…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => Math.min(filtered.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              filtered[idx]?.run()
            }
          }}
        />
        <div className="palette__list">
          {filtered.length === 0 && <div className="palette__empty">No matching command</div>}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              className={`palette__item${i === idx ? ' palette__item--active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => c.run()}
            >
              {c.description ? <span className="palette__session-copy"><strong>{c.label}</strong><span>{c.description}</span></span> : c.label}
              {c.hint && <span className="palette__item-sub">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Subsequence match, the same feel as VS Code's palette. */
function filterCommands(commands: Command[], q: string): Command[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return commands
  const scored: { c: Command; score: number }[] = []
  for (const c of commands) {
    const hay = `${c.label} ${c.description ?? ''}`.toLowerCase()
    let i = 0
    let score = 0
    let lastHit = -1
    for (const ch of needle) {
      const at = hay.indexOf(ch, i)
      if (at === -1) {
        score = -1
        break
      }
      // Reward adjacency so "nc" beats a scattered match.
      score += at === lastHit + 1 ? 3 : 1
      lastHit = at
      i = at + 1
    }
    if (score >= 0) scored.push({ c, score })
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.c)
}
