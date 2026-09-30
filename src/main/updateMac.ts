/** The Beta DMG carries an ad-hoc signature when no Developer ID is available.
 * That signature still seals the bundle, but cannot establish a publisher. The
 * release SHA-512 and installed signing policy therefore remain separate checks.
 * No command here removes quarantine, changes signing, or bypasses Gatekeeper. */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { betaVersion, releaseAssetURL, type UpdateAsset } from '../shared/updates.js'
import { verifyDownloadedFile } from './updates.js'

const exec = promisify(execFile)
const BUNDLE_ID = 'com.keeganarko.workbench'
type Command = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
const command: Command = (file, args) => exec(file, args, { timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })

async function realDirectory(directory: string): Promise<void> {
  // Checking each ancestor also catches an Applications directory redirected to
  // another volume or to an unexpected installation through a symbolic link.
  const stat = await fs.lstat(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The Mac update destination must be a real directory, without symbolic links.')
  if (directory !== path.dirname(directory)) await realDirectory(path.dirname(directory))
}
async function destinationFor(executable: string, home: string): Promise<string> {
  const destination = path.resolve(path.dirname(executable), '../..')
  if (executable !== path.join(destination, 'Contents', 'MacOS', 'Workbench')
    || !['/Applications/Workbench.app', path.join(home, 'Applications', 'Workbench.app')].includes(destination)) {
    throw new Error('Move Workbench to Applications before installing an update.')
  }
  await realDirectory(destination)
  await realDirectory(path.dirname(executable))
  const binary = await fs.lstat(executable)
  if (!binary.isFile() || binary.isSymbolicLink()) throw new Error('The installed Workbench executable is not a regular file.')
  await fs.access(path.dirname(destination), fs.constants.W_OK)
  return destination
}

/** Settings can offer the ordinary installer for a read-only or mounted copy.
 * Installation repeats this check; an earlier capability check grants nothing. */
export async function canReplaceMacApplication(executable: string, home = os.homedir()): Promise<boolean> {
  try { await destinationFor(executable, home); return true } catch { return false }
}

async function bundleIdentity(bundle: string, run: Command): Promise<{ signer: string | null; version: string }> {
  for (const relative of ['Contents', 'Contents/MacOS']) {
    const stat = await fs.lstat(path.join(bundle, relative))
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The update bundle contains an unexpected symbolic link.')
  }
  for (const relative of ['Contents/Info.plist', 'Contents/MacOS/Workbench']) {
    const stat = await fs.lstat(path.join(bundle, relative))
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The update bundle metadata and executable must be regular files.')
  }
  const field = async (key: string): Promise<string> => (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')])).stdout.trim()
  if (await field('CFBundleIdentifier') !== BUNDLE_ID || await field('CFBundleExecutable') !== 'Workbench') throw new Error('The downloaded app is not Workbench.')
  const version = await field('CFBundleShortVersionString')
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
  const details = (await run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle])).stderr
  const signer = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(details)?.[1] ?? null
  if (signer ? !details.includes('Authority=Developer ID Application:') : !/^Signature=adhoc$/m.test(details)) {
    throw new Error('The downloaded app has an unsupported signing identity.')
  }
  return { signer, version }
}

export interface MacUpdatePreparation {
  launch: () => Promise<void>
  cleanup: () => Promise<void>
}
export interface MacUpdateOptions {
  file: string
  asset: UpdateAsset
  executable: string
  pid: number
  /** Use the stable update directory so the next app start can report failure. */
  logDirectory: string
}
interface MacUpdateDependencies {
  run?: Command
  homeDirectory?: string
}

/** Do expensive copying and validation while the old app is still running.
 * The returned launch method is called only after the app has flushed state.
 * A system shell, stored outside either app bundle, owns the final handoff. */
