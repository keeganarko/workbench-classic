/**
 * The scripts a project already knows how to run.
 *
 * `package.json` is the closest thing a repository has to a list of verbs, and
 * an agent that has just finished editing a project is one command away from
 * showing you the result. Reading that list is the whole of this file — nothing
 * here runs anything; the caller starts an ordinary shell session, which is
 * what makes the output visible and interruptible like any other session.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ProjectScript } from '../shared/types.js'

/** A `package.json` larger than this is not one we need to read. */
const MAX_BYTES = 1_000_000
const MAX_SCRIPTS = 40
const MAX_LEN = 400

/**
 * The ones worth offering first.
 *
 * Alphabetical order buries `dev` under `build:analyze`, and the script you
 * want after an agent has edited a web project is nearly always one of these.
 */
const FIRST = ['dev', 'start', 'serve', 'preview', 'storybook']

export function readScripts(cwd: string): ProjectScript[] {
  const file = path.join(cwd, 'package.json')
  let raw: string
  try {
    if (fs.statSync(file).size > MAX_BYTES) return []
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return [] // no package.json here, or not readable — not an error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [] // a package.json mid-edit is a normal thing to walk into
  }

  const scripts =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { scripts?: unknown }).scripts
      : undefined
  if (typeof scripts !== 'object' || scripts === null) return []

  const out: ProjectScript[] = []
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== 'string') continue
    if (name.length > MAX_LEN) continue
    out.push({ name, command: command.slice(0, MAX_LEN) })
  }

  out.sort((a, b) => {
    const ra = FIRST.indexOf(a.name)
    const rb = FIRST.indexOf(b.name)
    if (ra !== rb) return (ra < 0 ? FIRST.length : ra) - (rb < 0 ? FIRST.length : rb)
    return a.name.localeCompare(b.name)
  })
  return out.slice(0, MAX_SCRIPTS)
}
