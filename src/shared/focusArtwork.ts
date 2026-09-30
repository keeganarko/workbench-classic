import { taskText } from './sessionTitle'

export type FocusArtKind = 'finance' | 'design' | 'research' | 'writing' | 'security' | 'shipping' | 'knowledge' | 'planning' | 'coding' | 'desk'

const TOPICS: { kind: FocusArtKind; label: string; match: RegExp }[] = [
  { kind: 'knowledge', label: 'Building the brain', match: /\b(brain|obsidian|knowledge|memory|copilot|librarian)\b/i },
  { kind: 'security', label: 'Security review', match: /\b(security|vulnerabilit\w*|authenticat\w*|privacy|credential\w*|permission\w*|encrypt\w*)\b/i },
  { kind: 'finance', label: 'Money & planning', match: /\b(financ\w*|budget\w*|spending|saving\w*|invest\w*|portfolio|cash.flow|card\s+report|bank\w*)\b/i },
  { kind: 'design', label: 'Shaping the interface', match: /\b(design\w*|visual\w*|focus|artwork|illustrat\w*|icon\w*|layout\w*|css|figma|interface|low.poly|website)\b/i },
  { kind: 'shipping', label: 'Preparing delivery', match: /\b(deploy\w*|packag\w*|installer|release|shipping|publish\w*|rollout)\b/i },
  { kind: 'research', label: 'Exploring the evidence', match: /\b(research\w*|investigat\w*|analy[sz]\w*|compar\w*|audit\w*|review\w*|test\w*|debug\w*|browser|voyager)\b/i },
  { kind: 'writing', label: 'Putting it into words', match: /\b(writ\w*|content|copy|document\w*|essay\w*|mba|admission\w*|story|summari\w*)\b/i },
  { kind: 'planning', label: 'Connecting the work', match: /\b(plann\w*|coordinat\w*|roadmap|project.manager|organ[iz]\w*|handoff\w*|milestone\w*|mission.control)\b/i },
  { kind: 'coding', label: 'Building the pieces', match: /\b(code|coding|engineer\w*|software|implement\w*|backend|frontend|api|bug\w*|fix\w*|build\w*|workbench)\b/i }
]

/** A small, local illustration of the subject, never a completion signal.
 * Prefer the current agent report, then the current request, then its role.
 * A role such as Financial Analyst must not override a new UI task. Keeping
 * lifecycle out of the input also prevents a color/status change from swapping
 * the scene. No transcript reads, images, network calls or inference are needed. */
export function focusArtwork(input: { id: string; title: string; task?: string; summary?: string }): {
  kind: FocusArtKind; label: string; variant: number
} {
  for (const source of [input.summary, input.task, input.title]) {
    const clean = taskText((source ?? '').slice(0, 1200))
    const topic = TOPICS.find((candidate) => candidate.match.test(clean))
    if (topic) return { kind: topic.kind, label: topic.label, variant: variant(input.id) }
  }
  return { kind: 'desk', label: 'A workspace of their own', variant: variant(input.id) }
}

function variant(id: string): number {
  let hash = 0
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0
  return (hash >>> 0) % 3
}
