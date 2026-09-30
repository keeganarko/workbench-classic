import { useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { actions, pendingForkKind } from '../lib/actions'
import { shortPath } from '../lib/ui'
import { profileOf, useLaunchableProfiles, useProfiles } from '../lib/agents'
import type { AgentKind } from '../../../shared/types'

/**
 * Forking is the "spin off a child or parallel session that picks up context"
 * requirement. Same agent → a real CLI fork (`claude --resume --fork-session`
 * / `codex fork`). Different agent → transcript handoff.
 */
export function ForkDialog({ sessionId }: { sessionId: string }): JSX.Element {
  const source = useStore((s) => s.sessions.find((x) => x.id === sessionId))
  const profiles = useProfiles()
  // Anything startable can *receive* a handoff — it only has to be typed into.
  // Whether it can be forked natively is a separate question, asked below.
  const targets = useLaunchableProfiles().filter((p) => p.id !== 'shell')
  const [kind, setKind] = useState<'child' | 'sibling'>(pendingForkKind)
  const [targetAgent, setTargetAgent] = useState<AgentKind>(source?.agent ?? 'claude')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)

  if (!source) {
    return (
      <div className="overlay" onMouseDown={() => useStore.getState().setOverlay({ kind: 'none' })}>
        <div className="modal">
          <div className="modal__head">Session is gone</div>
        </div>
      </div>
    )
  }

  const crossAgent = targetAgent !== source.agent
  const targetLabel = profileOf(targetAgent, profiles).label
  // A native fork needs three things: the same agent, a CLI conversation id to
  // branch from, and an agent that actually has a fork flag. Without the third
  // the dialog would promise a branch and silently deliver a handoff.
  const nativeFork =
    !crossAgent && !!source.agentSessionId && profileOf(targetAgent, profiles).capabilities.fork

  const go = async (): Promise<void> => {
    setBusy(true)
    await actions.fork({
      sourceId: sessionId,
      kind,
      targetAgent,
      initialPrompt: prompt.trim() || undefined
    })
    setBusy(false)
  }

  return (
    <div className="overlay" onMouseDown={() => useStore.getState().setOverlay({ kind: 'none' })}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__head">
          Fork “{source.title}” <span className="field__hint">({shortPath(source.cwd)})</span>
        </div>
        <div className="modal__body">
          <div className="field">
            <span className="field__label">Relationship</span>
            <div className="segmented">
              <button
                className={`segmented__opt${kind === 'child' ? ' segmented__opt--on' : ''}`}
                onClick={() => setKind('child')}
              >
                Child
              </button>
              <button
                className={`segmented__opt${kind === 'sibling' ? ' segmented__opt--on' : ''}`}
                onClick={() => setKind('sibling')}
              >
                Parallel
              </button>
            </div>
            <span className="field__hint">
              {kind === 'child'
                ? 'Branches off this session — it keeps the whole conversation so far.'
                : 'Starts alongside it under the same parent, from the same context.'}
            </span>
          </div>

          <div className="field">
            <span className="field__label">Run it with</span>
            <div className="segmented">
              {targets.map((p) => (
                <button
                  key={p.id}
                  className={`segmented__opt${targetAgent === p.id ? ' segmented__opt--on' : ''}`}
                  onClick={() => setTargetAgent(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <span className="field__hint">
              {nativeFork
                ? `Native fork — ${targetLabel} resumes session ${source.agentSessionId?.slice(0, 8)}… and branches it.`
                : crossAgent
                  ? `Cross-agent: the transcript is exported to markdown and handed to ${targetLabel} as opening context.`
                  : profileOf(targetAgent, profiles).capabilities.fork
                    ? 'No CLI session id captured yet — falls back to a transcript handoff.'
                    : `${targetLabel} has no fork command of its own, so the transcript is handed over as opening context.`}
            </span>
          </div>

          <div className="field">
            <span className="field__label">Opening prompt for the fork (optional)</span>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                kind === 'child'
                  ? 'e.g. now do the same thing for the API package'
                  : 'e.g. try the alternative approach we discussed'
              }
            />
          </div>
        </div>
        <div className="modal__foot">
          <button
            className="btn btn--ghost"
            style={{ flex: '0 0 auto' }}
            onClick={() => useStore.getState().setOverlay({ kind: 'none' })}
          >
            Cancel
          </button>
          <button
            className="btn btn--primary"
            style={{ flex: '0 0 auto' }}
            disabled={busy}
            onClick={() => void go()}
          >
            {busy ? 'Forking…' : kind === 'child' ? 'Create child' : 'Create parallel'}
          </button>
        </div>
      </div>
    </div>
  )
}
