/**
 * The desktop app supplies plain text, not a privileged editor protocol.
 * These helpers resolve names against a finite list of real project files.
 * Ambiguities stay visible for the user to choose; dictation never guesses a
 * filesystem path or silently changes the selected session.
 */
import type { FlowAutoTransform } from './flowContext.js'

export interface FlowStatus {
  platform: 'windows' | 'mac' | 'wsl' | 'unsupported'
  installed: boolean
  appName: string | null
  shortcut: string
  detail: string
  /**
   * Flow's own "Auto Apply After Dictation" choice, read from its config so
   * Settings can say whether Prompt Engineer will rewrite the next dictation.
   * `null` means Workbench could not read it; Flow owns the setting and
   * Workbench never writes it.
   */
  autoTransform: FlowAutoTransform | null
}
export interface DictationFiles { files: string[]; truncated: boolean }
export interface FileReference {
  start: number
  end: number
  spoken: string
  files: string[]
}
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const words = (text: string): string[] => text
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean)
const patternFor = (text: string): string => words(text).map(escapeRegex).join('[\\s_-]*')
export function isReferencePath(file: string): boolean {
  return file.length <= 512 && !file.startsWith('/') && !/[\\\x00-\x1f`"<>]/.test(file) &&
    !/^[A-Za-z]:/.test(file) && file.split('/').every(p => p && p !== '..' && !p.startsWith('.'))
}
export function findFileReferences(text: string, files: string[]): FileReference[] {
  if (!text || text.length > 50000) return []
  const found = new Map<string, FileReference>()
  for (const file of [...new Set(files)].slice(0, 2000)) {
    if (!isReferencePath(file)) continue
    const base = file.split('/').at(-1) || ''
    const dot = base.lastIndexOf('.')
    if (dot <= 0 || dot === base.length - 1) continue
    const stem = base.slice(0, dot), extension = base.slice(dot + 1)
    const stemPattern = patternFor(stem)
    if (!stemPattern) continue
    const patterns = [
      '(?:@\\s*)?' + escapeRegex(file),
      '(?:@\\s*)?' + escapeRegex(base),
      '(?:@\\s*)?' + stemPattern + '(?:\\s+dot\\s+|[.\\s_-]+)' + escapeRegex(extension),
      '(?:@\\s*|\\b(?:tag|tagged|at)\\s+)' + stemPattern
    ]
    for (const pattern of patterns) {
      const regex = new RegExp('(?<![\\p{L}\\p{N}_/`])(?:' + pattern + ')(?![\\p{L}\\p{N}_/`-]|\\.[\\p{L}\\p{N}_])', 'giu')
      for (const match of text.matchAll(regex)) {
        const start = match.index, end = start + match[0].length
        // A user-authored code span is already explicit. Inserting another
        // backtick path inside it would corrupt the prompt's formatting.
        if (text.slice(0, start).split('`').length % 2 === 0) continue
        const key = start + ':' + end
        const old = found.get(key) || { start, end, spoken: match[0], files: [] }
        if (!old.files.includes(file)) old.files.push(file)
        found.set(key, old)
      }
    }
  }
  const sorted = [...found.values()].sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)
  const selected: FileReference[] = []
  for (const match of sorted) {
    if (selected.some(previous => match.start < previous.end && match.end > previous.start)) continue
    match.files.sort()
    selected.push(match)
    if (selected.length === 8) break
  }
  return selected.sort((a, b) => a.start - b.start)
}
export function replaceFileReference(text: string, reference: FileReference, file: string): string | null {
  if (!reference.files.includes(file) || !isReferencePath(file) || text.slice(reference.start, reference.end) !== reference.spoken) return null
  return text.slice(0, reference.start) + '`' + file + '`' + text.slice(reference.end)
}
export function insertTranscript(
  current: string, expected: string, start: number, end: number, transcript: string
): { text: string; caret: number } | null {
  if (current !== expected || !transcript || transcript.length > 50000 || /\x00/.test(transcript)) return null
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > current.length) return null
  return { text: current.slice(0, start) + transcript + current.slice(end), caret: start + transcript.length }
}
