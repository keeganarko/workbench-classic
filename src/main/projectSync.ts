/**
 * Saved-file collaboration, backed by a private GitHub repository. Each client
 * remembers both the remote blob ID and the local content hash it last agreed
 * on. Comparing both against the next snapshot distinguishes a remote update,
 * a local edit, and an actual conflict; timestamps cannot make that distinction.
 *
 * GitHub commits are immutable, and updating the branch is a non-forced CAS.
 * A concurrent publisher makes us retry against its new tree, never overwrite
 * it. Local replacements/deletions are backed up before applying. No Git
 * commands mutate the project's own checkout, index, remotes, or branches.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { hostKind, hostSpawn, toHostPath } from './host.js'
import { githubRepository, syncPathAllowed, type ProjectSyncState, type SyncPreview } from '../shared/projectSync.js'
import type { SessionProject } from '../shared/types.js'

const META = '.workbench-project.json'
const MAX_FILE = 20 * 1024 * 1024
const MAX_TOTAL = 100 * 1024 * 1024
const MAX_FILES = 3000
const hash = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex')
type RemoteFile = { sha: string; size: number }
export interface RemoteSnapshot { revision: string | null; files: Record<string, RemoteFile>; shared: boolean }
export interface SyncRemote {
  account(): Promise<string>
  create(name: string): Promise<string>
  invite(repository: string, username: string): Promise<void>
  snapshot(repository: string): Promise<RemoteSnapshot>
  read(repository: string, sha: string): Promise<Buffer>
  publish(repository: string, revision: string | null, changes: Map<string, Buffer | null>, title: string, active: () => void): Promise<Map<string, string | null>>
}
type Base = { local: string | null; remote: string | null }
interface Connection extends ProjectSyncState { baseline: Record<string, Base>; seed: boolean }
interface LocalFile { bytes: Buffer; hash: string }
interface Dependencies {
  directory: string
  project(id: string): SessionProject | undefined
  remote: SyncRemote
  changed(): void
}

export class ProjectSync {
  private readonly deps: Dependencies
  private readonly file: string
  private connections: Connection[] = []
  private busy = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private loadError: string | null = null
  constructor(deps: Dependencies) {
    this.deps = deps
    this.file = path.join(deps.directory, 'project-sync.json')
    if (!fs.existsSync(this.file)) return
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (saved.version !== 1 || !Array.isArray(saved.connections)) throw new Error('Unsupported sync state')
      this.connections = saved.connections.map((item: Connection) => {
        if (!item || typeof item.projectId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(item.projectId) || typeof item.folder !== 'string'
          || !path.isAbsolute(item.folder) || !item.baseline || typeof item.baseline !== 'object') throw new Error('Invalid sync connection')
        for (const [file, base] of Object.entries(item.baseline)) {
          if (!syncPathAllowed(file) || !base || (base.local !== null && !/^[a-f0-9]{64}$/.test(base.local))
            || (base.remote !== null && !/^[a-f0-9]{40,64}$/.test(base.remote))) throw new Error('Invalid sync baseline')
        }
        return { ...item, baseline: Object.assign(Object.create(null), item.baseline), repository: githubRepository(item.repository), enabled: item.enabled === true,
          status: item.enabled ? 'idle' : 'paused', conflicts: [], error: null }
      })
    } catch (error) { this.loadError = `Sync settings could not be read; the original file is preserved: ${String(error)}` }
  }
  snapshot(): ProjectSyncState[] {
    return this.connections.map(({ baseline: _, seed: __, ...state }) => structuredClone(state))
  }
  error(): string | null { return this.loadError }
  private save(): void {
    if (this.loadError) throw new Error(this.loadError)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, connections: this.connections }), { mode: 0o600 })
    fs.renameSync(this.file + '.tmp', this.file)
    this.deps.changed()
  }
  private project(id: string): SessionProject {
    if (this.loadError) throw new Error(this.loadError)
    const project = this.deps.project(id)
    if (!project || !project.defaultCwd || !fs.statSync(project.defaultCwd).isDirectory()) throw new Error('Project folder is unavailable')
    return project
  }
  private active(c: Connection): void {
    if (this.stopped || !c.enabled || !this.connections.includes(c)) throw new Error('Sync is paused')
    if (this.project(c.projectId).defaultCwd !== c.folder) throw new Error('The project folder changed. Disconnect and review sharing for its new folder.')
  }
  async account(): Promise<string> { return this.deps.remote.account() }
  async preview(id: string): Promise<SyncPreview> {
    const result = await scan(this.project(id).defaultCwd)
    return { files: [...result.files.keys()], bytes: [...result.files.values()].reduce((sum, f) => sum + f.bytes.length, 0), excluded: result.excluded }
  }
  async connect(id: string, mode: 'create' | 'join', repository: string): Promise<void> {
    const project = this.project(id)
    const folder = fs.realpathSync(project.defaultCwd).toLowerCase()
    if (this.connections.some((c) => { const other = fs.realpathSync(c.folder).toLowerCase(); return folder === other || folder.startsWith(other + path.sep) || other.startsWith(folder + path.sep) })) throw new Error('This folder overlaps another shared project. Use separate folders for each connection.')
    if (this.connections.some((c) => c.projectId === id) || this.busy.has(id)) throw new Error('This project already has a sync connection')
    this.busy.add(id)
    try {
      await scan(project.defaultCwd)
      // Joining only into an empty folder prevents its initial contents from
      // being mistaken for remote deletions or automatically published edits.
      if (mode === 'join' && (await fsp.readdir(project.defaultCwd)).length) throw new Error('Join using an empty project folder so existing files are preserved.')
      const remote = mode === 'create' ? await this.deps.remote.create(repository) : githubRepository(repository)
      if (mode === 'join' && !(await this.deps.remote.snapshot(remote)).shared) throw new Error('This repository is not a shared Workbench project.')
      if (this.project(id).defaultCwd !== project.defaultCwd) throw new Error('The project folder changed; reconnect after reviewing it.')
      this.connections.push({ projectId: id, repository: remote, folder: project.defaultCwd, enabled: true,
        status: 'idle', lastSyncAt: null, error: null, conflicts: [], baseline: Object.create(null), seed: mode === 'create' })
      this.save()
    } finally { this.busy.delete(id) }
    await this.sync(id)
  }
  async invite(id: string, username: string): Promise<void> {
    const c = this.connection(id)
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(username)) throw new Error('Enter a GitHub username, not an email address.')
    await this.deps.remote.invite(c.repository, username)
  }
  private connection(id: string): Connection {
    const c = this.connections.find((item) => item.projectId === id)
    if (!c) throw new Error('This project is not connected for sharing')
    return c
  }
  pause(id: string, enabled: boolean): void {
    const c = this.connection(id)
    c.enabled = enabled; c.status = enabled ? 'idle' : 'paused'; c.error = null
    this.save()
  }
  disconnect(id: string): void {
    const c = this.connection(id)
    c.enabled = false
    this.connections = this.connections.filter((item) => item !== c)
    this.save()
  }
  start(): void {
    if (this.timer || this.loadError) return
    this.stopped = false
    this.timer = setInterval(() => { for (const c of this.connections) if (c.enabled) void this.sync(c.projectId).catch((error) => { c.status = 'error'; c.error = String(error); this.deps.changed() }) }, 15_000)
    this.timer.unref()
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null }

  async sync(id: string): Promise<void> {
    if (this.busy.has(id)) return
    const c = this.connection(id)
    if (!c.enabled || this.stopped) return
    this.busy.add(id); c.status = 'syncing'; c.error = null; this.deps.changed()
    try {
      this.active(c)
      const remote = await this.deps.remote.snapshot(c.repository)
      this.active(c)
      if (!remote.shared && !c.seed) throw new Error('The shared project marker is missing. No files were changed.')
      validateTree(remote.files)
      const local = (await scan(c.folder)).files
      this.active(c)
      const changes = new Map<string, Buffer | null>()
      c.conflicts = []
      for (const file of new Set([...Object.keys(c.baseline), ...local.keys(), ...Object.keys(remote.files)])) {
        this.active(c)
        const before = Object.hasOwn(c.baseline, file) ? c.baseline[file] : { local: null, remote: c.seed ? remote.files[file]?.sha ?? null : null }
        const here = local.get(file), there = Object.hasOwn(remote.files, file) ? remote.files[file] : undefined
        const changedHere = (here?.hash ?? null) !== before.local
        const changedThere = (there?.sha ?? null) !== before.remote
        if (changedThere) {
          const bytes = there ? await this.deps.remote.read(c.repository, there.sha) : null
          this.active(c)
          if (bytes && bytes.length > MAX_FILE) throw new Error(`Shared file exceeds the 20 MB limit: ${file}`)
          const remoteHash = bytes ? hash(bytes) : null
          if (changedHere && (here?.hash ?? null) !== remoteHash) {
            c.conflicts.push({ path: file, localDeleted: !here, remoteDeleted: !there })
            continue
          }
          if ((here?.hash ?? null) !== remoteHash) await this.replace(c, file, bytes, here?.hash ?? null)
          c.baseline[file] = { local: remoteHash, remote: there?.sha ?? null }
          // Persist each applied file: a crash partway through a batch must
          // not turn the files already applied into fresh, conflicting edits.
          this.save()
        } else if (changedHere || (c.seed && there && !here)) changes.set(file, here?.bytes ?? null)
      }
      if (c.conflicts.length) { c.status = 'conflict'; this.save(); return }
      this.active(c)
      if (changes.size || c.seed) {
        const accepted = await this.deps.remote.publish(c.repository, remote.revision, changes, this.project(id).name, () => this.active(c))
        // These IDs describe our accepted commit, never a newer writer's head.
        // Even if the local file changes during upload, the uploaded version
        // remains the baseline and its newer edit is picked up on the next pass.
        for (const [file, bytes] of changes) c.baseline[file] = { local: bytes ? hash(bytes) : null, remote: accepted.get(file) ?? null }
        c.seed = false
        this.save()
        this.active(c)
      }
      c.status = 'idle'; c.lastSyncAt = Date.now(); c.error = null; this.save()
    } catch (error) {
      if (this.connections.includes(c)) {
        c.status = c.enabled ? 'error' : 'paused'; c.error = error instanceof Error ? error.message : String(error)
        this.save()
      }
    } finally { this.busy.delete(id) }
  }

  async resolve(id: string, file: string, choice: 'local' | 'shared'): Promise<void> {
    const c = this.connection(id)
    if (this.busy.has(id)) throw new Error('Wait for the current sync to finish')
    if (!c.conflicts.some((item) => item.path === file) || !syncPathAllowed(file)) throw new Error('That conflict is no longer active')
    this.busy.add(id)
    try {
      this.active(c)
      const remote = await this.deps.remote.snapshot(c.repository)
      if (!remote.shared) throw new Error('The shared project marker is missing')
      validateTree(remote.files)
      const version = remote.files[file]
      const bytes = version ? await this.deps.remote.read(c.repository, version.sha) : null
      this.active(c)
      const remoteHash = bytes ? hash(bytes) : null
      if (choice === 'shared') {
        const current = await currentFile(c.folder, file)
        await this.replace(c, file, bytes, current ? hash(current) : null)
      }
      // Keeping local accepts the remote version as the comparison base, so
      // the user's chosen local contents become a new revision on next sync.
      c.baseline[file] = { local: remoteHash, remote: version?.sha ?? null }
      c.conflicts = c.conflicts.filter((item) => item.path !== file)
      c.status = c.conflicts.length ? 'conflict' : 'idle'; this.save()
    } finally { this.busy.delete(id) }
    if (!c.conflicts.length) await this.sync(id)
  }
  private async replace(c: Connection, file: string, bytes: Buffer | null, expected: string | null): Promise<void> {
    this.active(c)
    const current = await currentFile(c.folder, file)
    if ((current ? hash(current) : null) !== expected) throw new Error(`File changed during sync; retrying will preserve it: ${file}`)
    if (current) {
      const backup = path.join(this.deps.directory, 'sync-backups', c.projectId, `${Date.now()}-${crypto.randomUUID()}`, file)
      await fsp.mkdir(path.dirname(backup), { recursive: true })
      await fsp.writeFile(backup, current, { mode: 0o600 })
    }
    this.active(c)
    const target = await safeTarget(c.folder, file)
    if (bytes) {
      await fsp.mkdir(path.dirname(target), { recursive: true })
      const temporary = path.join(path.dirname(target), `.workbench-sync-${crypto.randomUUID()}`)
      try {
        const mode = current ? (await fsp.stat(target)).mode & 0o777 : 0o600
        await fsp.writeFile(temporary, bytes, { flag: 'wx', mode })
        this.active(c)
        const latest = await currentFile(c.folder, file)
        if ((latest ? hash(latest) : null) !== expected) throw new Error(`File changed during sync: ${file}`)
        await safeTarget(c.folder, file)
        await fsp.rename(temporary, target)
      } finally { await fsp.rm(temporary, { force: true }) }
    } else if (current) {
      const latest = await currentFile(c.folder, file)
      if (!latest || hash(latest) !== expected) throw new Error(`File changed during sync: ${file}`)
      this.active(c); await fsp.unlink(await safeTarget(c.folder, file))
    }
  }
}

async function safeTarget(root: string, relative: string): Promise<string> {
  if (!syncPathAllowed(relative)) throw new Error(`Unsupported shared path: ${relative}`)
  let target = root
  for (const part of relative.split('/')) {
    target = path.join(target, part)
    try { if ((await fsp.lstat(target)).isSymbolicLink()) throw new Error(`Sync cannot follow a symbolic link: ${relative}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return target
}
async function currentFile(root: string, relative: string): Promise<Buffer | null> {
  const target = await safeTarget(root, relative)
  try {
    const stat = await fsp.stat(target)
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error(`Unsupported local file: ${relative}`)
    return await fsp.readFile(target)
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
function validateTree(files: Record<string, RemoteFile>): void {
  const names = new Set<string>(), prefixes = new Map<string, string>(); let total = 0
  if (Object.keys(files).length > MAX_FILES) throw new Error('Shared project exceeds 3,000 files')
  for (const [file, value] of Object.entries(files)) {
    if (!syncPathAllowed(file) || names.has(file.toLowerCase()) || !Number.isSafeInteger(value.size)
      || value.size < 0 || value.size > MAX_FILE) throw new Error(`Unsupported or conflicting shared path: ${file}`)
    // Detect directory spelling collisions too: Notes/a and notes/b would
    // become one directory on Windows but remain two distinct folders on Linux.
    const parts = file.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'), key = prefix.normalize('NFC').toLowerCase()
      if (prefixes.has(key) && prefixes.get(key) !== prefix) throw new Error(`Conflicting shared path spelling: ${file}`)
      prefixes.set(key, prefix)
      if (i < parts.length && Object.hasOwn(files, prefix)) throw new Error(`Shared file is also a directory: ${file}`)
    }
    names.add(file.toLowerCase()); total += value.size
  }
  if (total > MAX_TOTAL) throw new Error('Shared project exceeds the 100 MB sync limit')
}
async function ignoredFiles(root: string, files: string[]): Promise<Set<string>> {
  const spec = hostSpawn(['git', '-C', toHostPath(root), 'check-ignore', '--no-index', '--stdin', '-z'])
  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args, { cwd: spec.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', error = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Checking ignored files timed out')) }, 15_000)
    child.stdout.on('data', (data) => { output += data })
    child.stderr.on('data', (data) => { error += data })
    child.on('error', () => { clearTimeout(timer); reject(new Error('Install Git in the session host to check which files are ignored before sharing.')) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 || code === 1) resolve(new Set(output.split('\0').filter(Boolean)))
      // A plain folder has no Git ignore rules. Its built-in exclusions still
      // apply, and the share dialog lists every file before upload is enabled.
      else if (/not a git repository/i.test(error)) resolve(new Set())
      else reject(new Error(error.trim() || 'Could not check ignored files'))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(files.length ? files.join('\0') + '\0' : '')
  })
}
async function scan(root: string): Promise<{ files: Map<string, LocalFile>; excluded: number }> {
  const files = new Map<string, LocalFile>(), candidates: string[] = []
  let excluded = 0, total = 0
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name
      if (!syncPathAllowed(file) || entry.isSymbolicLink()) { excluded++; continue }
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) candidates.push(file)
      if (candidates.length > 30_000) throw new Error('Choose a smaller folder for sharing')
    }
  }
  await walk('')
  const ignored = await ignoredFiles(root, candidates)
  for (const file of candidates) {
    if (ignored.has(file)) { excluded++; continue }
    const bytes = await currentFile(root, file)
    if (!bytes) continue
    total += bytes.length
    if (files.size >= MAX_FILES || total > MAX_TOTAL) throw new Error('Sharing supports up to 3,000 files and 100 MB per project. Choose a smaller project folder.')
    files.set(file, { bytes, hash: hash(bytes) })
  }
  validateTree(Object.fromEntries([...files].map(([name, item]) => [name, { sha: item.hash, size: item.bytes.length }])))
  return { files, excluded }
}

/** GitHub CLI keeps authentication in its own credential store, never our JSON. */
export class GitHubSyncRemote implements SyncRemote {
  private cache = new Map<string, RemoteSnapshot>()
  private async api(route: string, body?: unknown, method?: string): Promise<any> {
    const spec = hostSpawn(['gh', 'api', '--hostname', 'github.com', route,
      ...(body ? ['--method', method ?? 'POST', '--input', '-'] : [])])
    return new Promise((resolve, reject) => {
      const child = spawn(spec.file, spec.args, { cwd: spec.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      let output = '', error = '', done = false
      const finish = (err?: Error): void => {
        if (done) return; done = true; clearTimeout(timer)
        if (err) reject(err)
        else { try { resolve(output ? JSON.parse(output) : null) } catch { reject(new Error('GitHub returned an invalid response')) } }
      }
      const timer = setTimeout(() => { child.kill(); finish(new Error('GitHub request timed out; local files are preserved.')) }, 60_000)
      child.on('error', () => finish(new Error(`Install GitHub CLI ${hostKind() === 'wsl' ? 'inside Ubuntu/WSL ' : ''}and sign in with gh auth login.`)))
      child.stdout.on('data', (data) => { output += data; if (output.length > 40 * 1024 * 1024) { child.kill(); finish(new Error('GitHub response is too large')) } })
      child.stderr.on('data', (data) => { if (error.length < 2000) error += data })
      child.on('close', (code) => finish(code === 0 ? undefined : new Error(error.trim() || 'GitHub access failed. Check gh auth login and repository permissions.')))
      child.stdin.on('error', () => {})
      child.stdin.end(body ? JSON.stringify(body) : '')
    })
  }
  async account(): Promise<string> { return (await this.api('user')).login }
  async create(name: string): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) throw new Error('Use a repository name with letters, numbers, dots, hyphens, or underscores.')
    const created = await this.api('user/repos', { name, private: true, auto_init: true, description: 'Shared Workbench project files' })
    const repo = githubRepository(created.full_name)
    if (created.default_branch !== 'main') {
      const ref = await this.api(`repos/${repo}/git/ref/heads/${encodeURIComponent(created.default_branch)}`)
      await this.api(`repos/${repo}/git/refs`, { ref: 'refs/heads/main', sha: ref.object.sha })
      await this.api(`repos/${repo}`, { default_branch: 'main' }, 'PATCH')
    }
    return repo
  }
  async invite(repository: string, username: string): Promise<void> {
    await this.api(`repos/${githubRepository(repository)}/collaborators/${username}`, { permission: 'push' }, 'PUT')
  }
  async read(repository: string, sha: string): Promise<Buffer> {
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Invalid shared blob')
    const blob = await this.api(`repos/${githubRepository(repository)}/git/blobs/${sha}`)
    if (blob.encoding !== 'base64' || blob.size > MAX_FILE) throw new Error('Unsupported shared file')
    const bytes = Buffer.from(blob.content, 'base64')
    if (bytes.length > MAX_FILE || bytes.length !== blob.size) throw new Error('Unsupported shared file size')
    return bytes
  }
  async snapshot(repository: string): Promise<RemoteSnapshot> {
    const repo = githubRepository(repository)
    const info = await this.api(`repos/${repo}`)
    if (info.private !== true) throw new Error('Automatic sharing requires a private GitHub repository.')
    if (info.size === 0) {
      // Size can lag after the first push; only a missing branch proves empty.
      try { await this.api(`repos/${repo}/git/ref/heads/main`) }
      catch (error) { if (/404|Git Repository is empty/i.test(String(error))) return { revision: null, files: {}, shared: false }; throw error }
    }
    const ref = await this.api(`repos/${repo}/git/ref/heads/main`)
    const cached = this.cache.get(repo)
    if (cached && cached.revision === ref.object.sha) return structuredClone(cached)
    const commit = await this.api(`repos/${repo}/git/commits/${ref.object.sha}`)
    const tree = await this.api(`repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`)
    if (tree.truncated) throw new Error('The shared project is too large to sync safely')
    const files: Record<string, RemoteFile> = Object.create(null)
    let shared = false
    for (const entry of tree.tree) {
      if (entry.type === 'tree') continue
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`Unsupported shared entry: ${entry.path}`)
      if (entry.path === META) {
        const metadata = JSON.parse((await this.read(repo, entry.sha)).toString('utf8'))
        shared = metadata.workbench === 1
      } else files[entry.path] = { sha: entry.sha, size: entry.size }
    }
    validateTree(files)
    const result = { revision: ref.object.sha, files, shared }
    this.cache.set(repo, result)
    return structuredClone(result)
  }
  async publish(repository: string, revision: string | null, changes: Map<string, Buffer | null>, title: string, active: () => void): Promise<Map<string, string | null>> {
    const repo = githubRepository(repository)
    const entries: Record<string, unknown>[] = []
    const accepted = new Map<string, string | null>()
    // Inline UTF-8 files share a tree request. Binary blobs use their own API
    // call, with a small batch ceiling to avoid GitHub's content-creation limit.
    let inlineBytes = 0, blobs = 0
    for (const [file, bytes] of changes) {
      active()
      if (!syncPathAllowed(file)) throw new Error('Unsupported shared filename')
      const content = bytes?.toString('utf8')
      let sha: string | null = null
      if (bytes && content !== undefined && Buffer.from(content).equals(bytes) && inlineBytes + bytes.length < 5 * 1024 * 1024) {
        inlineBytes += bytes.length
        entries.push({ path: file, mode: '100644', type: 'blob', content })
        sha = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      } else {
        if (bytes && ++blobs > 40) throw new Error('Too many binary changes at once. Share a smaller batch of files.')
        sha = bytes ? (await this.api(`repos/${repo}/git/blobs`, { content: bytes.toString('base64'), encoding: 'base64' })).sha : null
        entries.push({ path: file, mode: '100644', type: 'blob', sha })
      }
      accepted.set(file, sha)
    }
    entries.push({ path: META, mode: '100644', type: 'blob', content: JSON.stringify({ workbench: 1, name: title }) })
    active()
    const parent = revision ? await this.api(`repos/${repo}/git/commits/${revision}`) : null
    active()
    const tree = await this.api(`repos/${repo}/git/trees`, { ...(parent ? { base_tree: parent.tree.sha } : {}), tree: entries })
    active()
    const commit = await this.api(`repos/${repo}/git/commits`, { message: 'Sync Workbench project files', tree: tree.sha, parents: revision ? [revision] : [] })
    // No force option: a changed remote head must reject this publication so
    // the next pass can compare both writers against their common baseline.
    active()
    if (revision) await this.api(`repos/${repo}/git/refs/heads/main`, { sha: commit.sha, force: false }, 'PATCH')
    else await this.api(`repos/${repo}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha })
    return accepted
  }
}
