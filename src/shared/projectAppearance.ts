/**
 * A project's visual identity travels with its saved name, rather than its
 * position in the sidebar. Keep artwork as bounded points and named motifs:
 * the renderer can draw it at any size without storing markup or image files.
 */
export const PROJECT_COLORS = [
  { id: 'neutral', label: 'Ink', dark: '#c6c6c6', light: '#555555' },
  { id: 'sage', label: 'Sage', dark: '#9dccae', light: '#397451' },
  { id: 'blue', label: 'Blue', dark: '#92bafa', light: '#3868b5' },
  { id: 'amber', label: 'Amber', dark: '#edba78', light: '#95601c' },
  { id: 'rose', label: 'Rose', dark: '#ec9faa', light: '#ad4d62' },
  { id: 'violet', label: 'Violet', dark: '#bcabf5', light: '#7754b8' }
] as const
export type ProjectColor = typeof PROJECT_COLORS[number]['id']
export const PROJECT_ARTWORKS = [
  { id: 'none', label: 'From name' }, { id: 'sprout', label: 'Sprout' },
  { id: 'waves', label: 'Waves' }, { id: 'sun', label: 'Sun' },
  { id: 'orbit', label: 'Orbit' }, { id: 'sketch', label: 'Draw' }
] as const
export type ProjectArtwork = typeof PROJECT_ARTWORKS[number]['id']
export type ProjectPoint = [number, number]
export type ProjectStroke = ProjectPoint[]
export interface ProjectAppearance {
  color: ProjectColor
  artwork: ProjectArtwork
  strokes: ProjectStroke[]
}
export const PROJECT_THEMES = [
  { name: 'Ink', color: 'neutral', artwork: 'none' },
  { name: 'Grove', color: 'sage', artwork: 'sprout' },
  { name: 'Tide', color: 'blue', artwork: 'waves' },
  { name: 'Ember', color: 'amber', artwork: 'sun' },
  { name: 'Dusk', color: 'violet', artwork: 'orbit' }
] as const
export const MAX_PROJECT_STROKES = 40
export const MAX_STROKE_POINTS = 240
export const PROJECT_ART_SIZE = 160
export const defaultProjectAppearance = (): ProjectAppearance => ({ color: 'neutral', artwork: 'none', strokes: [] })

/**
 * Validate before changing any project fields. The same limits apply to IPC
 * and disk so a malformed drawing cannot grow every state push indefinitely.
 * Rebuild the point arrays to keep caller-owned edits out of durable state.
 */
export function validateProjectAppearance(input: unknown): ProjectAppearance {
  if (!input || typeof input !== 'object') throw new Error('Invalid project design')
  const raw = input as Record<string, unknown>
  if (!PROJECT_COLORS.some((c) => c.id === raw.color)) throw new Error('Choose a project color')
  if (!PROJECT_ARTWORKS.some((a) => a.id === raw.artwork)) throw new Error('Choose project artwork')
  if (!Array.isArray(raw.strokes) || raw.strokes.length > MAX_PROJECT_STROKES) throw new Error('Too many drawing strokes')
  const strokes = raw.strokes.map((stroke): ProjectStroke => {
    if (!Array.isArray(stroke) || !stroke.length || stroke.length > MAX_STROKE_POINTS) throw new Error('Invalid drawing stroke')
    return stroke.map((point): ProjectPoint => {
      if (!Array.isArray(point) || point.length !== 2 || point.some((n) =>
        typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > PROJECT_ART_SIZE)) throw new Error('Invalid drawing point')
      return [point[0], point[1]]
    })
  })
  return { color: raw.color as ProjectColor, artwork: raw.artwork as ProjectArtwork, strokes }
}

/** An old or damaged design must never make its project disappear on launch. */
export function readProjectAppearance(input: unknown): ProjectAppearance {
  try { return validateProjectAppearance(input) } catch { return defaultProjectAppearance() }
}
