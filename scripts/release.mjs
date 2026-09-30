/** Release jobs are explicit operations. Ordinary branch pushes never call
 * this entry point. Every asset carries the source commit and package version,
 * so assembly cannot accidentally combine builds from different machines. */
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const repository = 'keeganarko/workbench-classic'
export const platforms = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64']
const invoke = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })
const github = (endpoint) => JSON.parse(invoke('gh', ['api', endpoint]))
const assetURL = (version, name) => `https://github.com/${repository}/releases/download/v${version}/${name}`
export function validateRelease(version, packageVersion, heads, commit) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/.test(version) || version !== packageVersion) throw new Error('Enter the exact Beta version committed in package.json and package-lock.json.')
  if (!/^[a-f0-9]{40}$/.test(commit) || heads.some((head) => head !== commit) || heads.length !== 1) throw new Error('main must point to the selected release commit.')
}
export async function checksum(file, algorithm = 'sha512') {
  const hash = crypto.createHash(algorithm)
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export function assetName(version, platform, arch, extension) {
  if (!platforms.includes(`${platform}-${arch}`)) throw new Error('Unsupported release target')
  return `Workbench-${version}-${platform === 'darwin' ? 'mac' : 'win'}-${arch}.${extension}`
}
export function signingEnvironment(platform, source) {
  const env = { ...source }
  const link = platform === 'darwin' ? source.MAC_CSC_LINK : source.WIN_CSC_LINK
  const password = platform === 'darwin' ? source.MAC_CSC_KEY_PASSWORD : source.WIN_CSC_KEY_PASSWORD
  // GitHub supplies missing secrets as empty strings. On Mac electron-builder
  // resolves an empty CSC_LINK to the checkout directory and tries importing
  // that directory as a certificate. An unsigned build needs the key absent.
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete env[key]
  if (link?.trim()) { env.CSC_LINK = link; env.CSC_KEY_PASSWORD = password ?? '' }
  return env
}
async function prepare() {
  const version = process.env.RELEASE_VERSION, commit = process.env.GITHUB_SHA
  if (process.env.GITHUB_REF_NAME !== 'main') throw new Error('Run Publish Beta from main.')
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'))
  const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'))
  if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) throw new Error('Commit matching package and lockfile versions first.')
  const heads = ['main'].map((branch) => github(`repos/${repository}/git/ref/heads/${branch}`).object.sha)
  validateRelease(version, pkg.version, heads, commit)
  const notes = process.env.RELEASE_NOTES ?? ''
  if (!notes.trim() || notes.length > 12000) throw new Error('Add release notes (up to 12,000 characters).')
  if (process.env.RELEASE_PUBLISH === 'true') {
    // A failed HTTP request is not evidence that a tag is free. List refs and
    // inspect successful responses, rather than treating every gh error as 404.
    const tags = github(`repos/${repository}/git/matching-refs/tags/v${version}`)
    if (tags.some((tag) => tag.ref === `refs/tags/v${version}`)) throw new Error('This version already has a tag. Publish a new version; existing releases are immutable.')
  }
  await fs.appendFile(process.env.GITHUB_OUTPUT, `commit=${commit}\nversion=${version}\n`)
}
async function signer(file) {
  if (process.platform === 'win32') {
    // Actions runs in PowerShell 7. Its inherited module path makes Windows
    // PowerShell 5 load incompatible Security modules; let 5 use its own defaults.
    const env = Object.fromEntries(Object.entries({ ...process.env, WORKBENCH_SIGNED_FILE: path.resolve(file) }).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
    const output = invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s=Get-AuthenticodeSignature -LiteralPath $env:WORKBENCH_SIGNED_FILE; if ($s.Status -eq "Valid") { $s.SignerCertificate.Thumbprint }'], { env }).trim()
    return /^[A-F0-9]{40,64}$/.test(output) ? output : null
  }
  try {
    invoke('/usr/bin/codesign', ['--verify', '--deep', '--strict', file])
    // codesign writes its identity to stderr; use spawnSync below to keep that
    // output separate from the command's exit status and never parse a shell.
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', file], { encoding: 'utf8' })
    if (result.status !== 0 || !result.stderr.includes('Authority=Developer ID Application:')) return null
    return /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(result.stderr)?.[1] ?? null
  } catch { return null }
}
async function packageRelease() {
  const version = process.env.RELEASE_VERSION, arch = process.env.RELEASE_ARCH, platform = process.platform
  if (process.arch !== arch || !platforms.includes(`${platform}-${arch}`)) throw new Error('Use a native runner for each processor; node-pty must match the packaged app.')
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'))
  if (pkg.version !== version) throw new Error('Package version changed after release preparation')
  const buildEnv = signingEnvironment(platform, process.env)
  const signed = !!buildEnv.CSC_LINK
  if (platform === 'darwin' && signed && (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID)) throw new Error('Signed Mac releases require Apple notarization credentials.')
  const config = { ...pkg.build, publish: null,
    mac: { ...pkg.build.mac, target: ['dmg', 'zip'], minimumSystemVersion: '13.0.0',
      artifactName: assetName(version, platform, arch, '${ext}'), notarize: signed,
      ...(signed ? { hardenedRuntime: true } : { identity: '-', hardenedRuntime: false }) },
    win: { ...pkg.build.win, artifactName: assetName(version, platform, arch, '${ext}') } }
  const configFile = '.release-config.json'
  await fs.writeFile(configFile, JSON.stringify(config))
  try { invoke(process.execPath, ['node_modules/electron-builder/cli.js', '--config', configFile, platform === 'darwin' ? '--mac' : '--win', `--${arch}`, '--publish', 'never'], { stdio: 'inherit', env: buildEnv }) }
  finally { await fs.rm(configFile, { force: true }) }
  const directory = 'release/update-assets'
  await fs.mkdir(directory, { recursive: true })
  const name = assetName(version, platform, arch, platform === 'darwin' ? 'dmg' : 'exe')
  const source = path.join('release', name), destination = path.join(directory, name)
  await fs.copyFile(source, destination)
  const appFile = platform === 'darwin' ? path.join('release', arch === 'arm64' ? 'mac-arm64' : 'mac', 'Workbench.app') : source
  const identity = await signer(appFile)
  if (signed && !identity) throw new Error('Signing was configured but the built package has no valid distribution signature.')
  const descriptor = { version, commit: process.env.RELEASE_COMMIT, platform, arch, url: assetURL(version, name),
    size: (await fs.stat(destination)).size, sha512: await checksum(destination),
    minSystemVersion: platform === 'darwin' ? '22.0.0' : '10.0.19041', signer: identity }
  if (platform === 'darwin') {
    const zip = assetName(version, platform, arch, 'zip')
    await fs.copyFile(path.join('release', zip), path.join(directory, zip))
    if (identity) {
      const feed = `mac-${arch}.json`
      await fs.writeFile(path.join(directory, feed), JSON.stringify({ url: assetURL(version, zip), name: version,
        notes: process.env.RELEASE_NOTES, pub_date: new Date().toISOString(),
        sha256: await checksum(path.join(directory, zip), 'sha256'), size: (await fs.stat(path.join(directory, zip))).size }, null, 2))
      descriptor.macFeed = assetURL(version, feed)
    }
  }
  await fs.writeFile(path.join(directory, `asset-${platform}-${arch}.json`), JSON.stringify(descriptor, null, 2))
}
export async function assemble(directory, version, commit, notes) {
  const assets = []
  for (const key of platforms) {
    const descriptor = JSON.parse(await fs.readFile(path.join(directory, `asset-${key}.json`), 'utf8'))
    if (descriptor.version !== version || descriptor.commit !== commit || `${descriptor.platform}-${descriptor.arch}` !== key) throw new Error('Release artifacts do not all come from the same version and source commit.')
    const name = assetName(version, descriptor.platform, descriptor.arch, descriptor.platform === 'darwin' ? 'dmg' : 'exe')
    if (descriptor.url !== assetURL(version, name)) throw new Error('Unexpected release asset URL')
    const file = path.join(directory, name)
    if ((await fs.stat(file)).size !== descriptor.size || await checksum(file) !== descriptor.sha512) throw new Error(`Release asset failed integrity verification: ${name}`)
    if (descriptor.platform === 'darwin') {
      const zip = assetName(version, descriptor.platform, descriptor.arch, 'zip'), zipFile = path.join(directory, zip)
      if (!(await fs.stat(zipFile)).size) throw new Error('Missing Mac ZIP payload')
      if (descriptor.signer) {
        const feedName = `mac-${descriptor.arch}.json`
        const feed = JSON.parse(await fs.readFile(path.join(directory, feedName), 'utf8'))
        if (descriptor.macFeed !== assetURL(version, feedName) || feed.url !== assetURL(version, zip)
          || feed.sha256 !== await checksum(zipFile, 'sha256') || feed.size !== (await fs.stat(zipFile)).size) throw new Error('Mac update feed does not match the ZIP payload')
      }
    }
    const { version: _version, commit: _commit, ...asset } = descriptor
    assets.push(asset)
  }
  const manifest = { schema: 1, channel: 'beta', version, commit, notes, assets }
  await fs.writeFile(path.join(directory, 'workbench-update.json'), JSON.stringify(manifest, null, 2))
  return manifest
}
async function publish() {
  if (process.env.RELEASE_PUBLISH !== 'true') throw new Error('Publishing was not explicitly selected')
  const version = process.env.RELEASE_VERSION, directory = 'release/update-assets'
  await assemble(directory, version, process.env.RELEASE_COMMIT, process.env.RELEASE_NOTES)
  const notesFile = path.join(directory, 'release-notes.md')
  await fs.writeFile(notesFile, process.env.RELEASE_NOTES)
  // Draft first, upload every asset, publish last. Any failure leaves an
  // invisible draft rather than advertising an update that cannot download.
  invoke('gh', ['release', 'create', `v${version}`, '--repo', repository, '--target', process.env.RELEASE_COMMIT,
    '--draft', '--prerelease', '--title', `Workbench Beta ${version}`, '--notes-file', notesFile])
  const files = (await fs.readdir(directory)).filter((name) => !name.startsWith('asset-') && name !== 'release-notes.md')
  invoke('gh', ['release', 'upload', `v${version}`, '--repo', repository, ...files.map((name) => path.join(directory, name))])
  invoke('gh', ['release', 'edit', `v${version}`, '--repo', repository, '--draft=false', '--prerelease', '--latest=false'])
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const commands = { prepare, package: packageRelease, assemble: () => assemble('release/update-assets', process.env.RELEASE_VERSION, process.env.RELEASE_COMMIT, process.env.RELEASE_NOTES), publish }
  const command = commands[process.argv[2]]
  if (!command) throw new Error('Expected prepare, package, assemble or publish')
  await command()
}
