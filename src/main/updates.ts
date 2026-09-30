import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { UPDATE_REPOSITORY, betaVersion, compareVersions, emptyUpdateState, parseUpdateManifest, releaseAssetURL, selectUpdateAsset, type UpdateAsset, type UpdateState } from '../shared/updates.js'

const RELEASES = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=100`
interface Release { draft: boolean; tag_name: string; assets: { name: string; browser_download_url: string }[] }
export interface UpdateDependencies {
  directory: string; version: string; platform: string; arch: string; systemVersion: string; packaged: boolean
  changed(): void
  readJSON(url: string, signal: AbortSignal): Promise<unknown>
  download(asset: UpdateAsset, file: string, progress: (value: number) => void, signal: AbortSignal): Promise<void>
  canRestart(asset: UpdateAsset): Promise<boolean>
  stageMac(asset: UpdateAsset): Promise<void>
  install(asset: UpdateAsset, file: string | null): Promise<void>
  openInstaller(file: string): Promise<void>
}

/** The renderer can request actions, but can never supply a download URL or
 * executable path. A selected, published release is the only authority for
 * either. Only one operation runs at a time; cancellation owns its own signal. */
export class UpdateService {
  private state: UpdateState
  private asset: UpdateAsset | null = null
  private file: string | null = null
  private busy = false
  private abort: AbortController | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private startup: ReturnType<typeof setTimeout> | null = null
  private readonly deps: UpdateDependencies
  constructor(deps: UpdateDependencies) {
    this.deps = deps
    this.state = emptyUpdateState(deps.version, deps.platform, deps.arch)
  }
  snapshot(): UpdateState { return { ...this.state } }
  private set(patch: Partial<UpdateState>): void { Object.assign(this.state, patch); this.deps.changed() }
  start(): void {
    if (!this.deps.packaged || this.timer) return
    this.startup = setTimeout(() => {
      // A detached helper cannot report through the old process after it quits.
      // Recover its failure before a successful release check hides the reason
      // the old version reopened. Consume only our bounded helper log files.
      if (this.busy || ['ready', 'installing', 'downloading'].includes(this.state.status)) return
      void readInstallFailure(this.deps.directory).then(error => {
        if (this.busy || ['ready', 'installing', 'downloading'].includes(this.state.status)) return
        if (error) this.set({ status: 'error', error })
        else void this.check()
      }).catch(() => { if (!this.busy && !['ready', 'installing', 'downloading'].includes(this.state.status)) this.set({ status: 'error', error: 'Could not read the last installation result. Check the update folder permissions.' }) })
    }, 15000)
    this.timer = setInterval(() => { if (['idle', 'current', 'available', 'unsupported', 'error'].includes(this.state.status)) void this.check() }, 4 * 60 * 60 * 1000)
    this.startup.unref(); this.timer.unref()
  }
  stop(): void { this.abort?.abort(); if (this.startup) clearTimeout(this.startup); if (this.timer) clearInterval(this.timer); this.timer = null }
  async check(): Promise<void> {
    if (this.busy || ['ready', 'installing'].includes(this.state.status)) return
    if (!this.deps.packaged || !['darwin', 'win32'].includes(this.deps.platform)) {
      this.set({ status: 'unsupported', error: this.deps.packaged ? 'In-app updates are available for the Windows and Mac applications.' : 'Development builds update from Git. Install a packaged Workbench to use app updates.' }); return
    }
    this.busy = true; this.abort = new AbortController()
    this.set({ status: 'checking', error: null, progress: null })
    try {
      const data = await this.deps.readJSON(RELEASES, this.abort.signal)
      if (!Array.isArray(data)) throw new Error('GitHub returned an invalid release list')
      const releases = (data as Release[]).filter((r) => r && !r.draft && typeof r.tag_name === 'string' && betaVersion(r.tag_name.slice(1)) && r.tag_name.startsWith('v')
        && Array.isArray(r.assets) && r.assets.some((a) => a.name === 'workbench-update.json'))
        .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)))
      const release = releases[0]
      this.asset = null; this.file = null
      if (!release || compareVersions(release.tag_name.slice(1), this.deps.version) <= 0) {
        this.set({ status: 'current', checkedAt: Date.now(), version: null, notes: '' }); return
      }
      const version = release.tag_name.slice(1), url = release.assets.find((a) => a.name === 'workbench-update.json')!.browser_download_url
      if (!releaseAssetURL(url, version)) throw new Error('Unrecognized Workbench release location')
      const manifest = parseUpdateManifest(await this.deps.readJSON(url, this.abort.signal), version)
      const asset = selectUpdateAsset(manifest, this.deps.platform, this.deps.arch, this.deps.systemVersion)
      if (!asset) { this.set({ status: 'unsupported', version, notes: manifest.notes, checkedAt: Date.now(), error: 'This release does not support your operating system version or processor yet.' }); return }
      this.asset = asset
      const canRestart = await this.deps.canRestart(asset)
      this.set({ status: 'available', version, notes: manifest.notes, checkedAt: Date.now(), installMode: canRestart ? 'restart' : 'manual' })
    } catch (error) { this.set({ status: 'error', error: (error as Error).message }) }
    finally { this.busy = false; this.abort = null }
  }
  async download(): Promise<void> {
    if (this.busy || !this.asset || !['available', 'error'].includes(this.state.status)) return
    this.busy = true; this.abort = new AbortController(); this.set({ status: 'downloading', error: null, progress: null })
    try {
      if (this.deps.platform === 'darwin' && this.asset.macFeed && this.state.installMode === 'restart') {
        await this.deps.stageMac(this.asset)
      } else {
        await fsp.mkdir(this.deps.directory, { recursive: true, mode: 0o700 })
        const folder = await fsp.mkdtemp(path.join(this.deps.directory, 'download-'))
        const file = path.join(folder, this.deps.platform === 'win32' ? 'Workbench-Setup.exe' : 'Workbench.dmg')
        try {
          await this.deps.download(this.asset, file, (progress) => this.set({ progress }), this.abort.signal)
          await verifyDownloadedFile(file, this.asset)
          this.file = file
        } catch (error) { await fsp.rm(folder, { recursive: true, force: true }); throw error }
      }
      this.set({ status: 'ready', progress: 100 })
    } catch (error) { this.set({ status: 'error', error: (error as Error).message, progress: null }) }
    finally { this.busy = false; this.abort = null }
  }
  async install(): Promise<void> {
    if (this.busy || this.state.status !== 'ready' || !this.asset) return
    this.busy = true
    let verified = false
    try {
      if (this.file) await verifyDownloadedFile(this.file, this.asset)
      verified = true
      if (this.state.installMode === 'manual') {
        if (!this.file) throw new Error('Download the installer again')
        await this.deps.openInstaller(this.file)
        this.set({ error: null })
      } else {
        this.set({ status: 'installing', error: null })
        await this.deps.install(this.asset, this.file)
      }
    } catch (error) {
      // A busy bridge or failed handoff postpones the restart, so keep its
      // verified payload available for retry. Each retry verifies again;
      // changed or missing bytes require a fresh download.
      this.set({ status: verified ? 'ready' : 'error', error: (error as Error).message })
    }
    finally { this.busy = false }
  }
}
export async function verifyDownloadedFile(file: string, asset: UpdateAsset): Promise<void> {
  const stat = await fsp.lstat(file)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== asset.size) throw new Error('The update download is incomplete. Download it again.')
  const hash = crypto.createHash('sha512')
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes)
  if (hash.digest('hex') !== asset.sha512) throw new Error('The update did not pass verification. Download it again.')
}

/** GitHub serves release assets through short-lived redirects. Limit every
 * hop to its HTTPS hosts instead of inheriting fetch's unrestricted redirects. */
export async function githubResponse(url: string, signal: AbortSignal): Promise<Response> {
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.username || u.password || !['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(u.hostname)) throw new Error('Unrecognized update server')
    const response = await fetch(u, { redirect: 'manual', signal, headers: { 'User-Agent': 'Workbench-Updater', Accept: 'application/vnd.github+json' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location'); if (!location) throw new Error('Invalid update redirect')
      url = new URL(location, u).href; continue
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 403 || response.status === 429 ? 'Update checks are temporarily rate-limited. Try again later.' : `Update server returned ${response.status}. Try again later.`) }
    return response
  }
  throw new Error('Too many update redirects')
}
export async function readUpdateJSON(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await githubResponse(url, AbortSignal.any([signal, AbortSignal.timeout(30000)]))
  if (!response.body) throw new Error('Empty update response')
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of Readable.fromWeb(response.body as never)) {
    bytes += chunk.length
    if (bytes > 2 * 1024 * 1024) throw new Error('Update metadata is too large')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export async function downloadUpdate(asset: UpdateAsset, file: string, progress: (value: number) => void, signal: AbortSignal): Promise<void> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)])
  const response = await githubResponse(asset.url, combined)
  if (!response.body) throw new Error('Empty update download')
  let bytes = 0, last = 0
  await pipeline(Readable.fromWeb(response.body as never), async function* (source) {
    for await (const chunk of source) {
      bytes += chunk.length
      if (bytes > asset.size) throw new Error('Update download exceeds its expected size')
      if (Date.now() - last > 250) { progress(Math.floor(bytes / asset.size * 100)); last = Date.now() }
      yield chunk
    }
  }, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: combined })
}

/** Install helpers write in a unique download folder, never a caller-provided
 * document. Keep reported logs for diagnosis without showing the same failure
 * on every future launch. No arbitrary paths are read from the log itself. */
export async function readInstallFailure(directory: string): Promise<string | null> {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []; throw error
  })
  const folders = entries.filter(entry => entry.isDirectory() && entry.name.startsWith('download-')).slice(-100)
  const failures: { file: string; time: number }[] = []
  for (const folder of folders) {
    const file = path.join(directory, folder.name, 'install-error.log')
    const stat = await fsp.lstat(file).catch(() => null)
    if (stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 16000) failures.push({ file, time: stat.mtimeMs })
  }
  failures.sort((a, b) => b.time - a.time)
  let latest: string | null = null
  for (const failure of failures) {
    const message = (await fsp.readFile(failure.file, 'utf8')).replace(/^\uFEFF/, '').trim()
    if (!latest && message) latest = `The last update could not finish: ${message.slice(0, 2000)}`
    await fsp.rename(failure.file, `${failure.file}.reported`)
  }
  return latest
}
