import { useEffect } from 'react'
import { useStore } from '../state/store'
import { activeSessionId } from '../lib/actions'
import { useAgentLabel } from '../lib/agents'
import { flowWindowTitle } from '../../../shared/flowContext'

/**
 * Keeps the OS window title in step with the active session's agent
 * ("Claude Code · Workbench"). Main has no `page-title-updated` handler, so
 * `document.title` flows straight through to the native window, which is
 * what the taskbar, Alt-Tab and Wispr Flow's window-title probe all read.
 * Renders nothing.
 */
export function WindowTitle(): null {
  const sessions = useStore((s) => s.sessions)
  // Same trick as StatusBar: subscribing to tabs re-runs this on tab changes,
  // which is when the active session can move without `sessions` changing.
  useStore((s) => s.tabs)
  const active = sessions.find((s) => s.id === activeSessionId())
  const label = useAgentLabel(active?.agent ?? 'shell')
  const title = flowWindowTitle(active ? label : null)
  useEffect(() => { document.title = title }, [title])
  return null
}
