/**
 * The isolated surface shared by the document dock and visual panes.
 *
 * The three shapes are security boundaries, not styling choices: images
 * cannot execute, PDFs use Chromium's viewer, and a live HTML artifact gets
 * scripts without getting this window, its preload bridge, navigation, modal
 * dialogs, or downloads.
 */

import type { DragEventHandler, JSX, RefObject } from 'react'
import type { PreviewKind } from '../../../shared/preview'

export function PreviewViewer({
  url,
  kind,
  name,
  frameRef,
  onImageDragStart,
  className = 'preview__frame',
  imageClassName = 'preview__image'
}: {
  url: string
  kind: PreviewKind
  name: string
  frameRef?: RefObject<HTMLIFrameElement>
  onImageDragStart?: DragEventHandler<HTMLImageElement>
  className?: string
  imageClassName?: string
}): JSX.Element {
  if (kind === 'image' || kind === 'svg') {
    return (
      <div className={imageClassName}>
        <img src={url} alt={name} draggable={!!onImageDragStart} onDragStart={onImageDragStart}
          title={onImageDragStart ? 'Drag this image into another app or an upload area' : undefined} />
      </div>
    )
  }

  if (kind === 'pdf') {
    // Deliberately unsandboxed: the PDF viewer is a Chromium component that
    // runs in its own process, and a sandbox attribute here stops it loading.
    return <iframe ref={frameRef} className={className} src={url} title={name} />
  }

  // A dev server is an artifact that happens to be served rather than saved:
  // a real page, its own origin, its own script, and none of this window.
  const artifact = kind === 'html' || kind === 'url'
  return (
    <iframe
      ref={frameRef}
      className={className}
      src={url}
      title={name}
      sandbox={artifact ? 'allow-scripts allow-same-origin allow-forms allow-popups' : 'allow-scripts'}
    />
  )
}
