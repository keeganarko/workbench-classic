import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { compareVersions, betaVersion, parseUpdateManifest, releaseAssetURL, selectUpdateAsset } from '../src/shared/updates.js'
import { UpdateService, verifyDownloadedFile, githubResponse, readUpdateJSON, downloadUpdate, readInstallFailure } from '../src/main/updates.js'
import { assemble, assetName, signingEnvironment, platforms, validateRelease } from '../scripts/release.mjs'
import { loadComposerWorkspace, saveComposerWorkspace } from '../src/renderer/src/lib/updateWorkspace.js'
import { requireNoWindowsAgentConnections } from '../src/main/updateWindows.js'

const version = '1.0.2-beta.1', commit = 'a'.repeat(40), bytes = Buffer.from('test update payload')
const url = (name, v = version) => `https://github.com/keeganarko/workbench-classic/releases/download/v${v}/${name}`
const asset = (platform = 'win32', arch = 'x64') => ({ platform, arch, url: url(assetName(version, platform, arch, platform === 'win32' ? 'exe' : 'dmg')),
  size: bytes.length, sha512: crypto.createHash('sha512').update(bytes).digest('hex'), minSystemVersion: platform === 'win32' ? '10.0.19041' : '22.0.0', signer: null })
const manifest = () => ({ schema: 1, channel: 'beta', version, commit, notes: 'A quieter interface. 日本語 ✓', assets: platforms.map((key) => asset(...key.split('-'))) })
const release = (v = version) => ({ draft: false, tag_name: `v${v}`, assets: [{ name: 'workbench-update.json', browser_download_url: url('workbench-update.json', v) }] })
async function harness(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-update-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const calls = { changes: 0, downloads: 0, installed: [], opened: [], staged: [] }
  const deps = { directory, version: '1.0.1-beta.1', platform: 'win32', arch: 'x64', systemVersion: '10.0.22631', packaged: true,
    changed: () => calls.changes++, readJSON: async (u) => u.includes('api.github.com') ? [release()] : manifest(),
    download: async (_a, file, progress) => { calls.downloads++; progress(50); await fs.writeFile(file, bytes) },
    canRestart: async () => false, stageMac: async (a) => { calls.staged.push(a) },
    install: async (a, file) => { calls.installed.push({ a, file }) }, openInstaller: async (file) => { calls.opened.push(file) }, ...overrides }
  const service = new UpdateService(deps)
  t.after(() => service.stop())
  return { service, calls, deps, directory }
}
test('versions compare numerically and never confuse beta.10 with beta.2', () => {
  assert.equal(compareVersions('1.0.1-beta.10', '1.0.1-beta.2'), 1)
  assert.equal(compareVersions('1.0.1-beta.1', '1.0.0'), 1)
  assert.equal(compareVersions('1.0.1-beta.1', '1.0.1'), -1)
  assert.equal(compareVersions(version, version), 0)
  for (const v of ['1.0.0', '01.0.0-beta.1', '1.0.0-beta.01', '1.0.0-beta.1+build', '1.0.0-stable.1', '1.0.0-beta.9007199254740993']) assert.equal(betaVersion(v), false, v)
})
test('manifest selects exact OS and processor and refuses an older OS', () => {
  const m = parseUpdateManifest(manifest(), version)
  for (const key of platforms) {
    const [p, a] = key.split('-')
    assert.equal(selectUpdateAsset(m, p, a, p === 'darwin' ? '23.0.0' : '10.0.22631')?.url, asset(p, a).url)
  }
  assert.equal(selectUpdateAsset(m, 'win32', 'x64', '10.0.19040'), null)
  assert.equal(selectUpdateAsset(m, 'darwin', 'arm64', '21.6.0'), null)
  assert.equal(selectUpdateAsset(m, 'win32', 'ia32', '10.0.22631'), null)
  assert.equal(selectUpdateAsset(m, 'linux', 'x64', '6.8.0'), null)
})
test('manifest rejects redirected repositories, duplicate CPUs and malformed downloads', () => {
  for (const bad of ['http://github.com/keeganarko/workbench-classic/releases/download/v1.0.2-beta.1/a.exe', url('a.exe') + '?download=1', url('a.exe').replace('/workbench-classic/', '/other/'), url('a.exe').replace('/v1.', '/z1.'), url('a.exe').replace('github.com', 'github.com.evil.example')]) assert.equal(releaseAssetURL(bad), false)
  for (const mutate of [m => m.channel = 'stable', m => m.commit = 'HEAD', m => m.assets.push(m.assets[0]), m => m.assets[0].sha512 = 'wrong', m => m.assets[0].size = -1, m => m.assets[0].url = 'file:///tmp/setup.exe', m => m.assets[0].minSystemVersion = '9999999999999999999999.0.0', m => m.assets[0] = null]) {
    const m = manifest(); mutate(m); assert.throws(() => parseUpdateManifest(m, version))
  }
})
test('ordinary releases, drafts and older releases never offer an update', async (t) => {
  const { service, calls } = await harness(t, { readJSON: async () => [{ ...release(), draft: true }, { ...release('9.0.0-beta.1'), assets: [] }, release('1.0.0-beta.1'), { ...release(), tag_name: 'v2.0.0' }] })
  await service.check(); assert.equal(service.snapshot().status, 'current')
  await service.download(); await service.install()
  assert.equal(calls.downloads, 0); assert.deepEqual(calls.installed, [])
})
test('checks choose latest version regardless of GitHub publication order', async (t) => {
  const { service } = await harness(t, { readJSON: async (u) => u.includes('api.github.com') ? [release('1.0.0-beta.1'), release(), release('1.0.1-beta.2')] : manifest() })
  await service.check(); assert.equal(service.snapshot().version, version); assert.equal(service.snapshot().status, 'available')
})
test('restart-capable installation executes only after verification; exceptional manual mode reveals the installer', async (t) => {
  for (const restart of [false, true]) {
    const { service, calls } = await harness(t, { canRestart: async () => restart })
    await service.check(); assert.equal(service.snapshot().installMode, restart ? 'restart' : 'manual')
    assert.equal(calls.downloads, 0)
    await service.download(); assert.equal(service.snapshot().status, 'ready'); assert.equal(service.snapshot().progress, 100)
    assert.equal(calls.installed.length, 0)
    await service.install(); assert.equal(calls.installed.length, restart ? 1 : 0); assert.equal(calls.opened.length, restart ? 0 : 1)
  }
})
test('corrupt or interrupted downloads cannot become ready and remove their partial file', async (t) => {
  for (const fail of [false, true]) {
    const { service, calls, directory } = await harness(t, { download: async (_a, file) => { await fs.writeFile(file, Buffer.alloc(bytes.length)); if (fail) throw new Error('Network disconnected') } })
    await service.check(); await service.download()
    assert.equal(service.snapshot().status, 'error'); assert.deepEqual(await fs.readdir(directory), [])
    await service.install(); assert.equal(calls.installed.length, 0); assert.equal(calls.opened.length, 0)
  }
})
test('tampering after download is rejected again at install time', async (t) => {
  const { service, directory, calls } = await harness(t)
  await service.check(); await service.download()
  const [folder] = await fs.readdir(directory)
  await fs.writeFile(path.join(directory, folder, 'Workbench-Setup.exe'), Buffer.alloc(bytes.length))
  await service.install(); assert.equal(service.snapshot().status, 'error'); assert.equal(calls.opened.length, 0)
})
test('a failed installer handoff preserves its verified download for retry', async (t) => {
  const { service, calls, deps } = await harness(t, { canRestart: async () => true })
  const attempts = []
  deps.install = async (_asset, file) => { attempts.push(file); if (attempts.length === 1) throw new Error('Active agent connections are using Workbench.') }
  await service.check(); await service.download(); await service.install()
  assert.equal(service.snapshot().status, 'ready')
  assert.match(service.snapshot().error, /Active agent connections/)
  await service.check(); await service.download()
  assert.equal(calls.downloads, 1)
  await service.install()
  assert.equal(attempts.length, 2); assert.equal(attempts[0], attempts[1])
  assert.equal(service.snapshot().error, null)
  assert.equal(calls.downloads, 1)
})
test('a ready retry still rejects changed bytes before calling the installer', async (t) => {
  const { service, deps, calls } = await harness(t, { canRestart: async () => true })
  let file, attempts = 0
  deps.install = async (_asset, downloaded) => { file = downloaded; attempts++; throw new Error('State checkpoint failed.') }
  await service.check(); await service.download(); await service.install()
  assert.equal(service.snapshot().status, 'ready')
  await fs.writeFile(file, Buffer.alloc(bytes.length))
  await service.install()
  assert.equal(service.snapshot().status, 'error')
  assert.match(service.snapshot().error, /did not pass verification/)
  assert.equal(attempts, 1)
  await service.download()
  assert.equal(service.snapshot().status, 'ready'); assert.equal(calls.downloads, 2)
})
test('a failed manual reveal can retry the same verified installer and clear its error', async (t) => {
  const { service, deps, calls } = await harness(t)
  let attempts = 0
  deps.openInstaller = async file => { attempts++; if (attempts === 1) throw new Error('Explorer could not open.'); calls.opened.push(file) }
  await service.check(); await service.download(); await service.install()
  assert.equal(service.snapshot().status, 'ready')
  assert.match(service.snapshot().error, /Explorer could not open/)
  await service.install()
  assert.equal(service.snapshot().status, 'ready'); assert.equal(service.snapshot().error, null)
  assert.equal(calls.opened.length, 1); assert.equal(calls.downloads, 1)
})
test('concurrent checks/downloads do not duplicate work and can recover after network failure', async (t) => {
  let resolve, count = 0
  const { service, calls } = await harness(t, { readJSON: async (u) => {
    count++; if (count === 1) return new Promise((_resolve, reject) => { resolve = reject })
    return u.includes('api.github.com') ? [release()] : manifest()
  } })
  const check = service.check(); await service.check(); assert.equal(count, 1)
  resolve(new Error('Offline')); await check; assert.equal(service.snapshot().status, 'error')
  await service.check(); assert.equal(service.snapshot().status, 'available')
  await Promise.all([service.download(), service.download(), service.check()]); assert.equal(calls.downloads, 1)
})
test('signed Mac uses native feed staging; unsigned Mac downloads its verified DMG', async (t) => {
  for (const signed of [false, true]) {
    const source = manifest()
    if (signed) Object.assign(source.assets.find(a => a.platform === 'darwin' && a.arch === 'arm64'), { signer: 'ABCDE12345', macFeed: url('mac-arm64.json') })
    const { service, calls } = await harness(t, { platform: 'darwin', arch: 'arm64', systemVersion: '23.0.0', canRestart: async () => true,
      readJSON: async u => u.includes('api.github.com') ? [release()] : source })
    await service.check(); await service.download(); await service.install()
    assert.equal(calls.staged.length, signed ? 1 : 0); assert.equal(calls.downloads, signed ? 0 : 1)
    assert.equal(calls.opened.length, 0)
    assert.equal(calls.installed[0].file === null, signed)
  }
})
test('a failed native Mac handoff can retry its already staged update', async (t) => {
  const source = manifest()
  Object.assign(source.assets.find(a => a.platform === 'darwin' && a.arch === 'arm64'), { signer: 'ABCDE12345', macFeed: url('mac-arm64.json') })
  const { service, calls, deps } = await harness(t, { platform: 'darwin', arch: 'arm64', systemVersion: '23.0.0', canRestart: async () => true,
    readJSON: async u => u.includes('api.github.com') ? [release()] : source })
  let attempts = 0
  deps.install = async (_asset, file) => { assert.equal(file, null); attempts++; if (attempts === 1) throw new Error('Native restart was postponed.') }
  await service.check(); await service.download(); await service.install()
  assert.equal(service.snapshot().status, 'ready')
  assert.match(service.snapshot().error, /restart was postponed/)
  await service.install()
  assert.equal(attempts, 2); assert.equal(calls.staged.length, 1); assert.equal(calls.downloads, 0)
  assert.equal(service.snapshot().error, null)
})
test('development and unsupported hosts never request remote releases', async (t) => {
  for (const override of [{ packaged: false }, { platform: 'linux' }]) {
    const { service } = await harness(t, { ...override, readJSON: async () => assert.fail('unexpected request') })
    await service.check(); assert.equal(service.snapshot().status, 'unsupported')
  }
})
test('HTTPS transport bounds redirects, handles rate limits, and preserves streamed Unicode', async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/download' } })
  await assert.rejects(() => githubResponse(url('a.exe'), new AbortController().signal), /Unrecognized update server/)
  globalThis.fetch = async () => new Response(null, { status: 429 })
  await assert.rejects(() => readUpdateJSON(url('a.json'), new AbortController().signal), /rate-limited/)
  const data = Buffer.from(JSON.stringify({ notes: '日本語 ✓' }))
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { for (const b of data) c.enqueue(Uint8Array.of(b)); c.close() } }))
  assert.deepEqual(await readUpdateJSON(url('a.json'), new AbortController().signal), { notes: '日本語 ✓' })
  globalThis.fetch = async () => new Response(bytes)
  const { directory } = await harness(t), file = path.join(directory, 'download.exe')
  await downloadUpdate(asset(), file, () => {}, new AbortController().signal)
  await verifyDownloadedFile(file, asset())
  await assert.rejects(() => downloadUpdate(asset(), file, () => {}, new AbortController().signal), /EEXIST/)
})
test('release preparation refuses branch divergence and a version not committed in the package', () => {
  validateRelease(version, version, [commit], commit)
  assert.throws(() => validateRelease(version, '1.0.0', [commit], commit), /exact Beta version/)
  assert.throws(() => validateRelease(version, version, ["b".repeat(40)], commit), /main must point/)
  assert.throws(() => validateRelease('1.0.2', '1.0.2', [commit], commit), /Beta version/)
})
test('missing signing secrets stay absent and Mac never imports a Windows certificate', () => {
  const input = { MAC_CSC_LINK: '', MAC_CSC_KEY_PASSWORD: '', WIN_CSC_LINK: 'windows-pfx', WIN_CSC_KEY_PASSWORD: 'password' }
  assert.equal('CSC_LINK' in signingEnvironment('darwin', input), false)
  assert.equal('WIN_CSC_LINK' in signingEnvironment('darwin', input), false)
  assert.equal(signingEnvironment('win32', input).CSC_LINK, 'windows-pfx')
  assert.equal(signingEnvironment('darwin', { MAC_CSC_LINK: 'mac-p12' }).CSC_LINK, 'mac-p12')
  assert.equal(input.WIN_CSC_LINK, 'windows-pfx')
})
test('release assembly requires all four matching builds and verifies actual package bytes', async (t) => {
  const { directory } = await harness(t)
  for (const a of manifest().assets) {
    const key = `${a.platform}-${a.arch}`
    await fs.writeFile(path.join(directory, new URL(a.url).pathname.split('/').at(-1)), bytes)
    await fs.writeFile(path.join(directory, `asset-${key}.json`), JSON.stringify({ ...a, version, commit }))
    if (a.platform === 'darwin') await fs.writeFile(path.join(directory, assetName(version, a.platform, a.arch, 'zip')), bytes)
  }
  const built = await assemble(directory, version, commit, 'Notes')
  assert.equal(parseUpdateManifest(built, version).assets.length, 4)
  await fs.writeFile(path.join(directory, assetName(version, 'win32', 'x64', 'exe')), 'corrupt')
  await assert.rejects(() => assemble(directory, version, commit, 'Notes'), /integrity verification/)
  await fs.rm(path.join(directory, 'asset-darwin-arm64.json'))
  await assert.rejects(() => assemble(directory, version, commit, 'Notes'), /ENOENT/)
})
test('draft and recipient scope survive restart without sending; corrupt storage is ignored', () => {
  let saved = null
  globalThis.localStorage = { getItem: () => saved, setItem: (_key, value) => { saved = value } }
  const state = { composerDraft: 'Unsent prompt', experienceProjectId: 'mba', composerScope: 'project', composerTargets: { codex: true, claude: false } }
  saveComposerWorkspace(state); assert.deepEqual(loadComposerWorkspace(), state)
  saved = '{broken'; assert.equal(loadComposerWorkspace(), null)
  saved = JSON.stringify({ ...state, composerTargets: [] }); assert.equal(loadComposerWorkspace(), null)
  delete globalThis.localStorage
})
test('native Windows process guard refuses a running Node bridge without terminating it', { skip: process.platform !== 'win32', timeout: 300000 }, async () => {
  // This test process is the harmless bridge stand-in. Excluding an impossible
  // main PID leaves it visible, so the actual PowerShell query must refuse.
  await assert.rejects(() => requireNoWindowsAgentConnections(process.execPath, -1), /Active agent connections/)
  await requireNoWindowsAgentConnections(path.join(os.tmpdir(), `absent-workbench-${crypto.randomUUID()}.exe`), process.pid)
  assert.doesNotThrow(() => process.kill(process.pid, 0))
})

