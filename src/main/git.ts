/**
 * The `git` calls Workbench makes, and nothing more.
 *
 * Two rules shape this file:
 *
 *   - **Read-only unless asked.** Nothing here fetches, pulls, merges or checks
 *     anything out in the user's main working copy. A worktree is created
 *     beside the repository; the checkout you were already in is never touched.
 *   - **Porcelain, parsed.** Every command that has a `--porcelain` form uses
 *     it. Human-readable git output changes between versions and localises;
 *     the porcelain formats are contracts.
 *
 * The runner is injected so the whole module can be exercised against a real
 * repository in a temp directory, with no Electron and no mocking of git.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { hostSpawn, hostSpawnEnv, toHostPath, toNativePath } from './host.js'
import type { GitChange, GitFileChange, GitStatus } from '../shared/types.js'

export type { GitChange, GitFileChange, GitStatus }

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs one git invocation. Never throws for a non-zero exit — that is data. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>

/** Ceiling on git output we will buffer. A `worktree list` is never large. */
const MAX_GIT_OUTPUT = 8 * 1024 * 1024

/**
 * The two variables every invocation needs, kept in one place because they have
 * to be handed to both halves of the spawn — see the comment in the runner.
 *
 * Keeps git out of any interactive prompt: a hung credential helper inside a
 * background call would stall the whole app with nothing on screen to explain
 * why.
 */
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }

