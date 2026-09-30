/**
 * The agent registry: one table that says what an agent *is*.
 *
 * Before this file, "which agents exist" was the union
 * `AgentKind = 'claude' | 'codex' | 'shell'`, and the consequences of that union
 * were spread across a dozen files — an if/else chain in the launch builder, two
 * `Record<AgentKind, string>` maps in the renderer, three CSS variables, a
 * literal `['claude', 'codex']` in every dialog, and a `switch` in the
 * validator. Adding a fourth agent meant finding all of them.
 *
 * Now an agent is a row here, and the rest of the app asks this file.
 *
 * ## What a definition may and may not claim
 *
 * `capabilities` is the load-bearing part, and it is a statement about a CLI's
 * real command line, not a wish. Workbench only ever passes `--resume` to a CLI
 * that documents `--resume`. An agent that declares nothing still works
 * perfectly well: it launches in tmux, appears everywhere agents appear, takes
 * broadcast input, and reports status through the text-pattern triggers that
 * have always been the fallback for a CLI with no notification hook. What it
 * does not get is native fork, transcript export, or a context percentage —
 * because those need a file format we have actually read.
 *
 * This is why the three built-ins are the only ones shipped with launch flags.
 * Anyone can add `gemini`, `aider` or `cursor-agent` as a custom profile and it
 * will run; what we will not do is guess at another CLI's resume syntax and
 * hand a user a session that silently starts a fresh conversation.
 */

/**
 * How Workbench builds the argv for one launch.
 *
 * `plain` is the honest default — the binary, its configured arguments, and
 * nothing invented. The other two are the CLIs whose flags we know because
 * their behaviour is pinned by tests.
 */
export type LaunchStrategy = 'claude' | 'codex' | 'plain'

/** What a CLI can do, as far as Workbench is concerned. Each flag costs code. */
export interface AgentCapabilities {
  /** Reopen the CLI's own earlier conversation by its id. */
  resume: boolean
  /** Branch a conversation rather than continue it, leaving the parent intact. */
  fork: boolean
  /** Reports turn boundaries to us, so status is observed rather than guessed. */
  hooks: boolean
  /** Keeps a transcript we can read: export, handoff, and the context figure. */
  transcript: boolean
  /** Takes a model name at launch. */
  model: boolean
  /** Takes a reasoning-effort setting at launch. */
  effort: boolean
  /** Understands anything beyond `default` permission mode. */
  permissions: boolean
}

/** Nothing claimed. The starting point for any agent we have not verified. */
export const NO_CAPABILITIES: AgentCapabilities = {
  resume: false,
  fork: false,
  hooks: false,
  transcript: false,
  model: false,
  effort: false,
  permissions: false
}

export interface AgentDefinition {
  /** Registry key. Also the value stored on every session and descriptor. */
  id: string
  label: string
  /** Executable to look for on PATH. */
  bin: string
  /** Argv every launch of this agent carries. */
  args: string[]
  /** Any CSS colour. Builtins carry their brand; custom ones are user-picked. */
  color: string
  capabilities: AgentCapabilities
  launch: LaunchStrategy
  /**
   * True for the agents this app knows intimately enough to have written
   * transcript parsers and hook bridges for. False for anything the user added,
   * which is a launch and a set of text triggers.
   */
  builtin: boolean
}

/**
 * The shape a user-defined agent is stored in.
 *
 * Deliberately small: a name, something to run, and a colour to tell it apart.
 * Everything else a built-in has is knowledge about a specific CLI, which is
 * not something a settings form can supply.
 */
export interface CustomAgent {
  id: string
  label: string
  /** A bare name is looked up on PATH; an absolute path is used as given. */
  command: string
  args: string[]
  color: string
}

const CLAUDE: AgentDefinition = {
  id: 'claude',
  label: 'Claude Code',
  bin: 'claude',
  args: [],
  color: '#d97757',
  launch: 'claude',
  builtin: true,
  capabilities: {
    resume: true,
    fork: true,
    hooks: true,
    transcript: true,
    model: true,
    // Claude takes effort through the model string rather than a flag of its own.
    effort: false,
    permissions: true
  }
}

const CODEX: AgentDefinition = {
  id: 'codex',
  label: 'Codex CLI',
  bin: 'codex',
  args: [],
  color: '#10a37f',
  launch: 'codex',
  builtin: true,
  capabilities: {
    resume: true,
    fork: true,
    hooks: true,
    transcript: true,
    model: true,
    effort: true,
    permissions: true
  }
}

