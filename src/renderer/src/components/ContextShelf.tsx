/**
 * The context shelf — named checkpoints of a conversation, and what you can do
 * with one.
 *
 * The list is the feature. A checkpoint is recognised by the first thing you
 * asked and the note you left, not by an id, so both are on the row; everything
 * else is secondary and sized accordingly.
 *
 * Opening always forks, which is why the button says Open and not Resume: the
 * saved copy is never the live one, so the same checkpoint can be opened again
 * tomorrow, or by two people at once, from the same starting state.
 */

import { useState } from 'react'
import type { JSX } from 'react'

import { useStore } from '../state/store'
import { activeSessionId } from '../lib/actions'
import { Icon } from './Icon'
import type { Checkpoint } from '../../../shared/shelf'

const api = window.term

export function ContextShelf(): JSX.Element {
  const st = useStore()
  const checkpoints = useStore((s) => s.checkpoints)
  const sessions = useStore((s) => s.sessions)
  const activeId = activeSessionId()
  const active = sessions.find((s) => s.id === activeId) ?? null

  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const close = (): void => st.setOverlay({ kind: 'none' })
  const toast = (msg: string, kind?: 'success' | 'error'): void => st.setToast(msg, kind)

  const save = async (): Promise<void> => {
    if (!active) return toast('No session to save.', 'error')
    setBusy('save')
    try {
      const saved = await api.shelfSave(active.id, name || active.title, note)
      setName('')
      setNote('')
      toast(`Saved “${saved.name}” — ${saved.turns} turns.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save that.', 'error')
    } finally {
      setBusy(null)
    }
  }

  const open = async (c: Checkpoint): Promise<void> => {
    setBusy(c.name)
    try {
      // Opened where the focused session is, falling back to wherever it was
      // recorded — a checkpoint someone sent you names a directory that only
      // exists on their machine, and the shelf re-points it either way.
      await api.shelfOpen(c.name, active?.cwd)
      close()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not open that.', 'error')
      setBusy(null)
    }
  }

  const send = async (c: Checkpoint): Promise<void> => {
    setBusy(c.name)
    try {
      const res = await api.shelfExport(c.name)
      if (res) toast(`Wrote ${(res.bytes / 1e6).toFixed(1)} MB — hand them that file.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not write that.', 'error')
    } finally {
      setBusy(null)
    }
  }

  const receive = async (): Promise<void> => {
    setBusy('import')
    try {
      const added = await api.shelfImport()
      if (added) toast(`“${added.name}” is on your shelf — ${added.turns} turns.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not read that file.', 'error')
    } finally {
      setBusy(null)
    }
  }

  const remove = async (c: Checkpoint): Promise<void> => {
    await api.shelfRemove(c.name).catch(() => undefined)
    toast(`Removed “${c.name}”.`)
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="modal" style={{ width: 620 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__head">Context shelf</div>

        <div className="modal__body">
          <p className="share__lede">
            Save this conversation under a name, come back to it later, or hand it to someone
            else. Opening one always forks, so a checkpoint never changes and two people can
            start from the same place.
          </p>

          <div className="field">
            <span className="field__label">Save this session</span>
            {active ? (
              <div className="shelf__save">
                <input
                  value={name}
                  placeholder={active.title}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="Checkpoint name"
                />
                <input
                  value={note}
                  placeholder="Why this moment is worth keeping (optional)"
                  onChange={(e) => setNote(e.target.value)}
                  aria-label="Note"
                />
                <button className="btn btn--primary" onClick={save} disabled={busy === 'save'}>
                  {busy === 'save' ? 'Saving…' : 'Save'}
                </button>
              </div>
            ) : (
              <div className="share__empty">Focus a session to save it.</div>
            )}
          </div>

          <div className="field">
            <span className="field__label">
              On your shelf — {checkpoints.length}
            </span>
            {checkpoints.length === 0 ? (
              <div className="share__empty">
                Nothing saved yet. Save a session above, or take one someone sent you.
              </div>
            ) : (
              <ul className="shelf__list">
                {checkpoints.map((c) => (
                  <li key={c.name} className="shelf__item">
                    <div className="shelf__main">
                      <div className="shelf__name">
                        {c.name}
                        <span className="shelf__meta">
                          {c.turns} turns · {(c.bytes / 1e6).toFixed(1)} MB
                        </span>
                      </div>
                      {c.note ? <div className="shelf__note">{c.note}</div> : null}
                      <div className="shelf__prompt">“{c.firstPrompt}”</div>
                    </div>
                    <div className="shelf__actions">
                      <button
                        className="btn btn--sm btn--primary"
                        onClick={() => void open(c)}
                        disabled={busy === c.name}
                      >
                        Open
                      </button>
                      <button
                        className="btn btn--sm"
                        onClick={() => void send(c)}
                        disabled={busy === c.name}
                      >
                        Send
                      </button>
                      <button
                        className="btn btn--sm btn--icon"
                        title={`Remove ${c.name}`}
                        aria-label={`Remove ${c.name}`}
                        onClick={() => void remove(c)}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="modal__foot">
          <button className="btn" onClick={receive} disabled={busy === 'import'}>
            Take one someone sent…
          </button>
          <button className="btn" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
