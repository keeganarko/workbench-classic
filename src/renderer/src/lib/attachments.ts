/**
 * Paste and drop, on the renderer side.
 *
 * The whole feature reduces to one move: turn whatever the user just gave us
 * into filesystem paths, then type those paths where they were aiming. Claude
 * and Codex both read images and files from paths, so nothing else is needed.
 *
 * Files that exist on disk are passed by path and never copied — dragging a
 * 200 MB video in should cost nothing. Only bytes with no file behind them (a
 * screenshot on the clipboard, an image dragged out of a browser tab) are
 * base64-encoded across the bridge.
 */

import { useCallback, useRef, useState } from 'react'
import type { DragEvent, ClipboardEvent } from 'react'
import { useStore } from '../state/store'
import { formatAttachmentText } from '../../../shared/attach'
import type { DroppedFile } from '../../../shared/types'

const api = window.term

/** True when a paste or drop is carrying files rather than plain text. */
export function carriesFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false
  if (dt.files && dt.files.length > 0) return true
  // A drag in flight exposes `types` but not yet `files`.
  return Array.from(dt.types ?? []).includes('Files')
}

/**
 * WSLg's clipboard bridge can advertise a phantom `Files` format alongside
 * ordinary text even though `files` is empty. Wispr Flow pastes by temporarily
 * putting its transcript on that clipboard, so treating the advertised format
 * as an attachment eats the transcript and produces an empty-image error.
 * Real file objects remain authoritative; otherwise visible plain text wins.
 */
export function carriesPastedFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false
  // A paste event has already fully materialised its payload, unlike a drag in
  // flight. An advertised `Files` type with no actual File objects is therefore
  // never enough evidence to steal the paste. The explicit context-menu action
  // remains available for the rare clipboard provider Chromium cannot expose.
  return !!dt.files && dt.files.length > 0
}

/** Reads each item as a path where possible, and as bytes only where it is not. */
export async function collectFiles(dt: DataTransfer | null | undefined): Promise<DroppedFile[]> {
  if (!dt?.files?.length) return []
  const out: DroppedFile[] = []
  for (const file of Array.from(dt.files)) {
    const onDisk = api.pathForFile(file)
    if (onDisk) {
      out.push({ path: onDisk })
      continue
    }
    const bytes = await file.arrayBuffer()
    out.push({ name: file.name || 'attachment', dataBase64: bufferToBase64(bytes) })
  }
  return out
}

/**
 * Chunked because `String.fromCharCode(...bytes)` blows the argument limit on
 * anything bigger than a small icon, and a screenshot is not small.
 */
function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/**
 * Adopts a batch and returns the exact text to type, or `''` if nothing landed.
 * Failures are toasted here so every call site reports them the same way.
 */
export async function attachmentTextFor(items: DroppedFile[]): Promise<string> {
  if (items.length === 0) return ''
  const st = useStore.getState()
  try {
    const res = await api.attachFiles(items)
    for (const error of res.errors) st.setToast(error, 'error')
    if (res.paths.length === 0) return ''
    st.setToast(
      res.paths.length === 1
        ? 'Attached 1 file — its path is in the prompt.'
        : `Attached ${res.paths.length} files — their paths are in the prompt.`,
      'success'
    )
    return formatAttachmentText(res.paths)
  } catch (err) {
    st.setToast(`Could not attach: ${(err as Error).message}`, 'error')
    return ''
  }
}

/** The system-clipboard fallback, for the context menu where there is no event. */
export async function clipboardAttachmentText(): Promise<string> {
  const st = useStore.getState()
  try {
    const res = await api.attachClipboard()
    for (const error of res.errors) st.setToast(error, 'error')
    if (res.paths.length === 0) return ''
    st.setToast('Attached the clipboard image.', 'success')
    return formatAttachmentText(res.paths)
  } catch (err) {
    st.setToast(`Could not attach: ${(err as Error).message}`, 'error')
    return ''
  }
}

export interface AttachTarget {
  /** True while a file drag is hovering, for the drop highlight. */
  active: boolean
  onDragEnter: (e: DragEvent) => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  onPaste: (e: ClipboardEvent) => void
}

/**
 * Makes any element accept pasted and dropped files.
 *
 * `insert` receives the text to type. Text pastes are left entirely alone —
 * the terminal and the textarea already handle those, and hijacking them would
 * break ordinary copy/paste to fix a rarer case.
 */
export function useAttachTarget(insert: ((text: string) => void) | null): AttachTarget {
  const [active, setActive] = useState(false)
  // dragenter/dragleave fire again for every child element the pointer crosses,
  // so the highlight has to count depth rather than trust a single leave.
  const depth = useRef(0)

  const reset = useCallback(() => {
    depth.current = 0
    setActive(false)
  }, [])

  const onDragEnter = useCallback(
    (e: DragEvent) => {
      if (!insert || !carriesFiles(e.dataTransfer)) return
      e.preventDefault()
      depth.current += 1
      setActive(true)
    },
    [insert]
  )

  const onDragOver = useCallback(
    (e: DragEvent) => {
      if (!insert || !carriesFiles(e.dataTransfer)) return
      // Without this the browser refuses the drop and Electron tries to
      // navigate the window to the file instead.
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    [insert]
  )

  const onDragLeave = useCallback(
    (e: DragEvent) => {
      if (!insert || depth.current === 0) return
      e.preventDefault()
      depth.current -= 1
      if (depth.current === 0) setActive(false)
    },
    [insert]
  )

  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!insert || !carriesFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      reset()
      const dt = e.dataTransfer
      void collectFiles(dt)
        .then(attachmentTextFor)
        .then((text) => {
          if (text) insert(text)
        })
    },
    [insert, reset]
  )

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      if (!insert || !carriesPastedFiles(e.clipboardData)) return
      // Only now do we take the event: a plain text paste must reach xterm and
      // the textarea untouched. `stopPropagation` in the capture phase is what
      // keeps them from also pasting the filename as text.
      e.preventDefault()
      e.stopPropagation()
      const dt = e.clipboardData
      void collectFiles(dt)
        .then(async (items) =>
          // Chromium sometimes reports a file on the clipboard without exposing
          // its bytes. The system pasteboard still has it.
          items.length > 0 ? attachmentTextFor(items) : clipboardAttachmentText()
        )
        .then((text) => {
          if (text) insert(text)
        })
    },
    [insert]
  )

  return { active, onDragEnter, onDragOver, onDragLeave, onDrop, onPaste }
}
