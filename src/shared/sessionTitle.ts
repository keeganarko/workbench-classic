/**
 * A stable job title and a separate reminder of the latest work.
 *
 * This intentionally does not call another model. Naming must also work for a
 * custom agent, offline, and before the first turn has finished. The title is
 * a two-word company role. Agent identity and live status already have badges;
 * the latest task belongs underneath the role rather than inside its name.
 */

import type { Session } from './types.js'
import { relayPreamble } from './relay.js'

const LEADING_REQUEST = new RegExp(
  '^(?:please\\s+)?(?:' +
    '(?:can|could|would|will)\\s+you\\s+|' +
    "i(?:'d| would)?\\s+like\\s+you\\s+to\\s+|" +
    'i\\s+(?:want|need)\\s+you\\s+to\\s+|' +
    'help\\s+me\\s+(?:to\\s+)?' +
    ')+',
  'i'
)

/** Words that make a clipped title read as though half a thought is missing. */
const WEAK_TAIL = new Set(['a', 'an', 'and', 'at', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with'])

/** Delivery instructions explain who should receive an answer, not the work
 * being done. Match the actual Workbench preamble so a peer's role and the
 * word "blocked" cannot become a task title. A saved summary may contain only
 * the beginning of a banner; that has no recoverable work and stays empty.
 *
 * Claude's background-task notices likewise contain tool IDs and output paths,
 * not a new human request or an assistant outcome. Only recognize a notice at
 * the start of the input with its known metadata tag. Generic XML, or prose
 * discussing these tags, must remain available as the person's actual task.
 * Returning empty text lets existing prompt/reply ingestion keep lastTask;
 * this helper does not change status, relay attribution, or terminal content.
 */
function taskEnvelopeText(input: string): string {
  let text = input.replace(/\r\n/g, '\n').trimStart()
  const relay = text.match(/^\[relay from (?:the "([^\n]*)" session|the Workbench composer)\]/)
  if (relay) {
    for (const waiting of [false, true]) {
      const preamble = relayPreamble(relay[1] ?? null, waiting)
      if (preamble.startsWith(text.trimEnd())) return ''
      if (text.startsWith(preamble) && /^\s/.test(text.slice(preamble.length))) {
        text = text.slice(preamble.length).trimStart()
        break
      }
    }
  }
  while (/^<task-notification>\s*<(?:task-id|tool-use-id)>/i.test(text)) {
    const end = text.toLowerCase().indexOf('</task-notification>')
    if (end < 0) return ''
    text = text.slice(end + '</task-notification>'.length).trimStart()
      .replace(/^Read the output file to retrieve the result:[^\n]*(?:\n|$)/, '').trimStart()
  }
  return text
}

/** Strip launch envelopes before either classifying a role or writing a task
 * reminder. Repository instructions and tool output describe the environment,
 * not what the person asked this conversation to work on. */
export function taskText(prompt: string): string {
  let text = prompt
    .replace(/<(environment_context|INSTRUCTIONS|system_reminder)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/^# AGENTS\.md instructions[^\n]*$/gm, '')
    .replace(/```[\s\S]*?```/g, ' ')
  text = taskEnvelopeText(text)
  const task = text.match(/(?:^|\n)Task:\s*\n([\s\S]*)$/i)
  if (task) text = taskEnvelopeText(task[1])
  return text
    .replace(/^I am handing you an in-progress session[\s\S]*?— read it first\.\s*/i, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/^\s*(?:#{1,6}|[-+]\s+)\s*/gm, '')
    .replace(/\s+/g, ' ').trim()
}

/** Ordered from specific work to broad disciplines. These are job roles, not
 * task titles: a software engineer remains one while fixing a second feature.
 * Explicit assignments win; implementation language wins over a product's
 * subject, so building a finance app does not make its developer an advisor. */
const ROLE_RULES: [string, RegExp][] = [
  ['Software Engineer', /\b(?:implement|refactor|debug|codebase|typescript|javascript|react|electron|frontend|backend)\b|\b(?:build|fix|repair|update|add)\b.{0,80}\b(?:app|application|software|code|feature|interface|sidebar|component|bug|scheduler|updater|hook|api)\b/i],
  ['Security Analyst', /\b(?:security|vulnerabilit\w*|authentication|authorization|threat model|penetration test|encryption)\b/i],
  ['Quality Engineer', /\b(?:unit tests?|regression tests?|flaky|test coverage|test suite|quality assurance|qa)\b/i],
  ['Infrastructure Engineer', /\b(?:deployment|deploy|ci\/cd|continuous integration|docker|kubernetes|infrastructure|release pipeline|packaging|installer)\b/i],
  ['Product Manager', /\b(?:product strategy|roadmap|prd|product requirements|feature priorit\w*|user stories|product spec)\b/i],
  ['Project Manager', /\b(?:project plan|sprint plan\w*|milestone|coordinate|delegat\w*|manage (?:the |these |my )?agents)\b/i],
  ['Product Designer', /\b(?:figma|wireframe\w*|mockup\w*|ux|ui design|user experience|design system|visual design)\b/i],
  ['Financial Advisor', /\b(?:financ\w*|budget\w*|spending|income|retirement|invest\w*|portfolio|net worth|cash flow|taxes|debt|savings|expenses|groceries|money|stocks|banking|accounting|recurring charges)\b/i],
  ['Data Analyst', /\b(?:data analysis|analy[sz]e (?:the |this |my )?data|dataset\w*|spreadsheet\w*|csv|metrics|statistics|dashboard)\b/i],
  ['Career Coach', /\b(?:career|resume|cv|cover letter|job search|job interview|interview prep)\b/i],
  ['Travel Planner', /\b(?:travel|itinerary|vacation|holiday|flights|hotels|trip)\b/i],
  ['Learning Coach', /\b(?:teach|tutor|homework|study|exam|coursework|lesson|learning)\b/i],
  ['Legal Researcher', /\b(?:legal|contract|legislation|regulation|case law|lawsuit)\b/i],
  ['Health Coach', /\b(?:fitness|workout|nutrition|exercise|meal plan|health|sleep routine)\b/i],
  ['Technical Writer', /\b(?:documentation|readme|technical guide|setup instructions|api docs)\b/i],
  ['Content Writer', /\b(?:copywriting|blog|newsletter|article|writing|write|edit|proofread|social media|caption)\b/i],
  ['Business Analyst', /\b(?:business|sales|market research|competitor|competitive|pricing strategy)\b/i],
  ['Research Analyst', /\b(?:research|compare|comparison|literature|sources|investigate|review|summari[sz]e)\b/i],
  ['Software Engineer', /\b(?:software|programming|developer|coding|repository|workbench|code|app|application|git)\b/i]
]
export const SESSION_ROLES = [...new Set([...ROLE_RULES.map(([role]) => role), 'Central Coordinator', 'General Assistant', 'Terminal Operator'])]

export function explicitSessionRole(prompt: string): string | null {
  const text = taskText(prompt)
  for (const role of SESSION_ROLES) {
    if (text.toLowerCase() === role.toLowerCase()) return role
    if (new RegExp(`\\b(?:act as|you are|be my|your role is|role:|title:)\\s+(?:(?:a|an|the|my|senior|expert)\\s+)*${role}\\b`, 'i').test(text)) return role
  }
  return null
}

export function autoSessionTitle(prompt: string, _agentLabel?: string): string | null {
  const text = taskText(prompt)
  return explicitSessionRole(text) ?? ROLE_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? null
}

export function contextSessionTitle(agent: string, projectName = '', cwd = ''): string {
  if (agent === 'shell') return 'Terminal Operator'
  const folder = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? ''
  return autoSessionTitle(projectName.replace(/[-_]/g, ' '))
    ?? autoSessionTitle(folder.replace(/[-_]/g, ' ')) ?? 'General Assistant'
}

export function purposeFromPrompt(prompt: string, maxChars = 72, maxWords = 9): string | null {
  let text = taskText(prompt)

  if (!text || /^(?:yes|no|ok(?:ay)?|thanks?|thank you|continue|keep going|go ahead|do it|proceed|try again|looks good)[.!\s]*$/i.test(text)) return null
  text = text.replace(/^please\s+/i, '').replace(LEADING_REQUEST, '').trim()
  text = text.replace(/^(?:now|also)[,:]?\s+/i, '')
  text = text.replace(/^take a look at\s+/i, 'Review ')
  text = text.replace(/^look at\s+/i, 'Review ')

  // A second instruction usually describes execution detail, not the purpose.
  const sentence = text.match(/^.*?(?=[.!?](?:\s|$)|$)/)?.[0]?.trim() || text
  const words = sentence.split(/\s+/).filter(Boolean)
  let clipped = words.slice(0, maxWords)
  while (clipped.length > 1 && WEAK_TAIL.has(clipped.at(-1)!.toLowerCase())) clipped = clipped.slice(0, -1)

  let purpose = clipped.join(' ').replace(/[,:;.!?\-–—]+$/g, '').trim()
  if (purpose.length > maxChars) {
    purpose = purpose.slice(0, maxChars + 1).replace(/\s+\S*$/, '').trim()
  }
  if (!purpose) return null

  return purpose[0].toUpperCase() + purpose.slice(1)
}

export function sessionTaskSummary(session: Pick<Session, 'lastTask'>): string {
  return session.lastTask?.trim() || 'No task summary yet.'
}

/**
 * Remove legacy decorations when recovering the work behind an old title.
 * Current sessions already contain a plain role and pass through unchanged.
 *
 * This is presentation rather than a rename because stored titles also serve
 * as addresses for mentions and relays. Cleaning up a row must not change how
 * another running agent finds that conversation. Older launches put the agent
 * and folder first, while prompt-derived names put the agent last, so handle
 * both forms and custom profile labels. Only a delimited edge is decoration:
 * "Fix the Codex adapter" still describes the work and must remain intact.
 *
 * Before the first prompt a launch may have nothing but those decorations.
 * Say "New session" until a purpose exists instead of exposing the folder as
 * a task. The working directory remains available in the opened pane's footer.
 */
export function sidebarSessionTitle(
  session: Pick<Session, 'title' | 'agent' | 'cwd'> & Partial<Pick<Session, 'forkKind'>>,
  agentLabel: string
): string {
  const folder = session.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || '/'
  // A handoff can carry both its source and destination agent in the title.
  const labels = [agentLabel, session.agent, 'Codex CLI', 'Codex', 'Claude Code', 'Claude']
  const decorations = [...new Set([...labels, session.cwd, folder].filter(Boolean))]
  const lineage = !!session.forkKind && session.forkKind !== 'root'
  const separator = lineage ? '[·•:—–→]' : '[·•:—–]'
  let title = session.title.trim()

  // A legacy title can contain several decorations, e.g. agent / folder /
  // purpose, and their order varied. Each pass must shorten the string, which
  // gives the loop a natural bound without guessing how many wrappers exist.
  let previous: string
  do {
    previous = title
    // The row already has a lineage badge. Restrict this cleanup to actual
    // forks so an ordinary task describing "Claude → Codex" keeps its meaning.
    if (lineage) title = title.replace(/(?:\s+↳\s+(?:child|parallel))+$/, '')
    for (const decoration of decorations) {
      const literal = decoration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      title = title
        .replace(new RegExp(`^${literal}(?:\\s*${separator}\\s*|\\.\\s+|\\s+-\\s+)`, 'i'), '')
        .replace(new RegExp(`(?:\\s*${separator}\\s*|\\s+\\.\\s+|\\s+-\\s+)${literal}$`, 'i'), '')
        .trim()
    }
  } while (title !== previous)

  return !title || decorations.some((decoration) => title.toLowerCase() === decoration.toLowerCase())
    ? 'New session'
    : title
}
