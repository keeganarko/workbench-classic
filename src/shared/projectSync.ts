export interface SyncConflict { path: string; localDeleted: boolean; remoteDeleted: boolean }
export interface ProjectSyncState {
  projectId: string
  repository: string
  folder: string
  enabled: boolean
  status: 'idle' | 'syncing' | 'conflict' | 'error' | 'paused'
  lastSyncAt: number | null
  error: string | null
  conflicts: SyncConflict[]
}
export interface SyncPreview { files: string[]; bytes: number; excluded: number }

/** These names are portable across Windows/macOS and never name app state. */
export function syncPathAllowed(file: string): boolean {
  if (!file || file.length > 800 || file.startsWith('/') || file.includes('\\') || /[\x00-\x1f:*?"<>|]/.test(file)) return false
  const parts = file.split('/')
  return parts.every((part) => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    && !/^(?:\.git|\.github|\.svn|node_modules|\.next|\.cache|\.venv|venv|__pycache__|out|dist|release|coverage|\.workbench[^/]*|\.ssh|\.aws|\.codex|\.claude)$/i.test(part)
    && !/^(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials(?:\.json)?|workbench\.json|experience\.json|project-sync\.json)$/i.test(part)
    && !/\.(?:pem|key|p12|pfx|log)$/i.test(part))
}

export function githubRepository(raw: string): string {
  const value = raw.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git\/?$/, '').replace(/\/$/, '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(value)
    || value.split('/')[1] === '.' || value.split('/')[1] === '..') throw new Error('Use a GitHub owner/repository name or GitHub repository URL.')
  return value
}