export async function prepareMacUpdate(options: MacUpdateOptions, dependencies: MacUpdateDependencies = {}): Promise<MacUpdatePreparation> {
  const { file, asset, executable, pid, logDirectory } = options
  const run = dependencies.run ?? command
  if (asset.platform !== 'darwin' || !releaseAssetURL(asset.url) || !asset.url.endsWith('.dmg') || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid Mac update request.')
  const version = new URL(asset.url).pathname.split('/').at(-2)!.slice(1)
  if (!betaVersion(version)) throw new Error('Invalid Mac Beta update version.')
  const destination = await destinationFor(executable, dependencies.homeDirectory ?? os.homedir())
  await verifyDownloadedFile(file, asset)
  const installed = await bundleIdentity(destination, run)
  if (installed.signer !== asset.signer) throw new Error('The update publisher does not match this Workbench installation.')
  await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 })
  // The bundle and rollback copy live on the destination filesystem, so both
  // replacement moves are renames. Copying a DMG directly over the running app
  // could otherwise leave a partly replaced app after interruption or failure.
  const work = await fs.mkdtemp(path.join(path.dirname(destination), '.workbench-update-'))
  await fs.chmod(work, 0o700)
  const mount = path.join(work, 'volume'), staged = path.join(work, 'Workbench.app')
  await fs.mkdir(mount, { mode: 0o700 })
  let mounted = false, launched = false
  try {
    await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, file])
    mounted = true
    const source = path.join(mount, 'Workbench.app'), sourceStat = await fs.lstat(source)
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('The disk image does not contain a regular Workbench app.')
    await run('/usr/bin/ditto', ['--rsrc', '--extattr', source, staged])
    const incoming = await bundleIdentity(staged, run)
    if (incoming.version !== version || incoming.signer !== installed.signer) throw new Error('The downloaded app version or publisher does not match the release.')
    const architecture = (await run('/usr/bin/lipo', ['-archs', path.join(staged, 'Contents/MacOS/Workbench')])).stdout.trim().split(/\s+/)
    if (!architecture.includes(asset.arch === 'arm64' ? 'arm64' : 'x86_64')) throw new Error('The downloaded app does not support this Mac processor.')
    await run('/usr/bin/hdiutil', ['detach', mount]); mounted = false
    // Recheck the sealed image after mounting/copying, before giving the helper
    // a trusted staged bundle; no mutable payload is accepted only once.
    await verifyDownloadedFile(file, asset)
    const processStart = (await run('/bin/ps', ['-p', String(pid), '-o', 'lstart='])).stdout.trim()
    if (!processStart) throw new Error('The running Workbench process could not be identified.')
    const destinationStat = await fs.lstat(destination), stagedStat = await fs.lstat(staged)
    const script = path.join(work, 'install.sh')
    await fs.writeFile(script, macInstallScript({ destination, work, pid, processStart, version, signer: incoming.signer,
      destinationIdentity: `${destinationStat.dev}:${destinationStat.ino}`, stagedIdentity: `${stagedStat.dev}:${stagedStat.ino}`,
      log: path.join(logDirectory, 'install-error.log') }), { mode: 0o700, flag: 'wx' })
    return {
      launch: async () => {
        if (launched) throw new Error('The Mac update has already started.')
        const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', HOME: os.homedir(), TMPDIR: os.tmpdir() } })
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
        launched = true
        try {
          // A spawn event only confirms /bin/sh started. Wait until the helper
          // has read its script and validated its tool paths before app quit.
          const deadline = Date.now() + 5000
          while (true) {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('The Mac update helper stopped before installation could begin.')
            try { await fs.access(path.join(work, 'ready')); break } catch { /* helper is starting */ }
            if (Date.now() >= deadline) throw new Error('The Mac update helper did not become ready. Try again.')
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
          child.unref()
        } catch (error) {
          const stopped = new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()) })
          child.kill('SIGTERM'); await stopped; launched = false
          throw error
        }
      },
      cleanup: async () => { if (!launched) await fs.rm(work, { recursive: true, force: true }) }
    }
  } catch (error) {
    // Never recursively delete a mountpoint while an image is still mounted.
    // A failed detach leaves a harmless private staging directory for recovery.
    if (mounted) {
      try { await run('/usr/bin/hdiutil', ['detach', mount]); mounted = false } catch { /* preserve mounted content */ }
    }
    if (!mounted) await fs.rm(work, { recursive: true, force: true })
    throw error
  }
}

interface MacInstallConfiguration {
  destination: string
  work: string
  pid: number
  processStart: string
  version: string
  signer: string | null
  destinationIdentity: string
  stagedIdentity: string
  log: string
}
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`
const MAC_COMMANDS = { stat: '/usr/bin/stat', codesign: '/usr/bin/codesign', plutil: '/usr/bin/plutil', open: '/usr/bin/open', ps: '/bin/ps', mv: '/bin/mv', sleep: '/bin/sleep' }

/** Command overrides exist only as a module-level test seam. Production always
 * writes absolute system tool paths; no PATH lookup selects an installer tool. */
export function macInstallScript(config: MacInstallConfiguration, commands = MAC_COMMANDS): string {
  const variables = Object.entries({ destination: config.destination, work: config.work, pid: String(config.pid), process_start: config.processStart,
    version: config.version, signer: config.signer ?? '', destination_identity: config.destinationIdentity, staged_identity: config.stagedIdentity,
    log: config.log, ...commands }).map(([key, value]) => `${key}=${shellQuote(value)}`).join('\n')
  return `#!/bin/sh\n${variables}\n` + String.raw`
