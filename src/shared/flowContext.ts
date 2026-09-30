/**
 * Wispr Flow "vibe coding" support: the pieces Workbench can mirror.
 *
 * Flow's Settings → Vibe coding page advertises two features. Both are keyed,
 * inside Flow's own helper process, on the *process name* of the focused
 * window being Cursor, VS Code or Windsurf:
 *
 * - Variable recognition reads the open file's identifiers through the
 *   accessibility tree once the IDE shows the "Screen Reader Optimized"
 *   indicator in its bottom bar. The helper looks for a status-bar control
 *   with exactly that name before it starts extracting.
 * - File tagging turns spoken "at foo.ts" into an `@foo.ts` chip in Cursor's
 *   and Windsurf's chat boxes.
 *
 * Workbench cannot be added to that list without modifying Flow, so this is
 * not an attempt to. What Flow *does* do for every other app is read text from
 * the focused control and its ancestor document through the same accessibility
 * tree — and Workbench already exposes terminal rows and the prompt through it
 * when the `terminalAccessibility` pref is on. So the honest integration is:
 *
 * 1. Mirror Flow's guided setup exactly — the same palette command name, the
 *    same bottom-bar indicator text, the same three steps — on top of the pref
 *    that already backs Chromium's accessibility support and xterm's
 *    screen-reader rows. A user who has done this in Cursor does the same in
 *    Workbench and gets the same signal.
 * 2. Keep Workbench's own `@file` matching for tagging (see `dictation.ts`).
 * 3. Put the active agent's name in the window title, because Flow's
 *    coding-CLI detection also inspects window titles. Whether that raises
 *    Flow's confidence enough to chunk long dictations for Claude Code the
 *    way it does in Windows Terminal is not verified; the title costs nothing
 *    and is useful on its own.
 *
 * The strings below are Flow's, verbatim. Do not "improve" them: a user reads
 * Flow's dialog and looks for these exact words.
 */

/** The IDE command Flow's setup dialog tells the user to run. */
export const SCREEN_READER_COMMAND = 'Toggle Screen Reader Accessibility Mode'

/** The bottom-bar flag Flow's setup dialog tells the user to look for. */
export const SCREEN_READER_INDICATOR = 'Screen Reader Optimized'

/** Flow's built-in transform that rewrites dictation into a structured prompt. */
export const PROMPT_ENGINEER = 'Prompt Engineer'

/** The Flow bar context-menu item that picks a transform to run on every dictation. */
export const FLOW_AUTO_APPLY_MENU = 'Auto Apply After Dictation'

/** Flow's setup steps, reworded only where the IDE-specific noun changes. */
export const VARIABLE_RECOGNITION_STEPS: ReadonlyArray<string> = [
  'Open the Command Palette',
  `Search for and run "${SCREEN_READER_COMMAND}"`,
  `Confirm the "${SCREEN_READER_INDICATOR}" flag appears in the bottom bar`
]

/**
 * Flow's `prefs.user.autoPolishAfterDictation` setting, reduced to the two
 * fields Workbench needs. Nothing else from Flow's config is ever surfaced —
 * that file also holds session tokens.
 */
export interface FlowAutoTransform {
  active: boolean
  promptName: string | null
}

const PROMPT_NAME_LIMIT = 80

/**
 * Pulls the auto-transform setting out of a parsed Flow `config.json`.
 * Returns `null` when the key is absent or malformed, which callers treat as
 * "unknown" rather than "off": Flow may have moved the key in a newer build.
 */
export function readFlowAutoTransform(config: unknown): FlowAutoTransform | null {
  if (!config || typeof config !== 'object') return null
  const prefs = (config as { prefs?: unknown }).prefs
  if (!prefs || typeof prefs !== 'object') return null
  const user = (prefs as { user?: unknown }).user
  if (!user || typeof user !== 'object') return null
  const raw = (user as { autoPolishAfterDictation?: unknown }).autoPolishAfterDictation
  if (!raw || typeof raw !== 'object') return null
  const { active, promptName } = raw as { active?: unknown; promptName?: unknown }
  if (typeof active !== 'boolean') return null
  const name = typeof promptName === 'string' ? promptName.trim().slice(0, PROMPT_NAME_LIMIT) : ''
  return { active, promptName: name.length > 0 ? name : null }
}

export type PromptEngineerState = 'on' | 'other' | 'off' | 'unknown'

/** How Flow will treat the next dictation, from Workbench's point of view. */
export function promptEngineerState(setting: FlowAutoTransform | null): PromptEngineerState {
  if (!setting) return 'unknown'
  if (!setting.active) return 'off'
  return setting.promptName === PROMPT_ENGINEER ? 'on' : 'other'
}

const TITLE_LABEL_LIMIT = 60
const APP_TITLE = 'Workbench'

/**
 * Window title for the active session: "Claude Code · Workbench". The agent
 * label leads because title-based detectors read from the front, and the app
 * name stays so the taskbar still says what the window is.
 */
export function flowWindowTitle(agentLabel: string | null | undefined): string {
  // Control characters would break the title; collapse them with whitespace.
  const label = (agentLabel ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (label.length === 0) return APP_TITLE
  return `${label.slice(0, TITLE_LABEL_LIMIT)} · ${APP_TITLE}`
}
