/**
 * Projects and workspaces — where a session's files actually live.
 *
 * Before this existed, "Start both" opened Claude and Codex in the same folder
 * with no explanation. Two agents editing one working tree is occasionally what
 * you want and usually a disaster: they overwrite each other's edits, and the
 * diff at the end belongs to neither of them. The fix is not to forbid it, it
 * is to make the choice explicit and to make the isolated option real.
 *
 * The model:
 *   - **Project** — one repository, identified by its shared `.git` directory
 *     so that every worktree of it maps back to the same project.
 *   - **Workspace** — one working copy: the main checkout, a git worktree, or a
 *     plain folder that is not a repository at all.
 *   - **Session** — an agent running inside a workspace.
 *
 * The safety rules here are the whole point of the file, and each one exists
 * because the alternative loses somebody's work:
 *   - Mutations are serialized per repository. Two `git worktree add` calls at
 *     once race on `.git/worktrees` and one of them fails with a lock error.
 *   - A worktree Workbench did not create is never removed by Workbench.
 *   - A worktree with uncommitted changes is never removed without an explicit
 *     confirmation, and the caller is told where the work is so it is
 *     recoverable by hand.
 *   - A failed create cleans up what that create made, and nothing else.
 *
 * No Electron import: `dataDir` is a string and git is injected, so this runs
 * under a plain Node test against a real repository.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Project, Workspace, WorkspaceMode } from '../shared/types.js'
import {
  branchExists,
  describeProject,
  isDirty,
  listWorktrees,
  readHeadBranch,
  toBranchName,
  uniqueName
} from './git.js'
import type { GitRunner, ProjectInfo } from './git.js'
import { toHostPath } from './host.js'

export interface WorkspaceDeps {
  git: GitRunner
  /** App data directory; worktrees are created under `<dataDir>/worktrees`. */
  dataDir: string
  /** Called after any change, so the caller can persist. */
  onChange?: () => void
}

/** What `create` was asked for and what it produced. */
export interface CreateWorkspaceRequest {
  /** Any directory inside the project, or the plain folder to use as-is. */
  cwd: string
  /** Used for the branch and directory name. */
  title?: string
  mode: WorkspaceMode
}

export interface RemoveResult {
  removed: boolean
  /** Why not, phrased for a person. Empty when `removed` is true. */
  reason: string | null
  /** Where the files are, so anything unsaved can still be recovered by hand. */
  path: string
}

export class WorkspaceManager {
  private readonly projects = new Map<string, Project>()
  private readonly workspaces = new Map<string, Workspace>()
  /** One promise chain per repository: git's index and worktree list are not concurrency-safe. */
  private readonly queues = new Map<string, Promise<unknown>>()

  private readonly deps: WorkspaceDeps

  // Written out longhand rather than as a constructor parameter property:
  // Node's strip-only TypeScript rejects those, and this file is loaded
  // directly by `node --test`.
  constructor(deps: WorkspaceDeps) {
    this.deps = deps
  }

  // ── restore ────────────────────────────────────────────────────────────────

  /** Re-adopts persisted state at launch. Entries whose files are gone are dropped. */
  load(projects: Project[], workspaces: Workspace[]): void {
    this.projects.clear()
    this.workspaces.clear()
    for (const p of projects) this.projects.set(p.id, p)
    for (const w of workspaces) {
      // A worktree the user deleted by hand between launches is not an error,
      // it is just gone. Keeping the row would show a workspace that opens
      // nothing.
      if (!dirExists(w.path)) continue
      this.workspaces.set(w.id, w)
    }
  }

  listProjects(): Project[] {
    return Array.from(this.projects.values())
  }

  /** The records as stored. This is what gets persisted. */
  list(): Workspace[] {
    return Array.from(this.workspaces.values())
  }

