/**
 * Detect and open an existing desktop installation. The renderer cannot supply
 * an executable path, shell command, registry key, or launch arguments. On WSLg,
 * a fixed PowerShell query reaches the Windows desktop installation; that
 * remains a clipboard fallback, not a claim of native Linux Flow support.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listDir } from './files.js'
import type { FlowStatus, DictationFiles } from '../shared/dictation.js'
import { isReferencePath } from '../shared/dictation.js'
import { readFlowAutoTransform } from '../shared/flowContext.js'
import type { FlowAutoTransform } from '../shared/flowContext.js'

const exec = promisify(execFile)
const WINDOWS_QUERY = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$root = Join-Path $env:LOCALAPPDATA "WisprFlow"',
  '$candidates = @()',
  'if (Test-Path -LiteralPath $root) {',
  '  $candidates += Join-Path $root "Wispr Flow.exe"',
  '  $candidates += Get-ChildItem -LiteralPath $root -Directory -Filter "app-*" | Where-Object { $_.Name -match "^app-\\d+\\.\\d+\\.\\d+$" } | Sort-Object { [version]($_.Name.Substring(4)) } -Descending | Select-Object -First 12 | ForEach-Object { Join-Path $_.FullName "Wispr Flow.exe" }',
  '}',
  '$candidates += Join-Path $env:LOCALAPPDATA "Programs\\Wispr Flow\\Wispr Flow.exe"',
  '$candidates += Join-Path $env:LOCALAPPDATA "Programs\\WisprFlow\\Wispr Flow.exe"',
  '$found = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1',
  'if ($found) { [Console]::Write($found) }'
].join('\n')
export function flowPlatform(platform = process.platform, wsl = Boolean(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME)): FlowStatus['platform'] {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : platform === 'linux' && wsl ? 'wsl' : 'unsupported'
}
const powershell = (platform: FlowStatus['platform']): string => platform === 'wsl'
  ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
  : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const windowsEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
async function installation(platform: FlowStatus['platform']): Promise<string | null> {
  if (platform === 'windows' || platform === 'wsl') {
    const { stdout } = await exec(powershell(platform), ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY], { timeout: 8000, maxBuffer: 8192, windowsHide: true, env: windowsEnv() })
    const result = stdout.trim()
    return /^[A-Za-z]:\\[^\r\n]+\\Wispr Flow\.exe$/i.test(result) ? result : null
  }
  if (platform === 'mac') {
    for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      for (const name of ['Wispr Flow.app', 'Flow.app']) {
        const appPath = path.join(root, name)
        try {
          await fs.access(appPath)
          const { stdout } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(appPath, 'Contents/Info.plist')], { timeout: 3000 })
          if (/wispr/i.test(stdout)) return appPath
        } catch { /* A similarly named app is not evidence of a Flow install. */ }
      }
    }
  }
  return null
}
/**
 * Where Flow keeps its settings. Flow is an Electron app, so this is the
 * standard `userData` location for its app name. From WSL the Windows profile
 * is reached through /mnt/c; the user name is discovered by looking for the
 * file rather than guessed from $USER, which differs between the two worlds.
 */
export async function flowConfigPaths(platform: ReturnType<typeof flowPlatform>): Promise<string[]> {
  const tail = path.join('Wispr Flow', 'config.json')
  if (platform === 'windows') return [path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), tail)]
  if (platform === 'mac') return [path.join(os.homedir(), 'Library', 'Application Support', tail)]
  if (platform !== 'wsl') return []
  const users = '/mnt/c/Users'
  let names: string[] = []
  try { names = (await fs.readdir(users, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name) } catch { return [] }
  return names.filter(name => !/^(Public|Default|Default User|All Users)$/i.test(name)).map(name => path.join(users, name, 'AppData', 'Roaming', tail))
}
/**
 * Reads one setting out of Flow's config and nothing else. The file also holds
 * Flow's session tokens, so the parsed object never leaves this function: only
 * the two-field summary does. Flow rewrites this file itself while running,
 * which is why Workbench only ever reads it.
 */
