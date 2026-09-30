/**
 * Agent reports are small, attributed claims, separate from lifecycle events.
 * The same closed vocabulary is checked at the bus and disk boundaries; no
 * report can supply executable visuals, arbitrary embeds or terminal state.
 */
export const FOCUS_UPDATE_LIMIT = 240
export const FOCUS_UPDATES_PER_SESSION = 6
export const FOCUS_VISUAL_ITEMS = 4
export const FOCUS_SUMMARY_LENGTH = 180
export const FOCUS_NEXT_LENGTH = 140
export const FOCUS_LABEL_LENGTH = 48
export const FOCUS_VALUE_LENGTH = 32
export const FOCUS_IMAGE_PATH_LENGTH = 4096

export type FocusUpdateKind = 'update' | 'milestone' | 'blocked' | 'decision'
export type FocusVisual =
  | { kind: 'steps'; items: { label: string; state: 'done' | 'active' | 'pending' }[] }
  | { kind: 'metrics'; items: { label: string; value: string }[] }
  | { kind: 'image'; path: string; alt: string }
export interface FocusUpdateInput {
  kind: FocusUpdateKind
  summary: string
  next?: string
  visual?: FocusVisual
}
export interface FocusUpdate extends FocusUpdateInput {
  id: string
  sessionId: string
  projectId: string
  at: number
}

const KINDS = new Set(['update', 'milestone', 'blocked', 'decision'])
const STATES = new Set(['done', 'active', 'pending'])
const INPUT_FIELDS = ['kind', 'summary', 'next', 'visual']

function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !fields.includes(key))) {
    throw new Error('Invalid Focus update fields')
  }
  return value as Record<string, unknown>
}

function plain(value: unknown, max: number, name: string): string {
  // These cards render plain text, but reject markup and links at ingress too
  // so later visual types cannot accidentally turn stored text into an embed.
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || /[<>\u0000-\u001f\u007f-\u009f]/u.test(value)
    || /\b(?:https?|ftp|file|data|javascript|vbscript|mailto):|\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|(?:^|\s)\/\/\S+|!?\[[^\]]*\]\([^)]*\)/iu.test(value)) {
    throw new Error(`Invalid Focus ${name}: use plain text up to ${max} characters, without HTML or URLs`)
  }
  return value.trim()
}

/** Identity, project, timestamp and report ID are deliberately not inputs. */
export function validateFocusUpdateInput(value: unknown): FocusUpdateInput {
  const raw = record(value, INPUT_FIELDS)
  if (typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) throw new Error('Invalid Focus update kind')
  const result: FocusUpdateInput = { kind: raw.kind as FocusUpdateKind,
    summary: plain(raw.summary, FOCUS_SUMMARY_LENGTH, 'summary') }
  if (Object.hasOwn(raw, 'next')) result.next = plain(raw.next, FOCUS_NEXT_LENGTH, 'next step')
  if (Object.hasOwn(raw, 'visual')) {
    const visual = record(raw.visual, ['kind', 'items', 'path', 'alt'])
    if (visual.kind === 'image') {
      record(raw.visual, ['kind', 'path', 'alt'])
      const imagePath = plain(visual.path, FOCUS_IMAGE_PATH_LENGTH, 'image path')
      if (!/\.(?:png|jpe?g|webp|svg)$/i.test(imagePath)) throw new Error('Focus images must be PNG, JPEG, WebP or SVG files')
      result.visual = { kind: 'image', path: imagePath, alt: plain(visual.alt, FOCUS_SUMMARY_LENGTH, 'image description') }
      return result
    }
    record(raw.visual, ['kind', 'items'])
    if (!Array.isArray(visual.items) || visual.items.length < 1 || visual.items.length > FOCUS_VISUAL_ITEMS) {
      throw new Error(`Focus visuals require 1 to ${FOCUS_VISUAL_ITEMS} items`)
    }
    if (visual.kind === 'steps') {
      result.visual = { kind: 'steps', items: Array.from(visual.items, (item) => {
        const row = record(item, ['label', 'state'])
        if (typeof row.state !== 'string' || !STATES.has(row.state)) throw new Error('Invalid Focus step state')
        return { label: plain(row.label, FOCUS_LABEL_LENGTH, 'label'), state: row.state as 'done' | 'active' | 'pending' }
      }) }
    } else if (visual.kind === 'metrics') {
      result.visual = { kind: 'metrics', items: Array.from(visual.items, (item) => {
        const row = record(item, ['label', 'value'])
        return { label: plain(row.label, FOCUS_LABEL_LENGTH, 'label'), value: plain(row.value, FOCUS_VALUE_LENGTH, 'metric') }
      }) }
    } else throw new Error('Invalid Focus visual kind')
  }
  return result
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,200}$/u.test(value)) throw new Error('Invalid saved Focus identity')
  return value
}

/** Keep newest reports in input order, with a single cap across all projects. */
export function boundFocusUpdates(updates: readonly FocusUpdate[], keep: (update: FocusUpdate) => boolean = () => true): FocusUpdate[] {
  const counts = new Map<string, number>(), ids = new Set<string>(), result: FocusUpdate[] = []
  for (const update of updates) {
    const count = counts.get(update.sessionId) ?? 0
    if (count >= FOCUS_UPDATES_PER_SESSION || ids.has(update.id) || !keep(update)) continue
    result.push(update)
    ids.add(update.id)
    counts.set(update.sessionId, count + 1)
    if (result.length === FOCUS_UPDATE_LIMIT) break
  }
  return result
}

/** Older experience.json files omit this optional collection. Malformed saved
 * reports are discarded individually so they cannot disable valid schedules.
 * Limit the inspected prefix as well as the result to bound reload work. */
export function parseFocusUpdates(value: unknown): FocusUpdate[] {
  if (!Array.isArray(value)) return []
  const valid: FocusUpdate[] = []
  for (const item of value.slice(0, FOCUS_UPDATE_LIMIT)) {
    try {
      const raw = record(item, [...INPUT_FIELDS, 'id', 'sessionId', 'projectId', 'at'])
      const { id, sessionId, projectId, at, ...input } = raw
      if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at > 8.64e15) continue
      valid.push({ ...validateFocusUpdateInput(input), id: identity(id), sessionId: identity(sessionId),
        projectId: identity(projectId), at })
    } catch { /* A bad report is not authority to overwrite the rest of the store. */ }
  }
  return boundFocusUpdates(valid)
}
