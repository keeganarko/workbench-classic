/**
 * The context shelf, in the sidebar.
 *
 * A checkpoint is a saved point in a conversation. Opening one branches from
 * it: a fresh agent session id, the transcript re-pointed at wherever you are,
 * and the saved copy untouched. So the shelf is the trunk and every open is a
 * branch off it — you can try four directions from one saved arrangement of
 * context and none of them can spoil the one you saved.
 *
 * Rows read like sessions on purpose. This is a list of conversations you can
 * go back to, so it is labelled and ordered like the list of conversations you
 * are having.
 */

import { useState } from 'react'
import type { JSX } from 'react'

import { useStore } from '../state/store'
import { activeSessionId } from '../lib/actions'
import { Icon } from './Icon'
import { PanelEmpty } from './PanelEmpty'
import type { Checkpoint } from '../../../shared/shelf'

const api = window.term

export function ShelfPanel(): JSX.Element {
  const checkpoints = useStore((s) => s.checkpoints)
  const sessions = useStore((s) => s.sessions)
  const toast = useStore.getState().setToast

  const active = sessions.find((s) => s.id === activeSessionId()) ?? null
  const [editing, setEditing] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    if (!active) return toast('Focus a session to save it.', 'error')
    setBusy('save')
    try {
      const saved = await api.shelfSave(active.id, active.title, '')
      toast(`Saved “${saved.name}”. Rename it to say what it is.`, 'success')
      // Straight into rename: a checkpoint's whole value is its label, and the
      // moment after saving is the only moment you remember what it was for.
      setEditing(saved.name)
      setDraftName(saved.name)
      setDraftNote('')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save that.', 'error')
    } finally {
      setBusy(null)
    }
  }

  const open = async (c: Checkpoint): Promise<void> => {
    setBusy(c.name)
    try {
      await api.shelfOpen(c.name, active?.cwd)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not open that.', 'error')
    } finally {
      setBusy(null)
    }
  }

  const commit = async (c: Checkpoint): Promise<void> => {
    setEditing(null)
    if (draftName === c.name && draftNote === c.note) return
    try {
      await api.shelfRelabel(c.name, draftName, draftNote)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not rename that.', 'error')
    }
  }

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">Context shelf</span>
        <div className="panel__actions">
          <button
            className="iconbtn"
            title="Take one someone sent you"
            aria-label="Take one someone sent you"
            onClick={() => {
              void api
                .shelfImport()
                .then((c) => c && toast(`“${c.name}” is on your shelf.`, 'success'))
                .catch((e: Error) => toast(e.message, 'error'))
            }}
          >
            <Icon name="download" />
          </button>
          <button
            className="iconbtn"
            title={active ? `Save “${active.title}” here` : 'Focus a session to save it'}
            aria-label="Save this session to the shelf"
            disabled={!active || busy === 'save'}
            onClick={() => void save()}
          >
            <Icon name="plus" />
          </button>
        </div>
      </div>

      {checkpoints.length === 0 ? (
        <PanelEmpty
          title="Nothing saved yet"
          note="Save a conversation when its context is worth keeping, then branch off it as many times as you like. The saved one never changes."
        />
      ) : (
        <ul className="shelfpanel">
          {checkpoints.map((c) => (
            <li key={c.name} className="shelfrow">
              {editing === c.name ? (
                <div className="shelfrow__edit">
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commit(c)
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    aria-label="Name"
                  />
                  <input
                    value={draftNote}
                    placeholder="What is this one for?"
                    onChange={(e) => setDraftNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commit(c)
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    aria-label="Note"
                  />
                  <button className="btn btn--sm btn--primary" onClick={() => void commit(c)}>
                    Save
                  </button>
                </div>
              ) : (
                <>
                  <button
                    className="shelfrow__main"
                    title={`Branch a new session from “${c.name}”`}
                    disabled={busy === c.name}
                    onClick={() => void open(c)}
                  >
                    <Icon name="shelf" size={14} />
                    <span className="shelfrow__name">{c.name}</span>
                    <span className="shelfrow__turns">{c.turns}</span>
                  </button>
                  <div className="shelfrow__sub">
                    {c.note || c.firstPrompt}
                  </div>
                  <div className="shelfrow__tools">
                    <button
                      className="iconbtn iconbtn--xs"
                      title="Rename or relabel"
                      aria-label={`Rename ${c.name}`}
                      onClick={() => {
                        setEditing(c.name)
                        setDraftName(c.name)
                        setDraftNote(c.note)
                      }}
                    >
                      <Icon name="pencil" />
                    </button>
                    <button
                      className="iconbtn iconbtn--xs"
                      title="Send this to someone"
                      aria-label={`Send ${c.name}`}
                      onClick={() => {
                        void api
                          .shelfExport(c.name)
                          .then((r) => r && toast(`Wrote ${(r.bytes / 1e6).toFixed(1)} MB.`, 'success'))
                          .catch((e: Error) => toast(e.message, 'error'))
                      }}
                    >
                      <Icon name="share" />
                    </button>
                    <button
                      className="iconbtn iconbtn--xs"
                      title="Remove from the shelf"
                      aria-label={`Remove ${c.name}`}
                      onClick={() => void api.shelfRemove(c.name).catch(() => undefined)}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