export async function readFlowAutoTransformFile(file: string): Promise<FlowAutoTransform | null> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null
    return readFlowAutoTransform(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch { return null }
}
async function autoTransform(platform: ReturnType<typeof flowPlatform>): Promise<FlowAutoTransform | null> {
  for (const file of await flowConfigPaths(platform)) {
    const setting = await readFlowAutoTransformFile(file)
    if (setting) return setting
  }
  return null
}
export async function flowStatus(): Promise<FlowStatus> {
  const platform = flowPlatform()
  let installed = false, error = false
  try { installed = Boolean(await installation(platform)) } catch { error = true }
  return {
    platform, installed, appName: installed ? 'Wispr Flow' : null,
    autoTransform: installed ? await autoTransform(platform) : null,
    shortcut: platform === 'mac' ? 'Fn (or your Flow shortcut)' : platform === 'unsupported' ? 'Copy and paste a transcript' : 'Ctrl+Win (or your Flow shortcut)',
    detail: error ? 'Could not check this desktop. You can still open Flow yourself and paste a transcript.' :
      platform === 'wsl' ? (installed ? 'Windows Flow detected through WSL. Use Copy last transcript, then Paste transcript here; the native Windows build supports direct insertion.' : 'Using WSL. Open or install Flow on Windows, then copy and paste a transcript here.') :
      platform === 'unsupported' ? 'Flow has no native Linux desktop integration here. A copied transcript can still be pasted.' :
      installed ? 'Desktop installation found. Focus the prompt and use your Flow shortcut.' : 'Flow was not found in its standard installation folders. Install it or open a custom installation yourself.'
  }
}
export async function openFlow(openPath: (target: string) => Promise<string>): Promise<void> {
  const platform = flowPlatform(), target = await installation(platform)
  if (!target) throw new Error('Flow was not found. Open your installation yourself or install Wispr Flow first.')
  if (platform === 'windows' || platform === 'wsl') {
    // WSL does not forward arbitrary environment variables into Windows unless
    // WSLENV lists them. Encode one properly quoted, discovered path instead;
    // no renderer input is ever interpolated into this command.
    const script = "Start-Process -FilePath '" + target.replace(/'/g, "''") + "'"
    await exec(powershell(platform), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 8000, windowsHide: true, env: windowsEnv() })
  } else {
    const error = await openPath(target)
    if (error) throw new Error(error)
  }
}
const excluded = /^(?:\..*|node_modules|vendor|dist|out|release|coverage|artifacts|vault|__pycache__|credentials?|secrets?)$/i
const privateName = /(?:^|[._-])(?:secret|credentials?|private[-_]?key|token)(?:[._-]|$)|\.(?:pem|key|p12|pfx|kdbx)$/i
const extensions = /\.(?:[cm]?[jt]sx?|py|rs|go|java|swift|c|h|cpp|hpp|cs|rb|php|vue|svelte|css|scss|html|md|markdown|json|ya?ml|toml|sql|sh)$/i
export async function dictationFiles(root: string): Promise<DictationFiles> {
  const files: string[] = [], queue = [{ rel: '', depth: 0 }]
  let visited = 0, truncated = false
  const deadline = Date.now() + 2500
  while (queue.length) {
    if (visited >= 3000 || files.length >= 2000 || Date.now() > deadline) { truncated = true; break }
    const current = queue.shift()!
    const entries = await listDir(root, current.rel)
    if (entries.length >= 1000) truncated = true
    for (const entry of entries) {
      visited++
      if (excluded.test(entry.name) || privateName.test(entry.name) || !isReferencePath(entry.rel)) continue
      if (entry.dir) {
        if (current.depth < 8) queue.push({ rel: entry.rel, depth: current.depth + 1 })
        else truncated = true
      } else if (extensions.test(entry.name)) files.push(entry.rel)
      if (visited >= 3000 || files.length >= 2000) { truncated = true; break }
    }
  }
  return { files: files.sort(), truncated }
}