export const runGit: GitRunner = (args, cwd) => {
  // git runs on the *host*. On macOS and Linux that is a distinction without a
  // difference. On Windows the checkouts live inside the distro, and reaching
  // one over `\\wsl.localhost\…` with Windows git would be a different git
  // entirely: different config, different line-ending rules, and a
  // dubious-ownership refusal waiting on the far side of the share.
  //
  // The environment is handed to both halves because only one of them ever
  // reads it — `hostSpawn` turns it into `env K=V` arguments when the command
  // crosses into WSL, and `hostSpawnEnv` passes it through as a real
  // environment when it does not.
  const spawn = hostSpawn(['git', ...args], { cwd: toHostPath(cwd), env: GIT_ENV })
  return new Promise((resolve) => {
    execFile(
      spawn.file,
      spawn.args,
      {
        cwd: spawn.cwd,
        maxBuffer: MAX_GIT_OUTPUT,
        env: hostSpawnEnv({ ...process.env, ...GIT_ENV }),
        windowsHide: true,
        timeout: 30_000
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((err as unknown as { code: number }).code ?? 1)
            : err
              ? 1
              : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

/** A repository, as far as Workbench needs to know it. */
export interface ProjectInfo {
  /** Absolute path of the main working tree. */
  root: string
  /**
   * The repository's shared `.git` directory.
   *
   * This — not `root` — identifies a project, because every worktree of one
   * repository shares it. It is what stops two worktrees of the same repo being
   * treated as unrelated projects, and what the mutation queue is keyed on.
   */
  commonDir: string
  /** Branch checked out in the directory that was inspected, or null if detached. */
  branch: string | null
  /** `origin`, normalized so ssh and https forms of one remote compare equal. */
  origin: string | null
  /** Best guess at the integration branch: origin's HEAD, else main/master. */
  defaultBranch: string | null
}

/**
 * Describes the repository containing `dir`, or null when there isn't one.
 *
 * Null is an ordinary outcome, not an error: a plain folder is still a perfectly
 * good place to run an agent, it just cannot be given a worktree.
 */
export async function describeProject(run: GitRunner, dir: string): Promise<ProjectInfo | null> {
  const top = await run(['rev-parse', '--show-toplevel'], dir)
  if (top.code !== 0) return null
  // Absolute paths out of git are written in the host's spelling, and this is
  // where they enter the app. One conversion, here; native from then on.
  const root = toNativePath(firstLine(top.stdout))
  if (!root) return null

  const common = await run(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)
  const commonDir = common.code === 0 ? toNativePath(firstLine(common.stdout)) : ''

  const head = await run(['rev-parse', '--abbrev-ref', 'HEAD'], dir)
  const branchRaw = head.code === 0 ? firstLine(head.stdout) : ''
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null

  const remote = await run(['remote', 'get-url', 'origin'], dir)
  const origin = remote.code === 0 ? normalizeRemote(firstLine(remote.stdout)) : null

  return {
    root,
    commonDir: commonDir || path.join(root, '.git'),
    branch,
    origin,
    defaultBranch: await resolveDefaultBranch(run, dir, branch)
  }
}

/**
 * `origin` in a comparable form.
 *
 * `git@github.com:me/app.git` and `https://github.com/me/app` are the same
 * repository, and two sessions pointed at clones of one project should be
 * recognised as such rather than treated as strangers.
 */
export function normalizeRemote(url: string): string | null {
  const raw = url.trim()
  if (!raw) return null
  // scp-style: git@host:owner/repo(.git)
  const scp = /^[A-Za-z0-9._-]+@([^:]+):(.+)$/.exec(raw)
  const withoutScheme = scp
    ? `${scp[1]}/${scp[2]}`
    : raw.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '')
  // Trailing slashes first: a URL copied out of a browser address bar ends in
  // one, and stripping `.git` before it would leave the suffix behind.
  return withoutScheme.replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase() || null
}

async function resolveDefaultBranch(
  run: GitRunner,
  dir: string,
  fallback: string | null
): Promise<string | null> {
  const originHead = await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir)
  if (originHead.code === 0) {
    const ref = firstLine(originHead.stdout) // origin/main
    const name = ref.replace(/^origin\//, '')
    if (name) return name
  }
  for (const name of ['main', 'master']) {
    const exists = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], dir)
    if (exists.code === 0) return name
  }
  return fallback
}

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  path: string
  head: string | null
  branch: string | null
  /** The main working tree, which can never be removed. */
  isMain: boolean
  locked: boolean
  prunable: boolean
}

export async function listWorktrees(run: GitRunner, dir: string): Promise<WorktreeEntry[]> {
  const res = await run(['worktree', 'list', '--porcelain'], dir)
  if (res.code !== 0) return []
  // The parser stays pure — it is exercised against captured git output — so
  // the host-to-native conversion happens out here, where the git call is.
  return parseWorktreeList(res.stdout).map((w) => ({ ...w, path: toNativePath(w.path) }))
}

/**
 * Parses the porcelain worktree list.
 *
 * Records are blank-line separated and start with `worktree <path>`; the first
 * record is always the main working tree.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  let cur: WorktreeEntry | null = null

  const push = (): void => {
    if (cur) out.push(cur)
    cur = null
  }

  for (const line of stdout.split('\n')) {
    const text = line.replace(/\r$/, '')
    if (text === '') {
      push()
      continue
    }
    const sp = text.indexOf(' ')
    const key = sp === -1 ? text : text.slice(0, sp)
    const value = sp === -1 ? '' : text.slice(sp + 1)

    if (key === 'worktree') {
      push()
      cur = {
        path: value,
        head: null,
        branch: null,
        isMain: out.length === 0,
        locked: false,
        prunable: false
      }
    } else if (!cur) {
      continue
    } else if (key === 'HEAD') cur.head = value || null
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '') || null
    else if (key === 'locked') cur.locked = true
    else if (key === 'prunable') cur.prunable = true
  }
  push()
  return out
}

/** True when the working tree has any change git would not ignore. */
export async function isDirty(run: GitRunner, dir: string): Promise<boolean> {
  const res = await run(['status', '--porcelain', '--untracked-files=normal'], dir)
  if (res.code !== 0) return true // unreadable is not "clean"; refuse to delete it
  return res.stdout.trim().length > 0
}

/** True when `name` already exists as a local branch. */
export async function branchExists(run: GitRunner, dir: string, name: string): Promise<boolean> {
  const res = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], dir)
  return res.code === 0
}

/**
 * Turns a task title into a branch name git will accept.
 *
 * Deliberately strict rather than clever: lowercase, dashes, no leading or
 * trailing punctuation, no `..`, no `@{`, nothing git's ref rules reject.
 */
export function toBranchName(title: string, prefix = 'term'): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `${prefix}/${slug || 'session'}`
}

