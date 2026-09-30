import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ProjectSync, GitHubSyncRemote } from '../src/main/projectSync.js'
import { githubRepository, syncPathAllowed } from '../src/shared/projectSync.js'
import { runGit } from '../src/main/git.js'
import { tempDir } from './helpers.mjs'

const hostGit = (await runGit(['--version'], process.cwd())).code === 0
const integration = { skip: hostGit ? false : 'Session-host Git requires an installed WSL distro on Windows' }
const digest = (b) => crypto.createHash('sha256').update(b).digest('hex')
class Remote {
  files = Object.create(null); blobs = new Map(); revision = null; shared = false
  unavailable = false; beforePublish = null
  async account() { return 'friend' }
  async create() { return 'friend/private-project' }
  async invite() {}
  async snapshot() { if (this.unavailable) throw Error('Offline'); return structuredClone({ files: this.files, revision: this.revision, shared: this.shared }) }
  async read(_repo, sha) { return Buffer.from(this.blobs.get(sha)) }
  async publish(_repo, revision, changes, _title, active) {
    await this.beforePublish?.(); active()
    if (revision !== this.revision) throw Error('Remote changed; retry')
    const accepted = new Map()
    for (const [name, bytes] of changes) {
      const sha = bytes ? digest(bytes) : null
      if (bytes) { this.blobs.set(sha, Buffer.from(bytes)); this.files[name] = { sha, size: bytes.length } }
      else delete this.files[name]
      accepted.set(name, sha)
    }
    this.revision = crypto.randomBytes(20).toString('hex'); this.shared = true
    return accepted
  }
}
function client(remote, folder = tempDir()) {
  const directory = tempDir(), project = { id: 'project_test', name: 'Notes', defaultCwd: folder }
  const options = { directory, project: (id) => id === project.id ? project : undefined, remote, changed() {} }
  return { sync: new ProjectSync(options), project, folder, directory, options, state() { return this.sync.snapshot()[0] } }
}
const write = (c, name, text) => { fs.mkdirSync(path.dirname(path.join(c.folder, name)), { recursive: true }); fs.writeFileSync(path.join(c.folder, name), text) }
const read = (c, name) => fs.readFileSync(path.join(c.folder, name), 'utf8')
async function pair() { const remote = new Remote(), a = client(remote), b = client(remote); write(a, 'notes.md', 'original'); await a.sync.connect('project_test', 'create', 'private-project'); await b.sync.connect('project_test', 'join', 'friend/private-project'); return { remote, a, b } }

