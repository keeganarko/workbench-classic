/**
 * The visual pane's small shared contract.
 *
 * This stays free of React and Electron because main needs to know when a
 * session owns a visual pane, while the renderer needs to decide which
 * artifacts belong on its canvas. Keeping those two answers here prevents a
 * Markdown report from opening as "art" in one process while the other still
 * treats it as a document.
 */

import { classifyPreview } from './preview.js'
import type { PreviewKind } from './preview.js'
import type { LayoutNode } from './types.js'

/**
 * The visual surface favours response latency over deep repository reasoning.
 *
 * These are launch-time values rather than global Codex preferences: opening
 * a canvas must not silently make the user's ordinary coding sessions shallower.
 * Keeping them beside the visual prompt also gives tests and every launcher one
 * source of truth for what "visual mode" means operationally.
 */
export const VISUAL_AGENT = 'codex'
export const VISUAL_MODEL = 'gpt-5.6-luna'
export const VISUAL_EFFORT = 'low'

/** Kinds that are themselves visual, rather than text rendered for reading. */
export const VISUAL_PREVIEW_KINDS: ReadonlySet<PreviewKind> = new Set<PreviewKind>([
  'html',
  'image',
  'svg',
  'pdf',
  'url'
])

export function isVisualPreviewKind(kind: PreviewKind): boolean {
  return VISUAL_PREVIEW_KINDS.has(kind)
}

export function isVisualPath(filePath: string): boolean {
  const kind = classifyPreview(filePath)
  return kind !== null && isVisualPreviewKind(kind)
}

/** True when this layout currently gives the session a visual canvas. */
export function hasVisualPane(node: LayoutNode, sessionId: string): boolean {
  if (node.type === 'leaf') {
    return node.view === 'visual' && node.sessionId === sessionId
  }
  return node.children.some((child) => hasVisualPane(child, sessionId))
}

/**
 * Turns one conversational direction into a visual-mode turn.
 *
 * The terminal still receives ordinary text because Claude Code, Codex and
 * user-added agents all speak that common interface. The instruction makes
 * the file the answer, and `workbench show` gives the app an explicit path as
 * soon as it exists. Repeating the contract is intentional: the same session
 * may also be visible in a terminal pane and take non-visual turns between two
 * edits to the artwork.
 */
export function visualPrompt(direction: string, artifactPath?: string): string {
  const current = artifactPath
    ? `The current artifact is ${JSON.stringify(artifactPath)}. Update or replace it directly; do not search the workspace for another candidate.`
    : 'There is no current artifact yet. Create one self-contained HTML file in the current working directory and keep using it for follow-up turns.'

  return `[Workbench visual pane]
Make the visual itself the response. This is a fast, animated visual turn, not an image-generation task.

Default medium: one self-contained HTML file with inline CSS and SVG or Canvas. For scenes, stories, characters, environments, diagrams, simulations, and "show me" requests, animation is mandatory even when the direction does not use the word animated. Do not use image generation and do not output a PNG, JPG, static SVG, or PDF unless the direction explicitly asks for a still image, photograph, poster, or that exact format. Do not simulate animation by panning, zooming, filtering, or placing particles over a static image; construct the moving subjects in HTML, SVG, or Canvas so their pose or geometry actually changes.

The first frame must look composed and finished. Motion must become obvious within one second, loop continuously, and include at least three independently moving details when the subject is a scene: primary subject translation, articulated pose or body/object motion, and environmental motion or parallax. For running characters, animate their travel, stride, opposing arm and leg swings, and body bounce—not merely the camera. If the current artifact is static or only animates effects over a still but the requested experience implies motion, replace it with animated HTML while preserving the subject and visual direction.

${current}

Inspect only the current artifact and files directly required to edit it. Do not inventory the repository or run broad project tests. Keep using the same artifact across follow-up turns unless the direction clearly asks for a new piece. Do not stop at a plan, put the result in a Markdown code block, or answer with a prose walkthrough. Validate only the artifact, then run \`workbench show <path>\` so the canvas refreshes.

Direction:
${direction.trim()}`
}
