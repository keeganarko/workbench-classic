import { useEffect, useState, type JSX } from 'react'
import type { FocusUpdate } from '../../../shared/focusUpdate'

/** The picture is supplied for this exact report, not inferred from a role or
 * keyword. Its immutable snapshot loads through the existing preview file gate.
 * SVG stays in an img context, and no agent HTML runs on the Focus board. */
export function FocusReportImage({ report }: { report?: FocusUpdate }): JSX.Element | null {
  const visual = report?.visual?.kind === 'image' ? report.visual : undefined
  const [loaded, setLoaded] = useState<{ id: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!report || !visual) return
    let cancelled = false
    void window.term.visualOpen(visual.path).then(doc => {
      if (!cancelled) setLoaded({ id: report.id, url: doc.kind === 'image' || doc.kind === 'svg' ? doc.url : null })
    }).catch(() => { if (!cancelled) setLoaded({ id: report.id, url: null }) })
    return () => { cancelled = true }
  }, [report?.id, visual?.path])
  if (!report || !visual) return null
  const image = loaded?.id === report.id ? loaded : null
  return <figure className="focus-report-image" data-report-id={report.id}>
    {image?.url ? <img src={image.url} alt={visual.alt} decoding="async"
      onError={() => setLoaded({ id: report.id, url: null })} />
      : <p className="focus-image-placeholder">{image ? 'Image unavailable' : 'Loading update image…'}</p>}
    <figcaption>{visual.alt}</figcaption>
  </figure>
}