/**
 * Not an agent, and kept in the same registry anyway.
 *
 * A plain login shell in a pane is the thing you want next to three agents, and
 * every list, filter, colour and layout that handles agents should handle it
 * too. Declaring no capabilities is exactly right: there is no conversation to
 * resume and no transcript to read.
 */
const SHELL: AgentDefinition = {
  id: 'shell',
  label: 'Shell',
  bin: '',
  args: ['-l'],
  color: '#8b949e',
  launch: 'plain',
  builtin: true,
  capabilities: NO_CAPABILITIES
}

export const BUILTIN_AGENTS: AgentDefinition[] = [CLAUDE, CODEX, SHELL]

/** Ids the app has code for, as opposed to configuration. */
export const BUILTIN_IDS = BUILTIN_AGENTS.map((a) => a.id)

/**
 * Presets offered in Settings, so adding a known CLI is one click rather than
 * three fields.
 *
 * Each is a command name and nothing more, which is the whole point: these are
 * the agents whose *existence* is well known and whose *flags* this project has
 * not verified. A preset that guessed at `--resume` syntax would be worse than
 * no preset, because a wrong resume flag starts a brand new conversation and
 * looks like it worked.
 */
export const AGENT_PRESETS: Omit<CustomAgent, 'id'>[] = [
  { label: 'Gemini CLI', command: 'gemini', args: [], color: '#4285f4' },
  { label: 'Cursor Agent', command: 'cursor-agent', args: [], color: '#a371f7' },
  { label: 'Aider', command: 'aider', args: [], color: '#e3b341' },
  { label: 'OpenCode', command: 'opencode', args: [], color: '#56d364' }
]

/**
 * Registry keys are used in filenames, tmux session names and CSS class names,
 * so they are restricted to the characters all three agree on. Checked at the
 * IPC boundary; see `asAgentKind`.
 */
export function isAgentId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value)
}

/** Turns a label into a usable id: "Gemini CLI" → "gemini-cli". */
export function slugifyAgentId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return /^[a-z]/.test(slug) ? slug : `agent-${slug}`.slice(0, 32).replace(/-+$/, '')
}

/** A user-defined agent as a full definition. Claims nothing it cannot do. */
export function customDefinition(custom: CustomAgent): AgentDefinition {
  return {
    id: custom.id,
    label: custom.label,
    bin: custom.command,
    args: custom.args,
    color: custom.color,
    launch: 'plain',
    builtin: false,
    capabilities: NO_CAPABILITIES
  }
}

/** Every agent this install knows about: the built-ins, then the user's own. */
export function allDefinitions(custom: CustomAgent[] = []): AgentDefinition[] {
  const seen = new Set(BUILTIN_IDS)
  const extra: AgentDefinition[] = []
  for (const c of custom) {
    // A custom agent may not shadow a built-in: the built-in owns a hook bridge
    // and a transcript parser that the override would silently disable.
    if (seen.has(c.id)) continue
    seen.add(c.id)
    extra.push(customDefinition(c))
  }
  return [...BUILTIN_AGENTS, ...extra]
}

/** The definition for an id, or null when nothing in this install matches. */
export function findDefinition(id: string, custom: CustomAgent[] = []): AgentDefinition | null {
  return allDefinitions(custom).find((d) => d.id === id) ?? null
}

/**
 * The definition for an id, always.
 *
 * A session on disk can name an agent the user has since deleted, and the whole
 * app would otherwise have to handle a null on every row it draws. This returns
 * a placeholder that renders correctly and can do nothing — which is the truth
 * about a deleted profile, and lets the session stay visible so its history is
 * still reachable.
 */
export function definitionOr(id: string, custom: CustomAgent[] = []): AgentDefinition {
  return (
    findDefinition(id, custom) ?? {
      id,
      label: id,
      bin: id,
      args: [],
      color: '#8b949e',
      launch: 'plain',
      builtin: false,
      capabilities: NO_CAPABILITIES
    }
  )
}

export function agentLabel(id: string, custom: CustomAgent[] = []): string {
  return definitionOr(id, custom).label
}

export function agentColor(id: string, custom: CustomAgent[] = []): string {
  return definitionOr(id, custom).color
}

/** Does this agent claim `cap`? False for anything unknown, which is the safe answer. */
export function agentCan(
  id: string,
  cap: keyof AgentCapabilities,
  custom: CustomAgent[] = []
): boolean {
  return definitionOr(id, custom).capabilities[cap]
}
