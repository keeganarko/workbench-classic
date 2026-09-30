import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export const powershellPath = (): string => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
// A PowerShell 7 parent must not supply its incompatible Security/Management
// modules to the built-in Windows PowerShell used for update verification.
export const powershellEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))

export interface WindowsSignature { status: string; signer: string | null }

/** NotSigned is an explicit Authenticode result. Verification failures must
 * never fall through to the unsigned Beta bootstrap path. */
export async function windowsSignature(file: string): Promise<WindowsSignature> {
  const { stdout } = await promisify(execFile)(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:WORKBENCH_UPDATE_FILE; @{status=$s.Status.ToString(); signer=$(if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { $null })} | ConvertTo-Json -Compress"],
  { env: { ...powershellEnv(), WORKBENCH_UPDATE_FILE: file }, windowsHide: true, timeout: 30000 })
  const result = JSON.parse(stdout.trim()) as WindowsSignature
  if (!result || typeof result.status !== 'string' || !(result.signer === null || typeof result.signer === 'string' && /^[A-F0-9]{40,64}$/i.test(result.signer))) throw new Error('Windows could not verify the update publisher.')
  return { status: result.status, signer: result.signer?.toUpperCase() ?? null }
}

export function windowsInstallerTrust(current: WindowsSignature, installer: WindowsSignature, expectedSigner: string | null): boolean {
  if (expectedSigner === null) return current.status === 'NotSigned' && current.signer === null && installer.status === 'NotSigned' && installer.signer === null
  if (!/^[A-F0-9]{40,64}$/i.test(expectedSigner)) return false
  return current.status === 'Valid' && installer.status === 'Valid' && current.signer?.toUpperCase() === expectedSigner.toUpperCase() && installer.signer?.toUpperCase() === expectedSigner.toUpperCase()
}

/** NSIS terminates processes in the install directory. Electron's renderer
 * children close with main, but MCP bridges re-enter the executable as Node
 * and belong to still-running agents. Keep those connections alive. A failed
 * or malformed process query cannot be interpreted as permission to install. */
export async function requireNoWindowsAgentConnections(executable: string, pid: number): Promise<void> {
  const { stdout } = await promisify(execFile)(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:WORKBENCH_UPDATE_EXE -and $_.ProcessId -ne [int]$env:WORKBENCH_UPDATE_PID -and $_.CommandLine -notmatch '--type=' }).Count"],
  { env: { ...powershellEnv(), WORKBENCH_UPDATE_EXE: executable, WORKBENCH_UPDATE_PID: String(pid) }, windowsHide: true, timeout: 20000 })
  if (stdout.trim() !== '0') throw new Error('Active agent connections are using Workbench. Finish those agent sessions before installing the update.')
}

export interface WindowsInstallerConfig {
  /** Private update directory; install-error.log survives an unsuccessful handoff. */
  directory: string
  installer: string
  executable: string
  pid: number
  sha512: string
  signer: string | null
}

/** Return only once a live helper has validated the handoff and holds a handle
 * to the current process. The caller can then quit after saving app state.
 * Spawning PowerShell alone does not prove that the helper actually started. */
