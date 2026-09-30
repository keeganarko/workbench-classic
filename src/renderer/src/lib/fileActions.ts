import type { DragEvent } from 'react'
import { useStore } from '../state/store'

/** Keep failed OS actions visible without replacing the document the user is
 * trying to use. A cancelled save is ordinary navigation, not an error. */
export async function runFileAction(action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch (error) {
    useStore.getState().setToast(error instanceof Error ? error.message : String(error), 'error')
  }
}

export async function saveFileCopy(path: string): Promise<void> {
  await runFileAction(async () => {
    const saved = await window.term.previewSaveCopy(path)
    if (saved) useStore.getState().setToast(`Saved a copy to ${saved}`)
  })
}

export function dragPreviewFile(event: DragEvent, path: string): void {
  // Cancel Chromium's image/URL drag before handing the real file to the OS.
  event.preventDefault()
  event.stopPropagation()
  void runFileAction(() => window.term.previewStartDrag(path))
}