  /**
   * The same workspaces, each reporting the branch its folder is on *now*.
   *
   * This is what the renderer gets, and it is a different thing from `list`.
   * The stored `branch` is whatever the folder was on when it was adopted, and
   * it is right for exactly as long as nobody runs `git checkout` there. For a
   * worktree that is usually forever. For the `main` kind — "the repository as
   * you found it" — it is wrong by the end of the afternoon.
   *
   * That mattered because the pane footer and the Settings worktree list both
   * present this value as the answer to "which branch is this agent committing
   * to". A footer reading `⎇ windows-wslg` over a checkout that has since moved
   * to `librarian` is the exact failure the row was added to prevent, and it is
   * worse than showing nothing: an agent that reads it believes it.
   *
   * The record itself is left alone deliberately. Writing the live value back
   * would turn a twice-a-second read into a twice-a-second save, and the stored
   * branch is a fact about the workspace's origin, not about the checkout's
   * present state.
   *
   * A folder that is not a repository, or is momentarily unreadable, keeps its
   * recorded value: for a `local` workspace that is null anyway, and for a
   * repository the last known branch beats a blank.
   */
  listLive(): Workspace[] {
    return this.list().map((w) => {
      if (!w.projectId) return w
      const live = readHeadBranch(w.path)
      return live === null || live === w.branch ? w : { ...w, branch: live }
    })
  }

  get(id: string): Workspace | undefined {
    return this.workspaces.get(id)
  }

  // ── resolve ────────────────────────────────────────────────────────────────

  /**
   * What git thinks of a folder, or null if it is not in a repository.
   *
   * The dialog asks this before offering worktrees: "isolate this" is not an
   * option worth showing for a folder with nothing to branch.
   */
  describe(cwd: string): Promise<ProjectInfo | null> {
    return describeProject(this.deps.git, canonical(cwd))
  }

  /**
   * Repositories sitting directly inside a folder.
   *
   * People keep their projects in one drawer — `~/Dev` holding six checkouts —
   * and pointing the dialog at the drawer is the obvious first move. Without
   * this it is a dead end: the folder is not a repository, so the worktree
   * options grey out with nothing to click and no hint that the repository the
   * user meant is one level down.
   */
  reposInside(cwd: string): { name: string; path: string }[] {
    return findRepos(canonical(cwd))
  }

  /**
   * The workspace for "just start here": the folder as it stands.
   *
   * A repository becomes a project and the folder becomes a `main` or already-
   * imported `worktree` workspace. A folder that is not a repository becomes a
   * `local` workspace, which works exactly as before — running an agent in a
   * plain directory is a legitimate thing to do and must not require git.
   */
  async adopt(cwd: string): Promise<Workspace> {
    const dir = canonical(cwd)
    const existing = this.list().find((w) => w.path === dir)
    if (existing) return existing

    const info = await describeProject(this.deps.git, dir)
    if (!info) return this.record(localWorkspace(dir))

    const project = this.upsertProject(info)
    const trees = await listWorktrees(this.deps.git, dir)
    const entry = trees.find((t) => samePath(t.path, dir))

    return this.record({
      id: newId('ws'),
      projectId: project.id,
      name: path.basename(dir),
      path: dir,
      kind: entry?.isMain === false ? 'worktree' : 'main',
      branch: entry?.branch ?? info.branch,
      // Anything found rather than made is imported, and imported worktrees are
      // never removed by this app.
      createdByApp: false,
      createdAt: Date.now()
    })
  }

  // ── create ─────────────────────────────────────────────────────────────────

  /**
   * Creates the workspaces one launch needs.
   *
   * `shared` is one workspace both agents open; `isolated` is one per agent, on
   * sibling branches, so the two attempts can be compared instead of merged by
   * accident. `current` is the old behaviour, kept because opening the folder
   * you are looking at is still the common case.
   */
  async create(req: CreateWorkspaceRequest, count = 1): Promise<Workspace[]> {
    const dir = canonical(req.cwd)

    if (req.mode === 'current') {
      const ws = await this.adopt(dir)
      return Array.from({ length: count }, () => ws)
    }

    const info = await describeProject(this.deps.git, dir)
    if (!info) {
      // Not a repository: there is nothing to branch from. Say so plainly
      // rather than silently downgrading to a shared folder, because the whole
      // reason to pick isolation is that you did not want a shared folder.
      throw new Error(
        `${dir} is not a Git repository, so it cannot be given an isolated worktree. Start in the folder instead.`
      )
    }

    const project = this.upsertProject(info)
    const wanted = req.mode === 'isolated' ? count : 1
    const made: Workspace[] = []
    for (let i = 0; i < wanted; i += 1) {
      const suffix = wanted > 1 ? `-${i + 1}` : ''
      made.push(await this.addWorktree(project, `${req.title || 'session'}${suffix}`))
    }
    // Shared mode: one workspace, handed to every agent.
    return req.mode === 'isolated' ? made : Array.from({ length: count }, () => made[0])
  }

