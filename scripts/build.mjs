#!/usr/bin/env node
/**
 * Large build intermediates belong on disk. WSL can mount /tmp as tmpfs, so a
 * packager's temporary Electron copy otherwise occupies guest RAM after the
 * build ends. Keep the existing output directories and tool arguments; scope
 * only temporary storage to a unique directory on the user's normal disk.
 *
 * The runner also accepts `-- command ...args` for one-off verification jobs.
 * Commands are argv arrays, never shell text. Use `--node entry.js ...args`
 * for Node CLIs on Windows rather than relying on a .cmd shim.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function withBuildTemp(commands, { env = process.env, baseDir = path.join(os.homedir(), '.cache', 'workbench', 'builds'), cwd = process.cwd() } = {}) {
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 })
  const directory = await fs.mkdtemp(path.join(baseDir, 'scratch-'))
  const childEnv = { ...env, TMPDIR: directory, TMP: directory, TEMP: directory, WORKBENCH_BUILD_TEMP: directory }
  console.log(`[build] temporary files: ${directory}`)
  try {
    for (const [command, ...args] of commands) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env: childEnv, stdio: 'inherit', shell: false })
        // Forward terminal interrupts without exiting early and abandoning the
        // child. In particular, an interrupted package must never start the
        // next packaging command or report a successful build.
        let interrupted = 0
        const interrupt = () => { interrupted = 130; if (!child.killed) child.kill('SIGINT') }
        const terminate = () => { interrupted = 143; if (!child.killed) child.kill('SIGTERM') }
        process.on('SIGINT', interrupt)
        process.on('SIGTERM', terminate)
        const detach = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
        child.once('error', error => { detach(); reject(error) })
        // Some tools handle an interrupt by cleaning up and exiting zero. The
        // user's cancellation still owns the pipeline; zero must not launch the
        // next packaging step after that deliberate stop.
        child.once('close', (code, signal) => { detach(); resolve(interrupted || (signal ? (signal === 'SIGINT' ? 130 : 143) : (code ?? 1))) })
      })
      if (result !== 0) return { code: result, directory }
    }
    return { code: 0, directory }
  } finally {
    // Only remove an empty scratch directory. A failure may leave diagnostic
    // artifacts, and a command may have deliberately started a server which
    // still uses its files. Nonempty trees stay on disk for explicit cleanup.
    await fs.rmdir(directory).catch(() => {})
  }
}

export function buildCommands(args) {
  const [mode, ...rest] = args
  if (mode === '--' && rest.length) return [rest]
  if (mode === '--node' && rest.length) return [[process.execPath, ...rest]]
  const compile = [process.execPath, path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build']
  if (mode === 'build') return [[...compile, ...rest]]
  if (mode === 'package') return [compile, [process.execPath, path.join(root, 'node_modules/electron-builder/cli.js'), ...rest]]
  throw new Error('Expected build, package, -- command ...args, or --node entry.js ...args')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await withBuildTemp(buildCommands(process.argv.slice(2)))
    process.exitCode = result.code
  } catch (error) {
    console.error(`[build] ${error.message}`)
    process.exitCode = 1
  }
}
