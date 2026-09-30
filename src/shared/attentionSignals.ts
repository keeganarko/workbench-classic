/**
 * Attention is a request to the person, not a word found in an agent's report.
 * These conservative rules inspect the final request only. They deliberately
 * do not run terminal permission patterns over assistant prose: a quoted
 * dialog, a checklist and a reply to another agent are all ordinary output.
 */
export function finalHumanRequest(message: string | null, relayTurn = false): string | null {
  if (!message || relayTurn) return null
  let fenced = false
  const lines = message.slice(-8000).split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return '\u0000' }
    if (fenced || /^\s*(>|["“]|`)/.test(line)) return '\u0000'
    return line
  })
  const last = lines.join('\n').trim().split(/\n\s*\n/).at(-1)?.trim()
  if (!last || last.length > 800) return null
  const sentence = last.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).at(-1)?.trim().replace(/^\*\*(.*?)\*\*$/, '$1') ?? ''
  // Optional follow-on offers do not block completed work. A real request
  // either asks a direct question or explicitly asks for a missing decision.
  const question = /^(?:Which\b|What\b|Where\b|When\b|Who\b|How\b|Do you\b|Are you\b|Have you\b|Can you\b|Could you\b|Will you\b|Should I\b|May I\b)[^\n\u0000]*\?$/i.test(sentence)
  const request = /^Please (?:confirm|choose|clarify|provide|select|tell me|specify)\b[^\n\u0000]*[.?]?$/i.test(sentence)
  return (question || request) && sentence.length <= 500 ? sentence : null
}

/** The relay envelope is created by Workbench, not guessed from message topics. */
export function isAgentRelayPrompt(prompt: string | null | undefined): boolean {
  return typeof prompt === 'string' && /^\[relay from /i.test(prompt.trimStart())
}

/** Exact fragments captured by the former built-in prose regex on disk. */
export function isLegacyProseReason(reason: string | null): boolean {
  return typeof reason === 'string' && /^(?:Which (?:option|approach)|Please (?:confirm|choose|clarify)|Would you like)$/i.test(reason.trim())
}

/** A user's edited rule remains theirs, even if it retains a shipped ID. */
export function isLegacyProseTrigger(rule: { id: string; pattern: string; flags: string; agent: string; action: string }): boolean {
  return rule.id === 'codex-question' && rule.agent === 'codex' && rule.action === 'waiting' && rule.flags === 'i' &&
    rule.pattern === '(Which (option|approach)|Please (confirm|choose|clarify)|\\bWould you like\\b)'
}

/** Only shipped, unedited terminal rules need the tighter dialog boundary. */
export function isDefaultCodexDialogTrigger(rule: { id: string; pattern: string; flags: string; agent: string; action: string }): boolean {
  if (rule.agent !== 'codex' || rule.action !== 'waiting' || rule.flags !== 'i') return false
  return (rule.id === 'codex-approval' && rule.pattern === '(Allow command|Approve this|Do you want to (allow|proceed)|\\[y/n\\]|\\(y/N\\))') ||
    (rule.id === 'codex-trust' && rule.pattern === '(Do you (trust|want to trust)|allow Codex to work in|Yes, (allow|proceed))')
}

/**
 * A dialog is current only while its question or response controls end the
 * captured screen. Old phrases above a result/composer are inert. This remains
 * a fallback for CLIs paused before hooks start; lifecycle approvals carry
 * their own stronger signal and never pass through this text check.
 */
export function hasActiveCodexDialog(text: string): boolean {
  const tail = text.slice(-2400).trim()
  const lines = tail.split('\n').map(line => line.trim()).filter(Boolean)
  if (!lines.length) return false
  const last = lines.at(-1)!
  const heading = /^(?:[›❯]\s*)?(?:Allow command\b|Approve this\b|Do you want to (?:allow|proceed)\b|Do you (?:want to )?trust\b|Would you like to run\b|allow Codex to work in\b)/i
  let fenced = false, currentHeading = -1
  lines.forEach((line, index) => {
    if (/^(?:```|~~~)/.test(line)) fenced = !fenced
    else if (!fenced && heading.test(line)) currentHeading = index
  })
  if (currentHeading < 0 || fenced) return false
  if (currentHeading === lines.length - 1 && /(?:\?|\[y\/n\]|\(y\/n\))\s*$/i.test(last)) return true
  const footer = /^(?:press\s+)?(?:enter|return) to (?:submit|confirm|continue)(?:\s*\|?\s*(?:or\s+)?esc(?:ape)? to cancel)?[.\s]*$/i.test(last)
  const yes = lines.slice(currentHeading).some(line => /^[›❯]?\s*\d+[.)]\s*Yes,?\s+(?:allow|proceed|continue)\b/i.test(line))
  const no = /^[›❯]?\s*\d+[.)]\s*No\b/i.test(last)
  return footer || (yes && no)
}