  /**
   * Adds one worktree, serialized against every other mutation of this repo.
   *
   * The main checkout is not touched: `git worktree add` writes a new directory
   * and a ref, and leaves `HEAD` where it was.
   */
  private addWorktree(project: Project, title: string): Promise<Workspace> {
    return this.serialize(project.id, async () => {
      const git = this.deps.git
      const taken = new Set<string>()
      for (const t of await listWorktrees(git, project.root)) {
        if (t.branch) taken.add(t.branch)
      }
      let branch = uniqueName(toBranchName(title), taken)
      // `uniqueName` only knows about checked-out branches; a stale branch with
      // no worktree would still collide on `worktree add -b`.
      while (await branchExists(git, project.root, branch)) {
        branch = uniqueName(`${branch}-x`, taken)
        taken.add(branch)
      }

      const dir = this.worktreePath(project, branch)
      fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 })

      const from = project.defaultBranch ?? 'HEAD'
      // `dir` is ours to `fs.mkdirSync`, so it stays native everywhere else in
      // this method; git is the one process that has to be told the host's
      // name for it.
      const add = await git(['worktree', 'add', '-b', branch, toHostPath(dir), from], project.root)
      if (add.code !== 0) {
        throw new Error(`Could not create a worktree: ${firstError(add.stderr) || 'git failed'}`)
      }

      const ws: Workspace = {
        id: newId('ws'),
        projectId: project.id,
        name: path.basename(dir),
        path: dir,
        kind: 'worktree',
        branch,
        createdByApp: true,
        createdAt: Date.now()
      }

      try {
        return this.record(ws)
      } catch (err) {
        // Clean up exactly what this call made — the worktree and its branch —
        // and nothing else.
        await git(['worktree', 'remove', '--force', toHostPath(dir)], project.root)
        await git(['branch', '-D', branch], project.root)
        throw err
      }
    })
  }

  // ── remove ─────────────────────────────────────────────────────────────────

  /**
   * Removes a workspace Workbench created.
   *
   * Refuses in two cases, and the refusal is the feature: an imported worktree
   * is somebody else's, and a dirty one holds work that exists nowhere else.
   * `force` covers the second only — never the first.
   */
  remove(workspaceId: string, opts: { force?: boolean } = {}): Promise<RemoveResult> {
    const ws = this.workspaces.get(workspaceId)
    if (!ws) return Promise.resolve({ removed: false, reason: 'No such workspace', path: '' })

    if (ws.kind === 'local' || ws.kind === 'main') {
      return Promise.resolve({
        removed: false,
        reason: 'That is the folder you opened, not a workspace Workbench created',
        path: ws.path
      })
    }
    if (!ws.createdByApp) {
      return Promise.resolve({
        removed: false,
        reason: 'That worktree already existed — Workbench does not delete worktrees it did not create',
        path: ws.path
      })
    }

    const project = ws.projectId ? this.projects.get(ws.projectId) : undefined
    if (!project) {
      return Promise.resolve({ removed: false, reason: 'Its project is no longer known', path: ws.path })
    }

    return this.serialize(project.id, async () => {
      const git = this.deps.git
      if (!opts.force && (await isDirty(git, ws.path))) {
        return {
          removed: false,
          reason: 'That worktree has uncommitted changes',
          path: ws.path
        }
      }

      const res = await git(
        ['worktree', 'remove', ...(opts.force ? ['--force'] : []), toHostPath(ws.path)],
        project.root
      )
      if (res.code !== 0) {
        return { removed: false, reason: firstError(res.stderr) || 'git refused', path: ws.path }
      }

      // The branch outlives the worktree on purpose. Deleting it here would
      // throw away committed work, which is the one thing that should never
      // happen by accident.
      this.workspaces.delete(ws.id)
      this.deps.onChange?.()
      return { removed: true, reason: null, path: ws.path }
    })
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Runs `job` after every other job queued for this repository.
   *
   * Git serializes its own index with lock files and reports contention as a
   * hard failure, so "two worktrees at once" would surface to the user as a
   * random `.git/worktrees.lock` error on whichever call lost.
   */
  private serialize<T>(projectId: string, job: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(projectId) ?? Promise.resolve()
    const next = prev.then(job, job)
    // Keep the chain alive after a failure: a rejected link must not stop the
    // jobs queued behind it, and must not surface as an unhandled rejection.
    this.queues.set(
      projectId,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  private upsertProject(info: {
    root: string
    commonDir: string
    origin: string | null
    defaultBranch: string | null
  }): Project {
    const id = projectIdFor(info.commonDir)
    const existing = this.projects.get(id)
    const project: Project = {
      id,
      name: path.basename(info.root),
      root: info.root,
      commonDir: info.commonDir,
      origin: info.origin,
      defaultBranch: info.defaultBranch
    }
    // Refresh rather than skip: the default branch can be renamed, and a stale
    // one would branch every future workspace off the wrong place.
    if (!existing || !sameProject(existing, project)) {
      this.projects.set(id, project)
      this.deps.onChange?.()
      return project
    }
    return existing
  }

  private record(ws: Workspace): Workspace {
    this.workspaces.set(ws.id, ws)
    this.deps.onChange?.()
    return ws
  }

  /** `<dataDir>/worktrees/<project>/<branch-slug>` — outside the repo, always. */
  private worktreePath(project: Project, branch: string): string {
    const leaf = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '') || 'workspace'
    return path.join(this.deps.dataDir, 'worktrees', `${project.name}-${project.id}`, leaf)
  }
}

/** Stable per repository, because the shared git dir is what identifies one. */
export function projectIdFor(commonDir: string): string {
  return crypto.createHash('sha256').update(path.resolve(commonDir)).digest('hex').slice(0, 12)
}

function localWorkspace(dir: string): Workspace {
  return {
    id: newId('ws'),
    projectId: null,
    name: path.basename(dir) || dir,
    path: dir,
    kind: 'local',
    branch: null,
    createdByApp: false,
    createdAt: Date.now()
  }
}

function sameProject(a: Project, b: Project): boolean {
  return (
    a.root === b.root &&
    a.commonDir === b.commonDir &&
    a.origin === b.origin &&
    a.defaultBranch === b.defaultBranch
  )
}

function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b)
}