/** `main` → `main`, `main` taken → `main-2`, … Never returns a name in `taken`. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate)) return candidate
  }
  throw new Error(`Could not find an unused name based on ${base}`)
}

function firstLine(s: string): string {
  return s.split('\n')[0]?.trim() ?? ''
}

// ── review: status, diffs, and the three writes ─────────────────────────────

/**
 * What happened to one path, per side.
 *
 * Kept as two independent fields rather than one status because that is the
 * distinction the panel is *for*: a file can be staged as modified and modified
 * again since, and a review surface that collapsed those into one word would
 * hide exactly the case where it matters.
 */
const CHANGE_BY_CODE: Record<string, GitChange> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange'
}

/**
 * Parses `git status --porcelain=v1 -z`.
 *
 * `-z` is not an optimisation: without it git quotes and escapes any path with
 * a space or a non-ASCII byte in it, and a review panel that mangles the name
 * of the file you are about to stage is worse than no panel. With `-z` the
 * records are NUL-terminated and the bytes are literal.
 */
export function parseStatusPorcelain(stdout: string): GitFileChange[] {
  const parts = stdout.split('\0')
  const out: GitFileChange[] = []

  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i]
    if (record.length < 4) continue // "XY p" is the shortest possible entry
    const x = record[0]
    const y = record[1]
    const filePath = record.slice(3)

    if (x === '?' && y === '?') {
      out.push({ path: filePath, staged: null, unstaged: 'untracked', from: null })
      continue
    }
    if (x === '!' && y === '!') continue // ignored, and we never ask for these

    // A rename or copy is followed by its source as the next NUL-separated
    // field, so the loop has to consume two records for one entry.
    let from: string | null = null
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i += 1
      from = parts[i] ?? null
    }

    // Unmerged paths are any of DD AU UD UA DU AA UU. They are one state, not
    // two sides, and staging one by accident is how a conflict gets committed
    // half-resolved — so both sides say `conflicted` and the UI refuses.
    const unmerged = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
    if (unmerged) {
      out.push({ path: filePath, staged: 'conflicted', unstaged: 'conflicted', from })
      continue
    }

    out.push({
      path: filePath,
      staged: CHANGE_BY_CODE[x] ?? null,
      unstaged: CHANGE_BY_CODE[y] ?? null,
      from
    })
  }

  return out
}

/** `git rev-list --left-right --count <upstream>...HEAD` → behind, ahead. */
export function parseAheadBehind(stdout: string): { ahead: number; behind: number } {
  const [behind, ahead] = firstLine(stdout).split(/\s+/).map((n) => Number.parseInt(n, 10))
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0
  }
}

/** Everything the review panel shows above the file list, in one round trip set. */
export async function readStatus(run: GitRunner, dir: string): Promise<GitStatus | null> {
  const info = await describeProject(run, dir)
  if (!info) return null

  const res = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], dir)
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git status failed')

  const head = await run(['rev-parse', '--verify', '--quiet', 'HEAD'], dir)
  const unborn = head.code !== 0

  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  if (!unborn) {
    const up = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], dir)
    if (up.code === 0) {
      upstream = firstLine(up.stdout) || null
      if (upstream) {
        const counts = await run(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], dir)
        if (counts.code === 0) ({ ahead, behind } = parseAheadBehind(counts.stdout))
      }
    }
  }

  return {
    root: info.root,
    branch: info.branch,
    defaultBranch: info.defaultBranch,
    upstream,
    ahead,
    behind,
    files: parseStatusPorcelain(res.stdout),
    unborn
  }
}

/**
 * Which comparison a diff is asking for.
 *
 * `branch` is the one that makes this a review surface rather than a git
 * client: it is everything this working copy has done since it diverged from
 * the integration branch, which is the question you actually have about an
 * agent that has been running for an hour on its own worktree.
 */
export type DiffSide = 'worktree' | 'staged' | 'branch'

/** git spells the null device this way on every platform, Windows included. */
const NULL_DEVICE = '/dev/null'

export interface DiffRequest {
  side: DiffSide
  /** Repository-relative path, or null for the whole tree. */
  file?: string | null
  /** `branch` only: what to compare against. Defaults to the default branch. */
  base?: string | null
  /** The file has never been added, so there is no index entry to diff against. */
  untracked?: boolean
}

/** Patches beyond this are cut short: nothing reviews 4 MB of diff in a pane. */
export const MAX_PATCH_BYTES = 2 * 1024 * 1024