test('sharing rejects nonportable paths, secrets, app state, and remote workflow execution', () => {
  for (const name of ['../escape','/absolute','a/../escape','a\\b','.env','.env.local','.git/config','a/.ssh/id','node_modules/a','a/CON.txt','name.','a.key','.github/workflows/run.yml','project-sync.json','experience.json']) assert.equal(syncPathAllowed(name), false, name)
  for (const name of ['notes.md','src/main.ts','image.png','constructor','__proto__']) assert.equal(syncPathAllowed(name), true, name)
  assert.equal(githubRepository('https://github.com/me/project.git'), 'me/project')
  assert.throws(() => githubRepository('https://evil.example/me/project'))
})
test('two folders exchange saved edits, new binary files, and deletions without modifying Git metadata', integration, async () => {
  const { a, b } = await pair()
  assert.equal(read(b, 'notes.md'), 'original')
  write(b, 'notes.md', 'from friend'); write(a, 'asset.png', Buffer.from([0,255,3]))
  await b.sync.sync('project_test'); await a.sync.sync('project_test'); await b.sync.sync('project_test')
  assert.equal(read(a, 'notes.md'), 'from friend')
  assert.deepEqual(fs.readFileSync(path.join(b.folder, 'asset.png')), Buffer.from([0,255,3]))
  fs.unlinkSync(path.join(a.folder, 'asset.png')); await a.sync.sync('project_test'); await b.sync.sync('project_test')
  assert.equal(fs.existsSync(path.join(b.folder, 'asset.png')), false)
  assert.equal(fs.existsSync(path.join(a.folder, '.git')), false)
  assert.ok(fs.readdirSync(path.join(a.directory, 'sync-backups', 'project_test')).length)
})
test('concurrent edits preserve both versions until the user chooses; deletion conflicts are explicit', integration, async () => {
  const { a, b, remote } = await pair()
  write(a, 'notes.md', 'mine'); write(b, 'notes.md', 'theirs')
  await b.sync.sync('project_test'); await a.sync.sync('project_test')
  assert.equal(a.state().status, 'conflict'); assert.equal(read(a, 'notes.md'), 'mine')
  await a.sync.resolve('project_test', 'notes.md', 'local'); await b.sync.sync('project_test')
  assert.equal(read(b, 'notes.md'), 'mine')
  fs.unlinkSync(path.join(a.folder, 'notes.md')); write(b, 'notes.md', 'changed again')
  await b.sync.sync('project_test'); await a.sync.sync('project_test')
  assert.equal(a.state().conflicts[0].localDeleted, true)
  await a.sync.resolve('project_test', 'notes.md', 'shared')
  assert.equal(read(a, 'notes.md'), 'changed again'); assert.ok(remote.shared)
})
test('offline, pause, disconnect, and restart preserve local data and the comparison baseline', integration, async () => {
  const { a, b, remote } = await pair()
  remote.unavailable = true; write(a, 'notes.md', 'offline edit'); await a.sync.sync('project_test')
  assert.equal(a.state().status, 'error'); assert.equal(read(a, 'notes.md'), 'offline edit')
  remote.unavailable = false; a.sync = new ProjectSync(a.options)
  a.sync.pause('project_test', false); await a.sync.sync('project_test'); await b.sync.sync('project_test')
  assert.equal(read(b, 'notes.md'), 'original')
  a.sync.pause('project_test', true); await a.sync.sync('project_test'); await b.sync.sync('project_test')
  assert.equal(read(b, 'notes.md'), 'offline edit')
  a.sync.disconnect('project_test'); assert.equal(a.sync.snapshot().length, 0); assert.equal(read(a, 'notes.md'), 'offline edit')
})
test('a rejected publication retries against the winning tree without losing unrelated edits', integration, async () => {
  const { a, b, remote } = await pair()
  write(a, 'mine.md', 'a'); write(b, 'theirs.md', 'b')
  remote.beforePublish = async () => { remote.beforePublish = null; await b.sync.sync('project_test') }
  await a.sync.sync('project_test'); assert.equal(a.state().status, 'error')
  await a.sync.sync('project_test'); await b.sync.sync('project_test')
  assert.equal(read(a, 'theirs.md'), 'b'); assert.equal(read(b, 'mine.md'), 'a')
})
test('revocation before the final publication prevents uploading the pending revision', integration, async () => {
  const { a, b, remote } = await pair(); write(a, 'notes.md', 'pending')
  remote.beforePublish = async () => { a.sync.pause('project_test', false) }
  await a.sync.sync('project_test'); await b.sync.sync('project_test')
  assert.equal(read(b, 'notes.md'), 'original'); assert.equal(a.state().status, 'paused')
})
test('joining refuses occupied folders and a changed project folder pauses writes', integration, async () => {
  const { a, remote } = await pair(), other = client(remote)
  write(other, 'personal.md', 'keep')
  await assert.rejects(other.sync.connect('project_test', 'join', 'friend/private-project'), /empty/)
  a.project.defaultCwd = tempDir(); await a.sync.sync('project_test')
  assert.match(a.state().error, /folder changed/)
})
test('the first upload honors Git ignores and excludes credentials, including nested files', integration, async () => {
  const remote = new Remote(), a = client(remote)
  await runGit(['init', '-q'], a.folder)
  write(a, '.gitignore', 'private/\n*.secret\n'); write(a, 'private/note', 'secret'); write(a, 'data.secret', 'secret'); write(a, '.env', 'secret'); write(a, 'public.md', 'share')
  const preview = await a.sync.preview('project_test')
  assert.deepEqual(preview.files.sort(), ['.gitignore', 'public.md'])
  await a.sync.connect('project_test', 'create', 'private-project')
  assert.deepEqual(Object.keys(remote.files).sort(), ['.gitignore', 'public.md'])
})
test('malformed persisted state stays intact instead of resetting an existing share', () => {
  const a = client(new Remote()); fs.writeFileSync(path.join(a.directory, 'project-sync.json'), '{broken')
  const sync = new ProjectSync(a.options)
  assert.match(sync.error(), /preserved/); assert.equal(fs.readFileSync(path.join(a.directory, 'project-sync.json'), 'utf8'), '{broken')
})
test('GitHub publication batches text, preserves the base tree, and refuses forced reference updates', async () => {
  const remote = new GitHubSyncRemote(), calls = []
  remote.api = async (route, body, method) => {
    calls.push({ route, body, method })
    if (route.endsWith('/git/commits/old')) return { tree: { sha: 'base-tree' } }
    return { sha: route.includes('trees') ? 'new-tree' : 'new-commit' }
  }
  const changes = new Map([['notes.md', Buffer.from('hello')], ['old.md', null]])
  const accepted = await remote.publish('friend/project', 'old', changes, 'Notes', () => {})
  const tree = calls.find((c) => c.route.endsWith('/git/trees')).body
  assert.equal(tree.base_tree, 'base-tree'); assert.equal(tree.tree[0].content, 'hello')
  assert.equal(tree.tree[1].sha, null); assert.equal(calls.at(-1).body.force, false)
  assert.equal(accepted.get('notes.md'), crypto.createHash('sha1').update('blob 5\0hello').digest('hex'))
  assert.equal(calls.filter((c) => c.route.includes('/git/blobs')).length, 0)
})

test('an initialized private repository starts with the reviewed local files, replacing only its generated README', integration, async () => {
  const remote = new Remote(), a = client(remote)
  const readme = Buffer.from('GitHub generated README')
  remote.files['README.md'] = { sha: digest(readme), size: readme.length }; remote.blobs.set(digest(readme), readme); remote.revision = 'initial'
  write(a, 'notes.md', 'my work')
  await a.sync.connect('project_test', 'create', 'private-project')
  assert.equal(a.state().status, 'idle'); assert.deepEqual(Object.keys(remote.files), ['notes.md'])
  assert.equal(fs.existsSync(path.join(a.folder, 'README.md')), false)
})
test('remote path spelling collisions and symlink traversal are refused before replacing user files', integration, async () => {
  const { a, remote } = await pair()
  const bytes = Buffer.from('remote content'), sha = digest(bytes); remote.blobs.set(sha, bytes)
  remote.files['Notes/a.md'] = { sha, size: bytes.length }; remote.files['notes/b.md'] = { sha, size: bytes.length }
  await a.sync.sync('project_test'); assert.equal(a.state().status, 'error'); assert.match(a.state().error, /spelling/)
  delete remote.files['notes/b.md']
  const outside = tempDir(); fs.symlinkSync(outside, path.join(a.folder, 'Notes'), process.platform === 'win32' ? 'junction' : 'dir')
  await a.sync.sync('project_test'); assert.match(a.state().error, /symbolic link/)
  assert.deepEqual(fs.readdirSync(outside), [])
})
