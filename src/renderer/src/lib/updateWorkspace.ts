import type { ComposerScope } from '../../../shared/composer'

export interface ComposerWorkspace {
  composerDraft: string
  experienceProjectId: string | null
  composerScope: ComposerScope
  composerTargets: Record<string, boolean>
}
const KEY = 'workbench.composerWorkspace.v1'

/** This stays in Electron's profile, outside the application being replaced.
 * Saving only renderer-owned values leaves tabs and terminals with their
 * existing main-process persistence. A restored draft is never sent for you. */
export function saveComposerWorkspace(state: ComposerWorkspace): void {
  const { composerDraft, experienceProjectId, composerScope, composerTargets } = state
  localStorage.setItem(KEY, JSON.stringify({ composerDraft, experienceProjectId, composerScope, composerTargets }))
}

export function loadComposerWorkspace(): ComposerWorkspace | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as ComposerWorkspace
    if (!value || typeof value.composerDraft !== 'string' || value.composerDraft.length > 2 * 1024 * 1024
      || (value.experienceProjectId !== null && typeof value.experienceProjectId !== 'string')
      || !['pane', 'project', 'all'].includes(value.composerScope)
      || !value.composerTargets || typeof value.composerTargets !== 'object' || Array.isArray(value.composerTargets)
      || Object.values(value.composerTargets).some((v) => typeof v !== 'boolean')) return null
    return value
  } catch { return null }
}
