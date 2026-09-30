import { ResizeHandle, usePanelWidth } from './ResizeHandle'
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { activeSessionId } from '../lib/actions'
import { useAttachTarget } from '../lib/attachments'
import { DictationPanel } from './DictationPanel'
import { insertTranscript } from '../../../shared/dictation'
import { profileOf } from '../lib/agents'
import { newSessionProject } from '../lib/projectTerminals'
import { composerMention, resolveRecipients } from '../../../shared/composer'
import type { ComposerScope } from '../state/store'
import type { RelayResult } from '../../../shared/relay'
import { describeResult } from '../../../shared/relay'
import {
  findMentionAt,
  rankMentions,
  slugify,
  type MentionTarget
} from '../../../shared/mentions'
import { MentionPopup } from './MentionPopup'
import { accel } from '../lib/ui'

const api = window.term

/**
 * How long a fan-out send may take before the composer stops believing it.
 *
 * Not a cancel — the prompts may well have landed, and there is no way to
 * un-send them. It is a floor under the UI: the send button is disabled while
 * `sending` is true, so a promise that never settles leaves the prompt bar
 * permanently dead with no error and nothing to retry. Twenty seconds is far
 * past the ~50 ms a real delivery takes per recipient, so nothing healthy ever
 * trips it.
 */
const SEND_TIMEOUT_MS = 20_000

class SendTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SendTimeout('timed out')), ms)
    work.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

const SCOPES: { key: ComposerScope; label: string; title: string }[] = [
  { key: 'pane', label: 'This Pane', title: 'Send only to the focused pane' },
  {
    key: 'project',
    label: 'This Project',
    title: 'Send to live agents in the current Workbench project'
  },
  { key: 'all', label: 'All Sessions', title: 'Send to every live session' }
]

/**
 * One prompt box, N agents. This is the "writes both ways" surface: type once,
 * Claude and Codex both get it and stream side by side.
 */