test('helper failures are surfaced once after relaunch, without following symlinks', async t => {
  const {directory}=await harness(t)
  await fs.mkdir(path.join(directory,'download-one'))
  const file=path.join(directory,'download-one','install-error.log')
  await fs.writeFile(file,'Installer exited with code 2.')
  assert.match(await readInstallFailure(directory),/Installer exited with code 2/)
  assert.equal(await readInstallFailure(directory),null)
  assert.equal(await fs.readFile(file+'.reported','utf8'),'Installer exited with code 2.')
  if (process.platform !== 'win32') {
    await fs.symlink(file+'.reported',file)
    assert.equal(await readInstallFailure(directory),null)
  }
})

test('startup recovery never overwrites an update the user already started', async t => {
  let startup
  t.mock.method(globalThis, 'setTimeout', callback => { startup = callback; return { unref() {} } })
  t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }))
  t.mock.method(globalThis, 'clearTimeout', () => {})
  t.mock.method(globalThis, 'clearInterval', () => {})
  let finish
  const {service, directory}=await harness(t,{canRestart:async()=>true,download:async (_a,file)=>{await new Promise(resolve=>{finish=resolve});await fs.writeFile(file,bytes)}})
  await fs.mkdir(path.join(directory,'download-old'))
  await fs.writeFile(path.join(directory,'download-old','install-error.log'),'Previous failure')
  service.start();await service.check();const downloading=service.download()
  // Wait for the private download directory to be created before firing the
  // delayed startup callback; no real download or installer runs in this test.
  while (!finish) await new Promise(resolve=>setImmediate(resolve))
  startup();await new Promise(resolve=>setImmediate(resolve))
  assert.equal(service.snapshot().status,'downloading')
  finish();await downloading;assert.equal(service.snapshot().status,'ready')
  assert.equal(await fs.readFile(path.join(directory,'download-old','install-error.log'),'utf8'),'Previous failure')
})
