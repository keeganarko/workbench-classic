#!/usr/bin/env node
/**
 * `electron-vite dev --watch`, but wearing the real app's identity.
 *
 * Dev mode normally launches `node_modules/electron/dist/Electron.app`, whose
 * bundle id is `com.github.Electron`. macOS keys Dock tiles to the bundle, not
 * to the process name, so `app.setName('Workbench')` and `app.dock.setIcon()`
 * cannot help: you get a second tile called Electron next to the Workbench one
 * you pinned, and the pinned one stays dark.
 *
 * electron-vite honours `ELECTRON_EXEC_PATH`, so pointing it at the packaged
 * bundle's binary fixes that. The app still runs from `out/` in this repo —
 * only the executable, and with it the bundle identity, icon and Dock tile,
 * comes from the build. Live reload is unaffected.
 *
 * The packaged bundle is optional. Without one (a fresh clone, or Linux), this
 * falls through to the bundled Electron and dev mode behaves exactly as before.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/**
 * The packaged binary, if one has been built for this platform and is still
 * the same Electron the repo compiles against.
 *
 * The version check is the part that matters: node-pty is a native module
 * loaded out of this repo's `node_modules`, and running it against a different
 * Electron ABI fails at import with an error that says nothing useful.
 */
function packagedBinary() {
  const candidates = [
    ['darwin', 'release/mac-arm64/Workbench.app/Contents/MacOS/Workbench'],
    ['darwin', 'release/mac/Workbench.app/Contents/MacOS/Workbench']
  ]
  for (const [platform, rel] of candidates) {
    if (process.platform !== platform) continue
    const bin = path.join(root, rel)
    if (!fs.existsSync(bin)) continue
    const framework = path.join(
      bin,
      '../../Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist'
    )
    let built = null
    try {
      built = /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(
        fs.readFileSync(path.resolve(framework), 'utf8')
      )?.[1]
    } catch {
      continue
    }
    if (built && built === require('electron/package.json').version) return bin
  }
  return null
}

const bin = packagedBinary()
const env = { ...process.env }
if (bin) {
  env.ELECTRON_EXEC_PATH = bin
  console.log(`[dev-app] running as the packaged bundle: ${path.relative(root, bin)}`)
} else {
  console.log('[dev-app] no matching packaged build; using the bundled Electron')
}

// Addressed by path rather than by `require.resolve`: electron-vite's `exports`
// map does not publish its own CLI entry, so resolving it by specifier throws.
const cli = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
if (!fs.existsSync(cli)) {
  console.error(`[dev-app] electron-vite is not installed at ${cli}`)
  process.exit(1)
}

const child = spawn(process.execPath, [cli, 'dev', '--watch', ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit'
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
