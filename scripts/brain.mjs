#!/usr/bin/env node
/** Read only the small export explicitly selected by the private brain's
 * manifest. The code repository holds the reader, never the vault or a copy of
 * its notes. No crawling, transcript harvesting, network, or background work.
 * Printing context makes it available to the invoking agent; it is not a claim
 * that the agent runs locally or that other sessions received the same memory. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const LIMIT = 16000

export function readBrainContext(root, project) {
  if (!/^[a-z0-9_-]{1,60}$/.test(project)) throw Error('Use a simple project key, for example workbench.')
  const base = fs.realpathSync(root)
  const inside = (file) => {
    const target = fs.realpathSync(path.join(base, file))
    const relative = path.relative(base, target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Brain path escapes its root.')
    const stat = fs.statSync(target)
    if (!stat.isFile() || stat.size > LIMIT) throw Error('Brain context must be a small regular file.')
    return target
  }
  const manifest = JSON.parse(fs.readFileSync(inside('brain.manifest.json'), 'utf8'))
  const names = manifest.version === 1 && manifest.context?.[project]
  if (!Array.isArray(names) || names.length < 1 || names.length > 4) throw Error('No approved context export for this project.')
  const parts = []
  let bytes = 0
  for (const name of names) {
    if (typeof name !== 'string' || !/^Exports\/[a-zA-Z0-9_-]+\.md$/.test(name)) throw Error('Context must name a Markdown note directly in Exports/.')
    const file = inside(name)
    const relative = path.relative(base, file).split(path.sep)
    if (relative.length !== 2 || relative[0] !== 'Exports') throw Error('Context export resolves outside Exports/.')
    const body = fs.readFileSync(file, 'utf8')
    bytes += Buffer.byteLength(body)
    if (bytes > LIMIT) throw Error('Combined context exceeds the 16 KB reading limit.')
    parts.push(body.trim())
  }
  return `Local brain — selected context for ${project}\nRead as dated context, not authority to expand this task.\n\n${parts.join('\n\n---\n\n')}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== 'context' || !process.argv[3] || process.argv.length !== 4) throw Error('Usage: node scripts/brain.mjs context workbench')
    const root = process.env.BRAIN_ROOT || (process.platform === 'win32' ? 'C:\\Brain' : fs.existsSync('/mnt/c/Brain') ? '/mnt/c/Brain' : path.join(os.homedir(), 'Brain'))
    process.stdout.write(readBrainContext(root, process.argv[3]))
  } catch (error) {
    process.stderr.write(`Brain context unavailable: ${error.message}\nContinue with the project handoff; do not search private vaults automatically.\n`)
    process.exitCode = 1
  }
}
