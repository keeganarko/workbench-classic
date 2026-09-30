/**
 * The two impure halves of the usage meter: where Claude's token lives, and
 * the request that spends it.
 *
 * Split out of `usage.ts` so that module stays free of the keychain and the
 * network and can be tested as plain functions. Nothing here is worth a unit
 * test — it is all platform plumbing — so it is kept small and boring.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { hostHome, hostHomeNative, hostSpawn, hostSpawnEnv } from './host.js'
import { findExecutable, resolveLoginPath } from './agents.js'
import { queryCodexQuota } from './codexUsageSource.js'
import type { UsageMonitorDeps } from './usage.js'

/** The keychain item Claude Code stores its OAuth credentials under on macOS. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** Claude Code's OAuth flow marks itself with this beta header. */
const OAUTH_BETA = 'oauth-2025-04-20'

/** A usage lookup must never hold up anything; the meter can simply stay blank. */
const REQUEST_TIMEOUT_MS = 8000

function tokenFromCredentials(raw: string): string | null {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return null
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth
  if (typeof oauth !== 'object' || oauth === null) return null
  const token = (oauth as Record<string, unknown>).accessToken
  return typeof token === 'string' && token !== '' ? token : null
}

/** Reads the macOS keychain item, or null when there is no such item. */
function fromKeychain(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: REQUEST_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(null)
        try {
          resolve(tokenFromCredentials(stdout))
        } catch {
          resolve(null)
        }
      }
    )
  })
}

/**
 * Claude Code keeps credentials in the macOS keychain, and in a plain file
 * everywhere else. Both are tried, in that order, so the meter also works
 * under the Linux/WSLg build.
 *
 * The default home is the *host's*, not this process's. On Windows those are
 * different directories: the token was written by the Claude that ran inside
 * the distro, so it sits in the distro's `~/.claude`, and `C:\Users\<name>`
 * would never have a `.credentials.json` to find. `hostHomeNative` gives the
 * UNC spelling, which is the one `readFileSync` can actually open. The
 * keychain branch stays darwin-only — `/usr/bin/security` is not a thing
 * anywhere else, and Windows' own credential store is not where Claude Code
 * puts this.
 */
export async function readClaudeToken(home: string = hostHomeNative()): Promise<string | null> {
  if (process.platform === 'darwin') {
    const fromRing = await fromKeychain()
    if (fromRing) return fromRing
  }
  try {
    return tokenFromCredentials(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * One GET against the usage endpoint.
 *
 * A non-2xx is turned into a short message rather than a body dump: it lands
 * in a status-bar tooltip, and an HTML error page would fill it with noise.
 */
export async function fetchUsageJson(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': OAUTH_BETA,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!res.ok) {
    if (res.status === 429) {
      const retry = res.headers.get('retry-after')
      const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 300_000
      throw Object.assign(new Error('Claude usage checks are temporarily rate-limited. Retrying shortly.'), {
        retryAfterMs: Math.max(300_000, Math.min(3600_000, Number.isFinite(delay) ? delay : 300_000))
      })
    }
    throw new Error(res.status === 401 ? 'Claude sign-in expired' : `Usage lookup failed (${res.status})`)
  }
  return res.json()
}

let codexCommand: { binary: string; searchPath: string } | null = null
export function readLiveCodexQuota(): Promise<unknown> {
  return queryCodexQuota(() => {
    if (!codexCommand) {
      const searchPath = resolveLoginPath()
      const binary = findExecutable('codex', searchPath)
      if (!binary) throw new Error('Codex is not installed')
      codexCommand = { binary, searchPath }
    }
    const env = { PATH: codexCommand.searchPath }
    const command = hostSpawn([codexCommand.binary, 'app-server'], { cwd: hostHome(), env })
    return spawn(command.file, command.args, {
      cwd: command.cwd, env: hostSpawnEnv({ ...process.env, ...env }),
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    })
  })
}

export const usageDeps: UsageMonitorDeps = {
  // Agents live inside WSL on Windows. Resolve lazily, after host startup, and
  // use the same home for both providers so Codex does not look in C:\\Users.
  get home() { return hostHomeNative() },
  claudeToken: () => readClaudeToken(),
  fetchJson: fetchUsageJson,
  codexQuota: readLiveCodexQuota
}