export interface DiffResult {
  patch: string
  truncated: boolean
  /** What the patch is of, for the pane's title: `main…HEAD`, `Staged`, … */
  label: string
}

export async function readDiff(
  run: GitRunner,
  dir: string,
  req: DiffRequest
): Promise<DiffResult> {
  // `--no-ext-diff` because a user with `diff.external` configured would
  // otherwise have their difftool run — producing output that is not a patch,
  // or launching a GUI out of a background call.
  const common = ['--no-color', '--no-ext-diff', '-M']
  const pathArgs = req.file ? ['--', req.file] : []

  let args: string[]
  let label: string

  if (req.untracked) {
    if (!req.file) throw new Error('An untracked diff needs a file')
    // A file git has never seen has nothing to compare against, so compare it
    // with nothing — which is exactly what `--no-index` against the null device
    // spells. It exits 1 for "they differ", which here is the normal case.
    args = ['diff', ...common, '--no-index', '--', NULL_DEVICE, req.file]
    label = 'New file'
  } else if (req.side === 'staged') {
    args = ['diff', '--cached', ...common, ...pathArgs]
    label = 'Staged'
  } else if (req.side === 'branch') {
    const base = req.base?.trim()
    if (!base) throw new Error('No branch to compare against')
    const mergeBase = await run(['merge-base', base, 'HEAD'], dir)
    // Two-dot from the merge base rather than `base..HEAD`, so commits that
    // landed on the base branch after this one forked are not reported as this
    // session having deleted them.
    const from = mergeBase.code === 0 ? firstLine(mergeBase.stdout) : base
    args = ['diff', ...common, from, ...pathArgs]
    label = `${base}…working tree`
  } else {
    args = ['diff', ...common, ...pathArgs]
    label = 'Unstaged'
  }

  const res = await run(args, dir)
  // `git diff` exits 1 when there are differences under `--no-index`, and 0
  // otherwise; only stderr distinguishes a real failure.
  if (res.code !== 0 && res.stderr.trim()) throw new Error(res.stderr.trim())

  const patch = res.stdout
  if (patch.length <= MAX_PATCH_BYTES) return { patch, truncated: false, label }
  // Cut after the newline, not before it: what comes back is still a complete
  // text file, and the last thing the reviewer reads is a whole line of code
  // rather than half of one.
  const cut = patch.lastIndexOf('\n', MAX_PATCH_BYTES)
  return { patch: patch.slice(0, cut > 0 ? cut + 1 : MAX_PATCH_BYTES), truncated: true, label }
}

export async function stagePaths(run: GitRunner, dir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const res = await run(['add', '--', ...paths], dir)
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git add failed')
}

/**
 * Takes a path back out of the index without touching the file.
 *
 * Before the first commit there is no HEAD to reset against, so the same
 * intention has to be spelled `rm --cached` — which is why this is a function
 * and not a one-liner at the call site.
 */
export async function unstagePaths(run: GitRunner, dir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const head = await run(['rev-parse', '--verify', '--quiet', 'HEAD'], dir)
  const res =
    head.code === 0
      ? await run(['reset', '--quiet', 'HEAD', '--', ...paths], dir)
      : await run(['rm', '--cached', '--quiet', '--', ...paths], dir)
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git reset failed')
}

/** Commits what is staged. Never `-a`: the panel decides what is in, not git. */
export async function commitStaged(
  run: GitRunner,
  dir: string,
  message: string
): Promise<{ sha: string; subject: string }> {
  const text = message.trim()
  if (!text) throw new Error('A commit needs a message')

  const staged = await run(['diff', '--cached', '--name-only'], dir)
  if (staged.code === 0 && staged.stdout.trim() === '') {
    throw new Error('Nothing is staged. Stage a file first.')
  }

  const res = await run(['commit', '--message', text], dir)
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || 'git commit failed')
  }
  const sha = await run(['rev-parse', '--short', 'HEAD'], dir)
  return { sha: sha.code === 0 ? firstLine(sha.stdout) : '', subject: firstLine(text) }
}

/**
 * Pushes the current branch, setting an upstream the first time.
 *
 * This is the one call in the file that leaves the machine, and it never
 * happens on its own: it runs only when someone clicks the button that names
 * the remote and the branch it is about to write to.
 */