set -eu
umask 077
staged="$work/Workbench.app"
backup="$work/previous.app"
output="$work/install-output.log"
moved_old=0
moved_new=0
finished=0
app_closed=0
# Leave a durable explanation for the next startup. If rollback itself fails,
# keep the previous bundle and report its location rather than deleting it.
finish() {
  code=$?
  trap - EXIT HUP INT TERM
  if [ "$finished" != 1 ]; then
    if [ -f "$output" ]; then /bin/cat "$output" > "$log"; else : > "$log"; fi
    printf '%s\n' "Workbench update failed (step: $step)." >> "$log"
    if [ "$moved_old" = 1 ]; then
      if [ "$moved_new" = 1 ] && [ -d "$destination" ] && [ ! -L "$destination" ]; then
        "$mv" "$destination" "$work/failed.app" || true
      fi
      if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
        "$mv" "$backup" "$destination" || printf '%s\n' "Previous app preserved at $backup. Move it back to $destination." >> "$log"
      fi
    fi
    if [ "$app_closed" = 1 ] && [ -d "$destination" ] && [ ! -L "$destination" ] &&
      [ "$("$stat" -f '%d:%i' "$destination")" = "$destination_identity" ]; then
      "$open" -n "$destination" >> "$log" 2>&1 || true
    fi
  fi
  exit "$code"
}
step='waiting for Workbench to finish closing'
trap finish EXIT
trap 'exit 1' HUP INT TERM
[ -d "$work" ] && [ ! -L "$work" ] || exit 1
for tool in "$stat" "$codesign" "$plutil" "$open" "$ps" "$mv" "$sleep"; do [ -x "$tool" ] || exit 1; done
/usr/bin/touch "$work/ready"
count=0
while kill -0 "$pid" 2>/dev/null; do
  # PID reuse cannot authorize waiting on or terminating a different process.
  current_start=$("$ps" -p "$pid" -o lstart= 2>/dev/null || true)
  if [ -z "$current_start" ]; then kill -0 "$pid" 2>/dev/null && exit 1; break; fi
  current_start=$(printf '%s' "$current_start" | /usr/bin/sed 's/^ *//;s/ *$//')
  [ "$current_start" = "$process_start" ] || break
  [ "$count" -lt 120 ] || exit 1
  count=$((count + 1))
  "$sleep" 1
done
app_closed=1
step='checking the installation paths'
[ -d "$work" ] && [ ! -L "$work" ] || exit 1
[ -d "$destination" ] && [ ! -L "$destination" ] || exit 1
[ -d "$staged" ] && [ ! -L "$staged" ] || exit 1
[ ! -e "$backup" ] && [ ! -L "$backup" ] || exit 1
[ "$("$stat" -f '%d:%i' "$destination")" = "$destination_identity" ]
[ "$("$stat" -f '%d:%i' "$staged")" = "$staged_identity" ]
# Check all ancestors again after the old process closes. Normal Electron
# framework symlinks inside a sealed bundle remain permitted.
parent=$destination
while [ "$parent" != / ]; do
  [ -d "$parent" ] && [ ! -L "$parent" ] || exit 1
  parent=$(/usr/bin/dirname "$parent")
  [ -n "$parent" ] || parent=/
done
validate() {
  bundle=$1
  [ -d "$bundle/Contents" ] && [ ! -L "$bundle/Contents" ] || return 1
  [ -d "$bundle/Contents/MacOS" ] && [ ! -L "$bundle/Contents/MacOS" ] || return 1
  [ -f "$bundle/Contents/Info.plist" ] && [ ! -L "$bundle/Contents/Info.plist" ] || return 1
  [ -f "$bundle/Contents/MacOS/Workbench" ] && [ ! -L "$bundle/Contents/MacOS/Workbench" ] || return 1
  [ "$("$plutil" -extract CFBundleIdentifier raw -o - "$bundle/Contents/Info.plist")" = 'com.keeganarko.workbench' ]
  [ "$("$plutil" -extract CFBundleExecutable raw -o - "$bundle/Contents/Info.plist")" = Workbench ]
  [ "$("$plutil" -extract CFBundleShortVersionString raw -o - "$bundle/Contents/Info.plist")" = "$version" ]
  "$codesign" --verify --deep --strict "$bundle"
  details=$("$codesign" -dv --verbose=4 "$bundle" 2>&1)
  if [ -n "$signer" ]; then
    printf '%s\n' "$details" | /usr/bin/grep -Fx "TeamIdentifier=$signer"
    printf '%s\n' "$details" | /usr/bin/grep -F 'Authority=Developer ID Application:'
  else
    printf '%s\n' "$details" | /usr/bin/grep -Fx 'Signature=adhoc'
    if printf '%s\n' "$details" | /usr/bin/grep -E '^TeamIdentifier=[A-Z0-9]{10}$'; then return 1; fi
  fi
}
step='verifying the staged application'
validate "$staged" >> "$output" 2>&1
step='saving the previous application'
"$mv" "$destination" "$backup" >> "$output" 2>&1
moved_old=1
step='replacing the application'
"$mv" "$staged" "$destination" >> "$output" 2>&1
moved_new=1
step='verifying the installed application'
validate "$destination" >> "$output" 2>&1
step='relaunching Workbench'
# Launch Services continues to enforce Gatekeeper and quarantine policy. A
# launch failure restores the previous version and leaves the error for it.
"$open" -n "$destination" >> "$output" 2>&1
finished=1
/bin/rm -f "$log"
/bin/rm -rf "$work"
`
}
