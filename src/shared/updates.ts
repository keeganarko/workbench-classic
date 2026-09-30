/** Release metadata is a protocol, not a Git branch snapshot. Only a published
 * release containing this manifest can become an installed-app update. */
export const UPDATE_REPOSITORY = 'keeganarko/workbench-classic'
export const UPDATE_CHANNEL = 'beta' as const
export type UpdatePlatform = 'darwin' | 'win32'
export type UpdateArch = 'arm64' | 'x64'
export interface UpdateAsset {
  platform: UpdatePlatform
  arch: UpdateArch
  url: string
  size: number
  sha512: string
  minSystemVersion: string
  /** Windows certificate thumbprint or Apple Team ID, verified during release. */
  signer: string | null
  macFeed?: string
}
export interface UpdateManifest {
  schema: 1
  version: string
  channel: 'beta'
  commit: string
  notes: string
  assets: UpdateAsset[]
}
export interface UpdateState {
  currentVersion: string
  platform: string
  arch: string
  channel: 'beta'
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'unsupported' | 'error'
  version: string | null
  notes: string
  checkedAt: number | null
  progress: number | null
  installMode: 'restart' | 'manual'
  error: string | null
}
export function emptyUpdateState(currentVersion = '', platform = '', arch = ''): UpdateState {
  return { currentVersion, platform, arch, channel: UPDATE_CHANNEL, status: 'idle', version: null, notes: '', checkedAt: null, progress: null, installMode: 'manual', error: null }
}
function semver(value: string): { numbers: number[]; pre: string[] } {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!match) throw new Error('Invalid release version')
  const numbers = match.slice(1, 4).map(Number), pre = match[4]?.split('.') ?? []
  if (numbers.some((n) => !Number.isSafeInteger(n)) || pre.some((p) => /^\d+$/.test(p) && (!Number.isSafeInteger(Number(p)) || (p.length > 1 && p.startsWith('0'))))) throw new Error('Invalid release version')
  return { numbers, pre }
}
export function compareVersions(a: string, b: string): number {
  const left = semver(a), right = semver(b)
  for (let i = 0; i < 3; i++) if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] > right.numbers[i] ? 1 : -1
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}
export function betaVersion(version: string): boolean {
  try { semver(version); return /^\d+\.\d+\.\d+-beta\.(0|[1-9]\d*)$/.test(version) } catch { return false }
}
export function releaseAssetURL(url: string, version?: string): boolean {
  try {
    const parsed = new URL(url)
    const prefix = `/${UPDATE_REPOSITORY}/releases/download/`
    const tail = parsed.pathname.slice(prefix.length).split('/')
    return parsed.origin === 'https://github.com' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
      && parsed.pathname.startsWith(prefix) && tail.length === 2 && tail[0].startsWith('v') && betaVersion(tail[0].slice(1))
      && (!version || tail[0] === `v${version}`) && /^[A-Za-z0-9_.-]+$/.test(tail[1])
  } catch { return false }
}
export function parseUpdateManifest(value: unknown, expectedVersion: string): UpdateManifest {
  const m = value as UpdateManifest
  if (!m || m.schema !== 1 || m.channel !== 'beta' || !betaVersion(m.version) || m.version !== expectedVersion
    || !/^[a-f0-9]{40}$/.test(m.commit) || typeof m.notes !== 'string' || m.notes.length > 12000
    || !Array.isArray(m.assets) || m.assets.length < 1 || m.assets.length > 4) throw new Error('Invalid Workbench update manifest')
  const keys = new Set<string>()
  for (const a of m.assets) {
    if (!a || typeof a !== 'object') throw new Error('Invalid Workbench update download')
    const key = `${a.platform}-${a.arch}`
    if (!['darwin', 'win32'].includes(a.platform) || !['arm64', 'x64'].includes(a.arch) || keys.has(key)
      || !releaseAssetURL(a.url, m.version) || !(a.platform === 'win32' ? a.url.endsWith('.exe') : a.url.endsWith('.dmg'))
      || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > 2 * 1024 ** 3 || !/^[a-f0-9]{128}$/.test(a.sha512)
      || (!/^\d+\.\d+\.\d+$/.test(a.minSystemVersion) || a.minSystemVersion.split('.').some((n) => !Number.isSafeInteger(Number(n)))) || (a.signer !== null && (typeof a.signer !== 'string' || !/^[A-Z0-9]{10,64}$/.test(a.signer)))
      || (a.macFeed !== undefined && (a.platform !== 'darwin' || !a.signer || !releaseAssetURL(a.macFeed, m.version) || !a.macFeed.endsWith('.json')))) throw new Error('Invalid Workbench update download')
    keys.add(key)
  }
  return m
}
export function selectUpdateAsset(manifest: UpdateManifest, platform: string, arch: string, systemVersion: string): UpdateAsset | null {
  const asset = manifest.assets.find((a) => a.platform === platform && a.arch === arch)
  if (!asset) return null
  const actual = systemVersion.split('.').slice(0, 3).map(Number), minimum = asset.minSystemVersion.split('.').map(Number)
  if (actual.length !== 3 || actual.some((n) => !Number.isSafeInteger(n))) return null
  for (let i = 0; i < 3; i++) {
    if (actual[i] > minimum[i]) return asset
    if (actual[i] < minimum[i]) return null
  }
  return asset
}
