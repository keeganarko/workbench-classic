/**
 * A ten-line loader so `node --test` can run the TypeScript sources directly.
 *
 * Node 22.6+ strips TypeScript types on its own, so no transpiler is needed —
 * but the source uses ESM-correct `./foo.js` specifiers that point at files
 * which only exist as `./foo.ts` until a build runs. This maps one to the
 * other.
 *
 * It deliberately does NOT set `format`. Returning `format: 'module'` makes
 * Node treat the file as plain JavaScript and the type annotations become
 * syntax errors; leaving it unset lets Node detect `.ts` and strip types.
 *
 * It also points `electron` at a stub. The real package's main export is a path
 * string outside Electron, so `Notification` would be `undefined` and every
 * notification test would fail on the wrong thing. The stub is only ever loaded
 * by this file, which the app itself never imports.
 *
 * The alternative was adding vitest or tsx as a dependency. This is a test
 * harness for an app whose whole job is running other people's agents with
 * filesystem access — every dependency it does not have is one fewer thing to
 * audit.
 */

import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ELECTRON_STUB = new URL('./stubs/electron.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      // Renderer modules use Vite's extensionless imports. Resolve those too,
      // so navigation tests exercise the actual Zustand store without a DOM.
      const base = specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier
      const asTs = new URL(base + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(asTs))) return { url: asTs.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})
