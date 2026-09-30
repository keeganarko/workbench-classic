/**
 * Codex's account API can refresh limits without spending tokens or starting a
 * conversation. Use its supported stdio protocol so the CLI owns authentication
 * and token refresh; Workbench never reads or forwards an OpenAI access token.
 * This connection makes only initialize and account/rateLimits/read requests.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export function queryCodexQuota(spawnProcess: () => ChildProcessWithoutNullStreams, timeoutMs = 8000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try { child = spawnProcess() } catch { reject(new Error('Could not start the Codex usage check')); return }
    let buffer = ''
    let initialized = false
    let settled = false
    const timer = setTimeout(() => finish(new Error('Codex usage check timed out')), timeoutMs)
    const finish = (error: Error | null, result?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Closing stdin lets the CLI shut down normally, including inside WSL.
      // A bounded fallback cleans up a hung helper; existing agents are separate
      // processes and are never signaled by this account-only connection.
      child.stdin.end()
      const cleanup = setTimeout(() => child.kill(), 1000)
      cleanup.unref?.()
      child.once('close', () => clearTimeout(cleanup))
      if (error) reject(error)
      else resolve(result)
    }
    const send = (message: unknown): void => { child.stdin.write(JSON.stringify(message) + '\n') }
    child.once('error', () => finish(new Error('Could not start the Codex usage check')))
    child.stdin.on('error', () => finish(new Error('Codex usage connection closed')))
    child.once('close', () => finish(new Error('Codex closed before reporting usage')))
    // Diagnostic output can contain account details. Drain it without logging or
    // forwarding it; the UI needs a short failure reason, not the CLI's stderr.
    child.stderr.resume()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      buffer += chunk
      if (buffer.length > 1024 * 1024) { finish(new Error('Codex usage response was too large')); return }
      for (let end; (end = buffer.indexOf('\n')) !== -1;) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message: { id?: unknown; error?: unknown; result?: unknown; method?: unknown }
        try { message = JSON.parse(line) } catch { continue }
        if (!message || typeof message !== 'object') continue
        if (typeof message.method === 'string') {
          // Server request ids have their own namespace and may equal our ids.
          // Handle requests before responses so an auth request cannot pretend
          // that initialization or a quota read has succeeded.
          if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Account usage reader only' } })
          continue
        }
        if (message.id === 1 && !initialized) {
          if (message.error) { finish(new Error('This Codex version could not initialize a usage check')); return }
          initialized = true
          send({ method: 'initialized', params: {} })
          send({ id: 2, method: 'account/rateLimits/read' })
        } else if (message.id === 2 && initialized) {
          if (message.error) finish(new Error('Live Codex limits unavailable; check Codex sign-in'))
          else finish(null, message.result)
          return
        }
      }
    })
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'workbench_usage', title: 'Workbench Usage', version: '1.0.1' },
      capabilities: { experimentalApi: false }
    } })
  })
}
