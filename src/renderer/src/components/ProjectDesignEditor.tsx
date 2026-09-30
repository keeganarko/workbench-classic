import { useRef, useState } from 'react'
import type { JSX, PointerEvent } from 'react'
import {
  MAX_PROJECT_STROKES, MAX_STROKE_POINTS, PROJECT_ART_SIZE, PROJECT_ARTWORKS, PROJECT_COLORS, PROJECT_THEMES,
  defaultProjectAppearance, type ProjectAppearance, type ProjectPoint, type ProjectStroke
} from '../../../shared/projectAppearance'
import { ProjectArt, ProjectMark, SketchLines, projectDesignStyle } from './ProjectArtwork'

export function ProjectDesignEditor({ name, value, onChange }: {
  name: string; value: ProjectAppearance; onChange: (value: ProjectAppearance) => void
}): JSX.Element {
  return <section className="project-designer" aria-label="Project design">
    <div className="project-design-label"><strong>Make it yours</strong>
      <button type="button" onClick={() => onChange(defaultProjectAppearance())}>Reset design</button></div>
    <div className="project-design-preview project-design" style={projectDesignStyle(value)} aria-label="Project design preview">
      <div><ProjectMark name={name} appearance={value} /><strong>{name.trim() || 'Your project'}</strong><small>A little space for your next idea.</small></div>
      <ProjectArt name={name} appearance={value} />
      <span className="project-design-preview-label">LIVE PREVIEW</span>
    </div>
    <fieldset className="project-design-options"><legend>Theme</legend>
      <div className="project-theme-options">{PROJECT_THEMES.map((theme) => {
        const appearance: ProjectAppearance = { ...theme, strokes: [] }
        return <button type="button" key={theme.name} className="project-theme-option project-design" style={projectDesignStyle(appearance)}
          aria-pressed={value.color === theme.color && value.artwork === theme.artwork}
          onClick={() => onChange({ ...value, color: theme.color, artwork: theme.artwork })}>
          <span>{theme.artwork === 'none' ? <span className="project-ink-dot" /> : <ProjectArt appearance={appearance} />}</span>{theme.name}
        </button>
      })}</div>
    </fieldset>
    <fieldset className="project-design-options"><legend>Accent color</legend>
      <div className="project-color-options">{PROJECT_COLORS.map((color) => <button type="button" key={color.id}
        className="project-color-option project-design" style={projectDesignStyle({ ...value, color: color.id })}
        aria-label={color.label} title={color.label} aria-pressed={value.color === color.id}
        onClick={() => onChange({ ...value, color: color.id })}><span>{value.color === color.id ? '✓' : ''}</span></button>)}</div>
    </fieldset>
    <fieldset className="project-design-options"><legend>Little artwork</legend>
      <div className="project-art-options">{PROJECT_ARTWORKS.map((art) => <button type="button" key={art.id}
        aria-pressed={value.artwork === art.id} onClick={() => onChange({ ...value, artwork: art.id })}>{art.label}</button>)}</div>
    </fieldset>
    <p className="field__hint">From name creates an icon automatically and follows renames. Pick artwork or draw to keep your own mark.</p>
    {value.artwork === 'sketch' && <ProjectSketch key={value.artwork} value={value} onChange={onChange} />}
  </section>
}

/**
 * Pointer capture keeps one stroke together when the cursor leaves the pad.
 * Store normalized points, not SVG path text, so the same small doodle scales
 * cleanly down to the sidebar. A canceled gesture leaves saved strokes alone.
 * Preset artwork remains available to people who do not use pointer drawing.
 */
function ProjectSketch({ value, onChange }: { value: ProjectAppearance; onChange: (value: ProjectAppearance) => void }): JSX.Element {
  const active = useRef<{ pointer: number; points: ProjectStroke } | null>(null)
  const [draft, setDraft] = useState<ProjectStroke>([])
  const [pointLimit, setPointLimit] = useState(false)
  const point = (e: PointerEvent<SVGSVGElement>): ProjectPoint => {
    const rect = e.currentTarget.getBoundingClientRect()
    const clamp = (n: number): number => Math.round(Math.max(0, Math.min(PROJECT_ART_SIZE, n)) * 10) / 10
    return [clamp((e.clientX - rect.left) / rect.width * PROJECT_ART_SIZE), clamp((e.clientY - rect.top) / rect.height * PROJECT_ART_SIZE)]
  }
  const finish = (e: PointerEvent<SVGSVGElement>, cancel = false): void => {
    if (active.current?.pointer !== e.pointerId) return
    const stroke = active.current.points
    active.current = null
    setDraft([])
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (!cancel) onChange({ ...value, strokes: [...value.strokes, stroke] })
  }
  return <div className="project-sketch project-design" style={projectDesignStyle(value)}>
    <div className="project-sketch-pad">
      <svg viewBox="0 0 160 160" width="160" height="160" fill="none" stroke="currentColor" strokeWidth="3.5"
        strokeLinecap="round" strokeLinejoin="round" aria-label="Draw a small project doodle with your mouse, pen, or touch" role="img"
        onPointerDown={(e) => {
          if (e.button !== 0 || active.current || value.strokes.length >= MAX_PROJECT_STROKES) return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          active.current = { pointer: e.pointerId, points: [point(e)] }
          setPointLimit(false)
          setDraft([...active.current.points])
        }} onPointerMove={(e) => {
          if (active.current?.pointer !== e.pointerId) return
          const points = active.current.points, next = point(e), last = points[points.length - 1]
          if (Math.hypot(next[0] - last[0], next[1] - last[1]) < 1) return
          if (points.length >= MAX_STROKE_POINTS) { setPointLimit(true); return }
          points.push(next)
          setDraft([...points])
        }} onPointerUp={(e) => finish(e)} onPointerCancel={(e) => finish(e, true)} onLostPointerCapture={(e) => finish(e, true)}>
        <SketchLines strokes={[...value.strokes, ...(draft.length ? [draft] : [])]} />
      </svg>
    </div>
    <div className="project-sketch-help"><strong>Your own little mark</strong><p>Draw with your mouse, pen, or finger. One color, a few lines.</p>
      <div><button type="button" disabled={!value.strokes.length} onClick={() => onChange({ ...value, strokes: value.strokes.slice(0, -1) })}>Undo</button>
        <button type="button" disabled={!value.strokes.length} onClick={() => { setPointLimit(false); onChange({ ...value, strokes: [] }) }}>Clear</button></div>
      <small role="status">{value.strokes.length >= MAX_PROJECT_STROKES ? 'Drawing full. Undo or clear to keep drawing.' : pointLimit ? 'Lift your pointer to start another line.' : 'Prefer a ready-made mark? Pick artwork above.'}</small>
    </div>
  </div>
}