export async function pushCurrent(
  run: GitRunner,
  dir: string
): Promise<{ remote: string; branch: string; created: boolean }> {
  const head = await run(['rev-parse', '--abbrev-ref', 'HEAD'], dir)
  const branch = head.code === 0 ? firstLine(head.stdout) : ''
  if (!branch || branch === 'HEAD') throw new Error('HEAD is detached — nothing to push')

  const up = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], dir)
  const created = up.code !== 0
  const res = created
    ? await run(['push', '--set-upstream', 'origin', branch], dir)
    : await run(['push'], dir)
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git push failed')

  const remote = created ? 'origin' : firstLine(up.stdout).split('/')[0] || 'origin'
  return { remote, branch, created }
}

// ── which branch a checkout is on, right now ──────────────────────────────────

/**
 * Reads a checkout's current branch by reading `HEAD`, synchronously.
 *
 * This exists because a workspace record's `branch` is written once, when the
 * folder is adopted, and is then wrong forever after the first `git checkout`
 * anyone runs in that directory. For a worktree that hardly matters — a
 * worktree is made for one branch and usually stays on it. For the `main`
 * kind, which is just "the repository as you found it", the recorded branch is
 * a snapshot of a value that moves, and the pane footer was presenting it as
 * live. An agent reading `⎇ windows-wslg` off a checkout that is on
 * `librarian` is being told something false about where its commits will land,
 * which is the one thing that row exists to prevent.
 *
 * Why the file rather than `git rev-parse`: this is called from `snapshot()`,
 * for every workspace, twice a second. Spawning a process per workspace per
 * tick to read forty bytes is not a trade worth making. `HEAD` is a documented
 * plumbing file, and its two forms — a symref and a raw object id — have been
 * stable for the whole life of the format.
 */

/** `mtimeMs:size` of the HEAD we last parsed, against the answer we got. */
const headCache = new Map<string, { stamp: string; branch: string | null }>()

/**
 * The `.git` directory for a checkout, or null if it is not one.
 *
 * A linked worktree has a `.git` *file* holding `gitdir: <path>`, and that path
 * is where its own `HEAD` lives — the shared `.git` of the main checkout has a
 * different one. Getting this wrong would report every worktree as being on
 * the main checkout's branch, which is precisely the confusion being fixed.
 */
function gitDirOf(dir: string): string | null {
  const dot = path.join(dir, '.git')
  let stat: fs.Stats
  try {
    stat = fs.statSync(dot)
  } catch {
    return null
  }
  if (stat.isDirectory()) return dot
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'))
    if (!m) return null
    // git wrote this line, so the path is spelled the way the host spells it —
    // and on Windows `path.isAbsolute('/home/…')` says true while `statSync`
    // on it says ENOENT, which is the quiet kind of wrong. Convert first.
    const target = toNativePath(m[1].trim())
    return path.isAbsolute(target) ? target : path.resolve(dir, target)
  } catch {
    return null
  }
}

/**
 * The branch `dir` is on, the short object id when HEAD is detached, or null
 * when `dir` is not a checkout at all.
 *
 * A detached HEAD returns the id rather than null on purpose: "you are not on a
 * branch" is exactly the state the footer should be shouting about, and an
 * abbreviated id says it to anyone who reads git. Returning null would leave
 * the row blank, which reads as "no repository here".
 */
export function readHeadBranch(dir: string): string | null {
  const gitDir = gitDirOf(dir)
  if (!gitDir) return null
  const head = path.join(gitDir, 'HEAD')

  // Same shape as the transcript reader: one `stat` decides whether the read is
  // needed at all, and both fields together because either alone is defeatable
  // by a write that lands inside the same millisecond at the same length.
  let stamp: string
  try {
    const st = fs.statSync(head)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
  const hit = headCache.get(head)
  if (hit && hit.stamp === stamp) return hit.branch

  let branch: string | null = null
  try {
    const text = fs.readFileSync(head, 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text)
    branch = ref ? ref[1] : /^[0-9a-f]{40,64}$/.test(text) ? text.slice(0, 7) : null
  } catch {
    branch = null
  }
  headCache.set(head, { stamp, branch })
  return branch
}