export async function launchWindowsInstaller(config: WindowsInstallerConfig): Promise<void> {
  if (!Number.isSafeInteger(config.pid) || config.pid <= 0 || !/^[a-f0-9]{128}$/.test(config.sha512)
    || config.signer !== null && !/^[A-F0-9]{40,64}$/i.test(config.signer)
    || ![config.directory, config.installer, config.executable].every((p) => path.isAbsolute(p) && !/[\r\n\0"]/.test(p))) throw new Error('Invalid Windows update handoff.')
  await fs.mkdir(config.directory, { recursive: true, mode: 0o700 })
  const token = randomUUID(), ready = path.join(config.directory, 'install-ready.json'), acknowledged = path.join(config.directory, 'install-acknowledged.json'), errorLog = path.join(config.directory, 'install-error.log')
  await fs.rm(ready, { force: true })
  await fs.rm(acknowledged, { force: true })
  await fs.rm(errorLog, { force: true })
  const configFile = path.join(config.directory, 'install.json')
  await fs.writeFile(configFile, JSON.stringify({ ...config, token }), { mode: 0o600 })
  // Inline code does not change machine or user execution policies. Installer
  // trust, elevation prompts, and application control still belong to Windows.
  const env = Object.fromEntries(Object.entries(powershellEnv()).filter(([key]) => key.toLowerCase() !== 'electron_run_as_node'))
  // Windows PowerShell can silently exit without executing its command when
  // Node spawns it with detached:true. Let Windows create an independent
  // hidden process instead; its console and lifetime do not belong to Node.
  const { stdout } = await promisify(execFile)(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList ('-NoProfile -NonInteractive -EncodedCommand ' + $env:WORKBENCH_UPDATE_SCRIPT) -PassThru; $child.Id"],
  { windowsHide: true, timeout: 20000, env: { ...env, WORKBENCH_UPDATE_CONFIG: configFile, WORKBENCH_UPDATE_SCRIPT: Buffer.from(WINDOWS_INSTALL_SCRIPT, 'utf16le').toString('base64') } })
  const helperPid = Number(stdout.trim())
  if (!Number.isSafeInteger(helperPid) || helperPid <= 0) throw new Error('The Windows update helper could not start. Try installing again.')
  const deadline = Date.now() + 60000
  try {
    while (Date.now() < deadline) {
      const failure = await fs.readFile(errorLog, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return '' })
      if (failure.trim()) throw new Error(failure.trim().replace(/^\uFEFF/, ''))
      try { process.kill(helperPid, 0) } catch { throw new Error('The Windows update helper could not start. Try installing again.') }
      const status = await fs.readFile(ready, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return '' })
      // The file may still be in the middle of its first write.
      if (status) {
        let value: { token?: string; pid?: number } | null = null
        try { value = JSON.parse(status.replace(/^\uFEFF/, '')) } catch { /* wait for the completed write */ }
        if (value?.token === token && value.pid === helperPid) {
          await fs.writeFile(acknowledged, JSON.stringify({ token }), { mode: 0o600 })
          return
        }
      }
      await delay(75)
    }
    throw new Error('The Windows update helper took too long to start. Workbench is still open; try again.')
  } catch (error) {
    // Only our own helper is stopped. Never terminate the app, installers, or
    // an agent connection to make an update proceed.
    try { process.kill(helperPid) } catch { /* the helper has already exited */ }
    throw error
  }
}

export const WINDOWS_INSTALL_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$cfg = $null
$parentClosed = $false
$errorLog = Join-Path (Split-Path -Parent $env:WORKBENCH_UPDATE_CONFIG) 'install-error.log'
function Write-InstallError([string]$message) {
  [IO.File]::AppendAllText($errorLog, ($message + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
}
function Assert-InstallerTrust {
  if ((Get-FileHash -LiteralPath $cfg.installer -Algorithm SHA512).Hash.ToLowerInvariant() -ne $cfg.sha512) { throw 'Installer checksum changed. Download the update again.' }
  $current = Get-AuthenticodeSignature -LiteralPath $cfg.executable
  $next = Get-AuthenticodeSignature -LiteralPath $cfg.installer
  if ($null -eq $cfg.signer) {
    if ($current.Status -ne 'NotSigned' -or $next.Status -ne 'NotSigned' -or $null -ne $current.SignerCertificate -or $null -ne $next.SignerCertificate) { throw 'The unsigned Beta installer does not match this Workbench installation.' }
  } elseif ($current.Status -ne 'Valid' -or $next.Status -ne 'Valid' -or $current.SignerCertificate.Thumbprint -ne $cfg.signer -or $next.SignerCertificate.Thumbprint -ne $cfg.signer) {
    throw 'The installer publisher does not match this Workbench installation.'
  }
}
function Get-InstallProcesses {
  # electron-builder's NSIS process check uses this same directory prefix.
  # Protect embedded bridges too, even when their executable has another name.
  @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDirectory, [StringComparison]::OrdinalIgnoreCase) })
}
try {
  $cfg = Get-Content -LiteralPath $env:WORKBENCH_UPDATE_CONFIG -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.pid -le 0 -or $cfg.sha512 -cnotmatch '^[a-f0-9]{128}$' -or $cfg.token -notmatch '^[a-f0-9-]{36}$' -or ($null -ne $cfg.signer -and $cfg.signer -notmatch '^[A-Fa-f0-9]{40,64}$')) { throw 'Invalid Windows update handoff.' }
  foreach ($file in @($cfg.installer, $cfg.executable)) {
    $item = Get-Item -LiteralPath $file
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The Windows update files are not regular files.' }
  }
  $installDirectory = Split-Path -Parent $cfg.executable
  if ([string]::IsNullOrWhiteSpace($installDirectory) -or $installDirectory -match '["\r\n]') { throw 'Invalid Windows install directory.' }
  $parent = Get-Process -Id $cfg.pid
  if ($parent.MainModule.FileName -ne $cfg.executable) { throw 'The Workbench process changed. Check for updates again.' }
  $null = $parent.Handle
  $connections = @(Get-InstallProcesses | Where-Object { $_.ProcessId -ne $cfg.pid -and $_.CommandLine -notmatch '--type=' })
  if ($connections.Count -gt 0) { throw 'Active agent connections are using Workbench. Finish those agent sessions before installing the update.' }
  Assert-InstallerTrust
  $ready = Join-Path $cfg.directory 'install-ready.json'
  [IO.File]::WriteAllText($ready, (@{token=$cfg.token; pid=$PID} | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  # A timed-out bootstrap must not leave an orphan that installs when the user
  # later closes Workbench. Require acknowledgement from the live caller.
  $acknowledged = Join-Path $cfg.directory 'install-acknowledged.json'
  $ackDeadline = [DateTime]::UtcNow.AddSeconds(60)
  $accepted = $false
  do {
    if (Test-Path -LiteralPath $acknowledged) {
      try { $accepted = ((Get-Content -LiteralPath $acknowledged -Raw -Encoding UTF8 | ConvertFrom-Json).token -eq $cfg.token) } catch { $accepted = $false }
    }
    if (!$accepted) { Start-Sleep -Milliseconds 75 }
  } while (!$accepted -and [DateTime]::UtcNow -lt $ackDeadline)
  if (!$accepted) { throw 'The Windows update handoff was not confirmed. Try installing again.' }
  if (!$parent.WaitForExit(120000)) { throw 'Workbench did not finish closing. Update postponed.' }
  $parentClosed = $true
  # Any newly started bridge blocks the installer. Give normal Electron child
  # processes time to exit, then refuse even those instead of letting NSIS kill.
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $remaining = @(Get-InstallProcesses)
    if (@($remaining | Where-Object { $_.CommandLine -notmatch '--type=' }).Count -gt 0) { throw 'Agent connections are still using Workbench. Finish those sessions before updating.' }
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($remaining.Count -gt 0) { throw 'Workbench processes are still closing. Try the update again.' }
  Assert-InstallerTrust
  # /D must be last and unquoted, including paths containing spaces (NSIS).
  # --updated preserves existing shortcuts; the helper owns the one relaunch.
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $cfg.installer
  $start.Arguments = '/S --updated /D=' + $installDirectory
  $start.UseShellExecute = $true
  if (@(Get-InstallProcesses).Count -gt 0) { throw 'Workbench processes are still using the installation. Try the update again after they finish.' }
  $installer = [Diagnostics.Process]::Start($start)
  $installer.WaitForExit()
  if ($installer.ExitCode -ne 0) { throw "Installer exited with code $($installer.ExitCode). Try the update again." }
} catch {
  Write-InstallError $_.Exception.Message
} finally {
  if ($parentClosed) {
    try {
      if (!(Test-Path -LiteralPath $cfg.executable -PathType Leaf)) { throw 'Workbench could not relaunch because its executable is missing. Run the downloaded installer to repair it.' }
      $null = Start-Process -FilePath $cfg.executable -WorkingDirectory (Split-Path -Parent $cfg.executable) -PassThru
    } catch { Write-InstallError ('Workbench could not relaunch: ' + $_.Exception.Message) }
  }
}
`