export function Composer(): JSX.Element {
  const sizing = usePanelWidth({ key: 'workbench.composerHeight', preferred: 54, min: 34, max: 420, reserve: 240, axis: 'y' })
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.sessionProjects)
  const selectedProjectId = useStore((s) => s.experienceProjectId)
  const profiles = useStore((s) => s.profiles)
  const targets = useStore((s) => s.composerTargets)
  // A running agent remains a valid recipient even if its binary is no longer
  // on PATH. Detection controls new launches, not delivery to an existing TUI.
  const chips = [...new Set(sessions.filter((s) => s.alive && s.agent !== 'shell').map((s) => s.agent))]
    .map((id) => profileOf(id, profiles))
  const scope = useStore((s) => s.composerScope)
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const text = useStore((s) => s.composerDraft)
  const setText = useStore((s) => s.setComposerDraft)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [dictationOpen, setDictationOpen] = useState(false)
  const dictationNonce = useStore((s) => s.composerDictationNonce)
  useEffect(() => { if (dictationNonce > 0) setDictationOpen(true) }, [dictationNonce])
  const [waitForReply, setWaitForReply] = useState(false)
  const [relayResult, setRelayResult] = useState<RelayResult | null>(null)
  const focusNonce = useStore((s) => s.composerFocusNonce)
  const ref = useRef<HTMLTextAreaElement>(null)

  /**
   * ⌘L, the command palette, and the "type here" click all land on this.
   *
   * Skipped on the first render — a nonce of 0 means nobody has asked yet, and
   * stealing the keyboard from a terminal at launch is exactly the behaviour
   * this app must not have.
   */
  useEffect(() => {
    if (focusNonce === 0) return
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [focusNonce])

  const mentionTargets: MentionTarget[] = sessions
    .filter((s) => s.agent !== 'shell')
    .map((s) => ({ id: s.id, title: s.title, lastTask: s.lastTask, agent: s.agent, alive: s.alive }))

  // An `@` under the caret opens the picker; anything typed elsewhere closes it.
  const span = dismissed ? null : findMentionAt(text, caret)
  const suggestions = span ? rankMentions(span.query, mentionTargets).slice(0, 8) : []
  const popupOpen = span !== null && suggestions.length > 0

  /**
   * Mentions override the scope chips.
   *
   * Naming a session is the most specific instruction the composer accepts, so
   * it wins over "All sessions" rather than intersecting with it — a broadcast
   * that also happened to mention one agent by name would otherwise go to
   * everyone, which is the opposite of what typing a name means.
   */
  const mention = composerMention(text, mentionTargets)
  const relayTarget = mention.target
  const tab = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null
  const project = newSessionProject(projects, selectedProjectId, tab, sessions)
  const recipients = resolveRecipients(sessions, scope, activeSessionId(), project?.id ?? null, targets)

  const focusDraft = (): void => { ref.current?.focus() }
  const pasteTranscript = async (): Promise<void> => {
    const el = ref.current
    if (!el) return
    const expected = useStore.getState().composerDraft
    const start = el.selectionStart, end = el.selectionEnd
    try {
      const transcript = await window.term.readClipboard()
      const inserted = insertTranscript(useStore.getState().composerDraft, expected, start, end, transcript)
      if (!inserted) {
        useStore.getState().setToast(transcript ? 'The prompt changed or the transcript is too large. Paste again at the intended position.' : 'Copy your transcript in Flow first.', 'info')
        return
      }
      setText(inserted.text)
      setCaret(inserted.caret)
      requestAnimationFrame(() => { el.focus(); el.setSelectionRange(inserted.caret, inserted.caret) })
    } catch (error) {
      useStore.getState().setToast(error instanceof Error ? error.message : 'Could not read the clipboard', 'error')
    }
  }

  /** Drops and image pastes land at the caret, like any other typed text. */
  const attach = useAttachTarget((chunk) => {
    const el = ref.current
    const at = el ? (el.selectionStart ?? text.length) : text.length
    setText((prev) => prev.slice(0, at) + chunk + prev.slice(el?.selectionEnd ?? at))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + chunk.length, at + chunk.length)
    })
  })

  // A shrinking suggestion list must not leave the highlight past the end.
  useEffect(() => {
    if (pick >= suggestions.length) setPick(0)
  }, [suggestions.length, pick])

  /** Replaces the `@…` under the caret with the chosen session's slug. */
  const insertMention = (target: MentionTarget): void => {
    if (!span) return
    const slug = slugify(target.title)
    const token = mentionTargets.filter((s) => slugify(s.title) === slug).length === 1 && slug
      ? slug : target.id
    const next = `${text.slice(0, span.start)}@${token} ${text.slice(span.end)}`
    const at = span.start + token.length + 2
    setText(next)
    setDismissed(true)
    requestAnimationFrame(() => {
      const el = ref.current
      el?.focus()
      el?.setSelectionRange(at, at)
      setCaret(at)
    })
  }

  /**
   * The `@name` path: one named recipient, and optionally block on its reply.
   *
   * The text keeps its mention rather than having it stripped. The receiving
   * agent gets a banner saying who sent it, and leaving `@reviewer` in the body
   * means the transcript still reads as the instruction that was actually given.
   */
  const relay = async (body: string, target: MentionTarget): Promise<boolean> => {
    setRelayResult(null)
    const result = await api.relay({
      fromSessionId: null,
      toSessionId: target.id,
      message: body,
      wait: waitForReply
    })
    if (!waitForReply) {
      useStore.getState().setToast(describeResult(result), result.ok ? 'info' : 'error')
      return result.ok
    }
    setRelayResult(result)
    if (!result.ok) useStore.getState().setToast(describeResult(result), 'error')
    return result.ok
  }

  /**
   * A fan-out send has three outcomes, not two. Reporting only "sent" hid the
   * case that actually costs you an hour: the prompt reached three of four
   * agents and you carried on believing all four had it.
   */
  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body || sendingRef.current || mention.error) return
    if (!relayTarget && recipients.length === 0) return
    sendingRef.current = true
    useStore.setState({ composerSending: true })
    setSending(true)
    try {
      if (relayTarget) {
        if (await relay(body, relayTarget)) setText((current) => current === text ? '' : current)
        return
      }
      const results = await withTimeout(
        api.sendPrompt(
          recipients.map((s) => s.id),
          body
        ),
        SEND_TIMEOUT_MS
      )
      if (results.length === 0) throw new Error('No session accepted the prompt')
      const failed = results.filter((r) => !r.ok)
      const titleOf = (id: string): string =>
        recipients.find((s) => s.id === id)?.title ?? id

      if (failed.length === 0) {
        setText((current) => current === text ? '' : current)
      } else if (failed.length === results.length) {
        // Nothing landed anywhere — keep the text so it is not lost.
        useStore
          .getState()
          .setToast(`Not sent: ${failed[0].error ?? 'no session accepted the prompt'}`, 'error')
      } else {
        // It went somewhere, so clearing is right, but name every miss.
        setText((current) => current === text ? '' : current)
        const names = failed.map((f) => `${titleOf(f.sessionId)} (${f.error ?? 'failed'})`)
        useStore
          .getState()
          .setToast(
            `Sent to ${results.length - failed.length} of ${results.length} — missed ${names.join(', ')}`,
            'error'
          )
      }
    } catch (err) {
      // A timeout is not a failure to send — the prompts may well have landed.
      // It is a failure to *hear back*, and the two need different words: one
      // says retry, the other says go look at the panes before you retype it.
      if (err instanceof SendTimeout) {
        useStore
          .getState()
          .setToast(
            `No answer from ${recipients.length} session${recipients.length === 1 ? '' : 's'} after ${
              SEND_TIMEOUT_MS / 1000
            }s — check the panes before resending. Your text is still here.`,
            'error'
          )
      } else {
        useStore.getState().setToast(`Send failed: ${(err as Error).message}`, 'error')
      }
    } finally {
      sendingRef.current = false
      useStore.setState({ composerSending: false })
      setSending(false)
    }
  }

  const summary = mention.error ?? (relayTarget
    ? `${relayTarget.title}${waitForReply ? ' (and wait)' : ''}`
    : recipients.length === 0 ? 'no matching session'
      : recipients.length === 1 ? recipients[0].title : `${recipients.length} sessions`)
  const canSend = Boolean(text.trim()) && !mention.error && (relayTarget !== null || recipients.length > 0)
  const blockedReason = sending ? 'Still sending the last prompt.'
    : !text.trim() ? 'Type a prompt first.'
      : mention.error ?? (scope === 'project' && !project
        ? 'Select a project or a terminal filed in a project first.'
        : 'No live session matches the agents and scope selected above.')

  return (
    <div
      ref={sizing.ref}
      className={`composer${attach.active ? ' composer--dropping' : ''}`}
      onDragEnter={attach.onDragEnter}
      onDragOver={attach.onDragOver}
      onDragLeave={attach.onDragLeave}
      onDrop={attach.onDrop}
      onPasteCapture={attach.onPaste}
      /*
       * Anywhere in the bar that is not itself a control means "I want to type
       * here". Without this, the padding around the textarea is dead space that
       * leaves the keyboard pointed at whichever terminal had it — you click at
       * the prompt bar, start typing, and the letters go into an agent's TUI.
       * That is indistinguishable from a prompt bar that does not work.
       */
      onMouseDown={(e) => {
        const el = e.target as HTMLElement
        if (el.closest('button, textarea, input, a, .mention, .resize-handle')) return
        e.preventDefault() // keep the click from stealing focus back
        ref.current?.focus()
      }}
    >
      <ResizeHandle label="Prompt box height" axis="y" className="resize-handle--top" value={sizing.width} min={34} max={sizing.maximum} onDelta={(delta) => sizing.resize(-delta)} onEnd={sizing.finish} onReset={sizing.reset} />
      <div className="composer__targets">
        {chips.map((p) => {
          // Absent means on. A chip the user has never touched should send, or
          // adding an agent would quietly exclude it from every broadcast.
          const on = targets[p.id] ?? true
          return (
            <button
              key={p.id}
              className={`chip${on ? ' chip--on' : ''}`}
              onClick={() => useStore.getState().setComposerTarget(p.id, !on)}
            >
              <span style={{ color: on ? '#fff' : p.color }}>●</span> {p.label}
            </button>
          )
        })}

        <span style={{ width: 6 }} />

        {SCOPES.map((s) => (
          <button
            key={s.key}
            className={`chip${scope === s.key ? ' chip--on' : ''}`}
            title={s.title}
            onClick={() => useStore.getState().setComposerScope(s.key)}
          >
            {s.label}
          </button>
        ))}

        {relayTarget && (
          <button
            className={`chip${waitForReply ? ' chip--on' : ''}`}
            title="Block until that session finishes its turn, then show its reply here"
            onClick={() => setWaitForReply((w) => !w)}
          >
            ⏱ Wait for reply
          </button>
        )}

        <span style={{ marginLeft: 'auto' }}>→ {summary}</span>
      </div>

      {scope === 'project' && (
        <div className="composer__targets">
          <span>{project ? `Project: ${project.name}` : 'No project selected'}</span>
        </div>
      )}

      {relayResult && (
        <div
          className={`relayout${relayResult.phase === 'replied' ? '' : ' relayout--warn'}`}
        >
          <div className="relayout__head">
            <strong>{describeResult(relayResult)}</strong>
            <button className="relayout__x" onClick={() => setRelayResult(null)}>
              ✕
            </button>
          </div>
          {relayResult.reply && <pre className="relayout__body">{relayResult.reply}</pre>}
          {relayResult.reply && (
            <button
              className="chip"
              onClick={() => void api.writeClipboard(relayResult.reply ?? '')}
            >
              Copy reply
            </button>
          )}
        </div>
      )}

      {dictationOpen && <DictationPanel
        text={text}
        sessionId={recipients.length === 1 ? recipients[0].id : null}
        onReplace={setText}
        onFocus={focusDraft}
        onPaste={() => void pasteTranscript()}
        onClose={() => { setDictationOpen(false); focusDraft() }}
      />}
      <div className="composer__row composer__row--anchored">
        {popupOpen && (
          <MentionPopup
            items={suggestions}
            active={pick}
            onPick={insertMention}
            onHover={setPick}
          />
        )}
        <textarea
          ref={ref}
          className="composer__input"
          name="workbench-prompt"
          aria-label="Agent prompt"
          aria-description="Type, paste, or dictate a prompt. Review the text and recipients before sending."
          style={{ height: sizing.width, maxHeight: sizing.maximum }}
          rows={1}
          value={text}
          placeholder={
            recipients.length > 1
              ? `Broadcast to ${recipients.length} sessions…`
              : 'Send a prompt…'
          }
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart ?? e.target.value.length)
            setDismissed(false)
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            // Input-method and dictation clients may use Enter to commit their
            // own text. That commit belongs to the draft, not the Send action.
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
            if (popupOpen) {
              // While the picker is open it owns these keys. Enter must insert
              // rather than send, or choosing a name fires the prompt at
              // whoever the scope chips happened to select.
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setPick((i) => (i + 1) % suggestions.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setPick((i) => (i - 1 + suggestions.length) % suggestions.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                insertMention(suggestions[pick] ?? suggestions[0])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setDismissed(true)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
              return
            }
            // The way back out. A prompt bar you can enter with ⌘L but not
            // leave without the mouse is a trap, and Escape is where everyone
            // reaches first. It does not clear the draft — losing three
            // sentences to a reflex would be its own bug.
            if (e.key === 'Escape' && !popupOpen) {
              e.preventDefault()
              e.stopPropagation()
              ref.current?.blur()
              const back = tab?.activePaneId ?? tab?.layout.id
              if (back) {
                useStore.getState().focusPane(back)
                // Blurring alone leaves the keyboard on `document.body`, where
                // keystrokes go nowhere. The pane only re-focuses itself when
                // *which* pane is focused changes, and Escape usually returns
                // to the pane that was already focused — so hand it the
                // keyboard directly. xterm's hidden textarea is the element
                // that actually receives typing.
                document
                  .querySelector<HTMLTextAreaElement>(
                    `[data-pane-id="${CSS.escape(back)}"] .xterm-helper-textarea`
                  )
                  ?.focus()
              }
            }
          }}
        />
        <button
          className="btn btn--sm composer__dictate"
          aria-expanded={dictationOpen}
          title="Dictate with Wispr Flow"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => { setDictationOpen(value => !value); focusDraft() }}
        >Dictate</button>
        <button
          className="composer__send"
          disabled={!canSend || sending}
          title={canSend && !sending ? `Send to ${summary}` : blockedReason}
          onClick={() => void send()}
        >
          {sending
            ? waitForReply && relayTarget
              ? 'Waiting…'
              : 'Sending…'
            : relayTarget
              ? 'Relay'
              : recipients.length > 1
                ? `Send to ${recipients.length}`
                : 'Send'}
        </button>
      </div>

      {text.trim() && !canSend && !sending ? (
        <div className="composer__hint composer__hint--blocked">{blockedReason}</div>
      ) : (
        <div className="composer__hint">
          {accel('Cmd+L')} focus · ⏎ send · ⇧⏎ newline · <strong>@name</strong> to hand it to one
          session · paste or drop an image to attach it · prompts are typed into each agent's TUI
          once it settles
        </div>
      )}
    </div>
  )
}
