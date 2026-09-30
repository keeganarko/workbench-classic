#!/usr/bin/env node
/**
 * Two jobs npm cannot express as one command line: fetch Electron's binary,
 * then make node-pty loadable by it.
 *
 * This was `node node_modules/electron/install.js && electron-rebuild -f -w
 * node-pty` in package.json. It grew a branch because the rebuild half is
 * wrong on Windows — not merely unnecessary, but a hard install failure.
 *
 * node-pty 1.1 is built on node-addon-api, so its binary is Node-API and its
 * ABI is stable across every Node and Electron that speaks the same Node-API
 * version. The npm tarball ships prebuilt binaries for darwin-arm64,
 * darwin-x64, win32-x64 and win32-arm64 — everything except Linux, which is
 * why the rebuild still has to happen here at all.
 *
 * On Windows a source build means node-gyp, which means Visual Studio Build
 * Tools and a Python: several gigabytes of toolchain to reproduce a file that
 * is already sitting in `node_modules/node-pty/prebuilds/win32-x64`. So the
 * rebuild is skipped there and the prebuild is used, which is also why
 * `npmRebuild` is off in the electron-builder config — otherwise packaging
 * would run the same doomed rebuild a second time.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withBuildTemp } from './build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const commands = [[process.execPath, path.join(root, 'node_modules', 'electron', 'install.js')]]

if (process.platform === 'win32') {
  console.log('> node-pty: using the shipped win32 prebuild; skipping electron-rebuild')
} else {
  // The CLI is a JS file with a shebang; naming it through node avoids both the
  // `.cmd` shim and any question of whether node_modules/.bin is on PATH.
  commands.push([process.execPath,
    path.join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js'),
    '-f',
    '-w',
    'node-pty'
  ])
}

// Electron's initial download/extraction can be the largest temporary job on
// a fresh checkout. Apply the same disk staging as packaging, without changing
// which native dependencies are installed or how rebuild failures are reported.
const result = await withBuildTemp(commands, { cwd: root })
process.exitCode = result.code