/**
 * The one true spelling of a directory.
 *
 * Symlinks are the reason. git always reports the resolved path, macOS hands
 * out a symlinked `/tmp`, and plenty of people keep their code under a
 * symlinked folder. Comparing what the user typed against what git printed
 * would then say "different directory" about the same directory — which would
 * file a worktree as a main checkout, or adopt one folder twice.
 *
 * Falls back to `resolve` for a path that does not exist yet.
 */
function canonical(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * The immediate subdirectories of `dir` that are Git repositories.
 *
 * Deliberately one level deep and filesystem-only: this runs while the user is
 * typing, so it must not shell out to git once per candidate, and it must not
 * walk a home directory looking for needles. `.git` is tested with `existsSync`
 * rather than `isDirectory` because a worktree checkout's `.git` is a *file*
 * pointing at the real git dir — checking for a directory would hide exactly
 * the checkouts this feature creates.
 */
export function findRepos(dir: string): { name: string; path: string }[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .filter((c) => fs.existsSync(path.join(c.path, '.git')))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .slice(0, 40)
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** git puts the useful sentence first and the advice after it. */
function firstError(stderr: string): string {
  return (
    stderr
      .split('\n')
      .map((l) => l.replace(/^fatal:\s*/, '').trim())
      .find((l) => l.length > 0) ?? ''
  )
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`
}
