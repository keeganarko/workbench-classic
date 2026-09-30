/**
 * Name-based marks work on both machines without downloading images or saving
 * another copy of project metadata. Match whole words so a name like "Metadata"
 * does not accidentally become an education project. A normalized-name hash
 * gives unfamiliar names a repeatable monogram frame, independent of list order.
 */
export const PROJECT_SYMBOLS = {
  tools: 'M5 4h8l3 3-3 3H9v10H5V10H3V7h2Z M17 13l4 7',
  education: 'M2 8l10-5 10 5-10 5Z M6 10v6c3 3 9 3 12 0v-6 M22 8v8',
  compass: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M16 8l-3 5-5 3 3-5Z',
  globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M2 12h20 M12 2c-6 6-6 14 0 20 6-6 6-14 0-20Z',
  finance: 'M3 3v18h18 M7 17v-4 M12 17V9 M17 17V5 M6 9l5-4 4 1 5-4',
  radar: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M12 6a6 6 0 1 0 6 6 M12 12l7-7 M7 15h.01 M14 17h.01',
  research: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z M15 15l6 6 M7 10h6 M10 7v6',
  data: 'M3 6c0-5 18-5 18 0s-18 5-18 0Z M3 6v12c0 5 18 5 18 0V6 M3 12c0 5 18 5 18 0',
  voice: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0Z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8',
  code: 'M8 6l-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18'
} as const
export type ProjectSymbol = keyof typeof PROJECT_SYMBOLS

const rules: [RegExp, ProjectSymbol][] = [
  [/\b(workbench|workshop|tooling)\b/, 'tools'],
  [/\b(mba|school|university|study|learning|education|course)\b/, 'education'],
  [/\b(voyager|travel|journey|explorer|atlas)\b/, 'compass'],
  [/\b(website|web|homepage|portfolio|site)\b/, 'globe'],
  [/\b(finances?|budget|accounting|investing|money)\b/, 'finance'],
  [/\b(mission control|control|operations|command)\b/, 'radar'],
  [/\b(research|science|discovery|lab)\b/, 'research'],
  [/\b(data|datasets?|analytics|database)\b/, 'data'],
  [/\b(wispr|flow|voice|dictation|audio)\b/, 'voice'],
  [/\b(code|api|sdk|app|software)\b/, 'code']
]

export function projectIdentity(name: string): { symbol: ProjectSymbol | null; initials: string; frame: number } {
  const normalized = name.normalize('NFKC')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const words = normalized.split(' ').filter(Boolean)
  const letters = words.length > 1
    ? [Array.from(words[0])[0], Array.from(words[words.length - 1])[0]]
    : Array.from(words[0] ?? 'p').slice(0, 2)
  let hash = 2166136261
  for (const char of normalized) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0
  return { symbol: rules.find(([pattern]) => pattern.test(normalized))?.[1] ?? null,
    initials: Array.from(letters.join('').toUpperCase()).slice(0, 2).join(''), frame: hash % 4 }
}
