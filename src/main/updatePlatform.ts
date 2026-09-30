/** Platform installation stays behind this adapter so release discovery and
 * integrity tests can run without launching an installer or quitting Electron. */
import { app, autoUpdater, shell } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { readUpdateJSON, verifyDownloadedFile } from './updates.js'
import { releaseAssetURL, type UpdateAsset } from '../shared/updates.js'
import { windowsSignature, windowsInstallerTrust, requireNoWindowsAgentConnections, launchWindowsInstaller } from './updateWindows.js'
import { canReplaceMacApplication, prepareMacUpdate } from './updateMac.js'
const exec = promisify(execFile)

export async function signerIdentity(file: string, platform = process.platform): Promise<string | null> {
  try {
    if (platform === 'win32') { const signature = await windowsSignature(file); return signature.status === 'Valid' ? signature.signer : null }
    if (platform === 'darwin') {
      await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', file], { timeout: 20000 })
      const { stderr } = await exec('/usr/bin/codesign', ['-dv', '--verbose=4', file], { timeout: 20000 })
      if (!stderr.includes('Authority=Developer ID Application:')) return null
      return /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(stderr)?.[1] ?? null
    }
  } catch { /* unsigned bootstrap builds still support installer downloads */ }
  return null
}

export class UpdatePlatformAdapter {
  private identity: Promise<string | null> | null = null
  private readonly prepare: () => Promise<void>
  private readonly exitForUpdate: (nativeMac: boolean | null) => void
  constructor(prepare: () => Promise<void>, exitForUpdate: (nativeMac: boolean | null) => void) {
    this.prepare = prepare; this.exitForUpdate = exitForUpdate
  }
  async canRestart(asset: UpdateAsset): Promise<boolean> {
    if (asset.platform !== process.platform) return false
    if (process.platform === 'win32') {
      const current = await windowsSignature(app.getPath('exe'))
      // An unsigned Beta is an explicit trust state, not a failed signature
      // check. Final installation verifies the actual downloaded executable too.
      return windowsInstallerTrust(current, current, asset.signer)
    }
    if (process.platform !== 'darwin') return false
    const executable = path.resolve(path.dirname(app.getPath('exe')), '../..')
    this.identity ??= signerIdentity(executable)
    if (await this.identity !== asset.signer) return false
    return asset.signer ? !!asset.macFeed : canReplaceMacApplication(app.getPath('exe'))
  }
  async stageMac(asset: UpdateAsset): Promise<void> {
    if (process.platform !== 'darwin' || !asset.macFeed || !await this.canRestart(asset)) throw new Error('This installation needs the Mac installer download first.')
    const version = asset.url.split('/').at(-2)!.slice(1)
    const feed = await readUpdateJSON(asset.macFeed, AbortSignal.timeout(30000)) as { url?: string; sha256?: string; size?: number }
    if (!feed || !releaseAssetURL(feed.url ?? '', version) || !feed.url?.endsWith('.zip') || !/^[a-f0-9]{64}$/.test(feed.sha256 ?? '')
      || !Number.isSafeInteger(feed.size) || feed.size! <= 0 || feed.size! > 2 * 1024 ** 3) throw new Error('Invalid signed Mac update feed')
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); autoUpdater.removeListener('error', fail); autoUpdater.removeListener('update-downloaded', ready); autoUpdater.removeListener('update-not-available', absent) }
      const fail = (error: Error): void => { cleanup(); reject(error) }
      const ready = (): void => { cleanup(); resolve() }
      const absent = (): void => fail(new Error('The Mac update is no longer available. Check again.'))
      const timer = setTimeout(() => fail(new Error('The Mac update timed out. Try downloading again.')), 30 * 60 * 1000)
      autoUpdater.once('error', fail); autoUpdater.once('update-downloaded', ready); autoUpdater.once('update-not-available', absent)
      try {
        // This per-version file uses Squirrel's server-response schema. Main
        // already compared versions; serverType:'json' expects a different,
        // multi-release schema and must not be used for this feed.
        autoUpdater.setFeedURL({ url: asset.macFeed! }); autoUpdater.checkForUpdates()
      } catch (error) { fail(error as Error) }
    })
  }
  async install(asset: UpdateAsset, file: string | null): Promise<void> {
    try {
      if (!await this.canRestart(asset)) throw new Error('The signing identity changed. Use the installer download.')
      if (process.platform === 'darwin' && !asset.macFeed) {
        if (!file) throw new Error('No Mac installer is ready')
        const staged = await prepareMacUpdate({ file, asset, executable: app.getPath('exe'), pid: process.pid, logDirectory: path.dirname(file) })
        try {
          await this.prepare()
          await staged.launch()
          this.exitForUpdate(false)
        } catch (error) { await staged.cleanup(); throw error }
        return
      }
      if (process.platform === 'darwin') {
        await this.prepare()
        this.exitForUpdate(true)
        await new Promise<void>((_resolve, reject) => {
          const fail = (error: Error): void => {
            clearTimeout(timer); autoUpdater.removeListener('error', fail)
            reject(error)
          }
          const timer = setTimeout(() => fail(new Error('The Mac updater did not restart Workbench. Try again.')), 30000)
          autoUpdater.once('error', fail)
          try { autoUpdater.quitAndInstall() } catch (error) { fail(error as Error) }
          // Successful installation exits this process. An error must instead
          // reach Settings, including asynchronous errors from Squirrel itself.
        })
        return
      }
      if (!file || process.platform !== 'win32') throw new Error('No Windows installer is ready')
      // MCP servers can re-enter Workbench.exe as Node and outlive its window.
      // NSIS kills processes in the install directory, including those bridges.
      // Refuse that handoff while they are alive instead of silently severing an
      // agent's tool connection. The helper repeats the check to close the race.
      await requireNoWindowsAgentConnections(app.getPath('exe'), process.pid)
      await verifyDownloadedFile(file, asset)
      if (!windowsInstallerTrust(await windowsSignature(app.getPath('exe')), await windowsSignature(file), asset.signer)) {
        throw new Error('The installer publisher does not match this Workbench installation.')
      }
      await this.prepare()
      await launchWindowsInstaller({ directory: path.dirname(file), installer: file, executable: app.getPath('exe'),
        pid: process.pid, sha512: asset.sha512, signer: asset.signer })
      this.exitForUpdate(false)
    } catch (error) {
      // Preparation can stop owned Services before any installer is launched.
      // Every rejected handoff restores their controls in the still-open app,
      // including native Mac updater errors delivered asynchronously.
      this.exitForUpdate(null)
      throw error
    }
  }

  async openInstaller(file: string): Promise<void> {
    // Exceptional location or publisher transitions still need a manual
    // installation; ordinary unsigned Beta updates use the verified handoff.
    shell.showItemInFolder(file)
  }
}
