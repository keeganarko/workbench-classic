#!/usr/bin/env node
/**
 * Points the packaged app at this repository instead of a frozen copy of it.
 *
 * The packaged bundle carries `Resources/app.asar` — a snapshot of `out/` taken
 * when `npm run package` last ran. That snapshot is the whole problem: you keep
 * the .app in the Dock because it has the right identity and icon, then edit the
 * repo for an afternoon and wonder why nothing changed. Reopening does not help;
 * the code the app runs is the code that was packed into it.
 *
 * Electron resolves `Resources/app.asar` *before* `Resources/app`, so shadowing
 * the archive with a directory does nothing — the archive has to be moved out of
 * the way. This script does exactly that: `app.asar` is set aside as
 * `app.asar.packaged`, and `Resources/app` becomes a symlink to the repository
 * root. The bundle's `package.json` is then this repo's, `main` resolves to
 * `out/main/index.js`, and `node_modules` resolves next to it — including the
 * node-pty that `postinstall` already rebuilt for this Electron.
 *
 * After this, `npm run build` (under a second) is the whole update step.
 *
 * `--undo` puts the archive back, which is what you want before shipping a real
 * bundle. `npm run package` also restores one by rebuilding it from scratch.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const undo = process.argv.includes('--undo')

/** Every packaged bundle under `release/`, whatever platform built it. */
function bundles() {
  const releaseDir = path.join(repo, 'release')
  if (!fs.existsSync(releaseDir)) return []
  const found = []
  for (const entry of fs.readdirSync(releaseDir)) {
    // macOS: release/mac-arm64/Workbench.app/Contents/Resources
    const mac = path.join(releaseDir, entry, 'Workbench.app', 'Contents', 'Resources')
    if (fs.existsSync(mac)) found.push({ resources: mac, label: `${entry}/Workbench.app` })
    // Linux: release/linux-unpacked/resources
    const linux = path.join(releaseDir, entry, 'resources')
    if (fs.existsSync(path.join(linux, 'app.asar')) || isLink(path.join(linux, 'app'))) {
      found.push({ resources: linux, label: entry })
    }
  }
  return found
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function link({ resources, label }) {
  const asar = path.join(resources, 'app.asar')
  const stashed = path.join(resources, 'app.asar.packaged')
  const appDir = path.join(resources, 'app')

  if (fs.existsSync(appDir) && !isLink(appDir)) {
    // A real directory here is something we did not put there; replacing it
    // would throw away whoever's build it is.
    console.error(`✗ ${label}: Resources/app is a real directory, not a link — leaving it alone`)
    return false
  }

  if (fs.existsSync(asar)) fs.renameSync(asar, stashed)
  if (isLink(appDir)) fs.unlinkSync(appDir)
  fs.symlinkSync(repo, appDir)
  console.log(`✓ ${label} → ${repo}`)
  return true
}

function unlink({ resources, label }) {
  const asar = path.join(resources, 'app.asar')
  const stashed = path.join(resources, 'app.asar.packaged')
  const appDir = path.join(resources, 'app')

  if (isLink(appDir)) fs.unlinkSync(appDir)
  if (!fs.existsSync(asar) && fs.existsSync(stashed)) fs.renameSync(stashed, asar)
  if (!fs.existsSync(asar)) {
    console.error(`✗ ${label}: no app.asar to restore — run \`npm run package\``)
    return false
  }
  console.log(`✓ ${label} restored to its packaged code`)
  return true
}

const found = bundles()
if (found.length === 0) {
  console.error('No packaged bundle under release/. Run `npm run package` first.')
  process.exit(1)
}

let ok = true
for (const bundle of found) ok = (undo ? unlink(bundle) : link(bundle)) && ok

if (ok && !undo) {
  console.log('\nQuit and reopen Workbench to pick this up.')
  console.log('From now on `npm run build` is the whole update step.')
}
process.exit(ok ? 0 : 1)
