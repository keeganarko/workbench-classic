/**
 * Minimal stand-in for the parts of `electron` the main process touches.
 *
 * Outside an Electron runtime the real package's main export is a *path string*,
 * so `Notification` would be `undefined` and every notification assertion would
 * fail on the wrong thing. `test/ts-resolve.mjs` points the `electron` specifier
 * here; nothing the app ships ever imports this file.
 */

/** Every Notification constructed since the last reset, in order. */
export const created = []

let supported = true

export function setSupported(value) {
  supported = value
}

export function reset() {
  created.length = 0
  supported = true
}

export class Notification {
  static isSupported() {
    return supported
  }

  constructor(options) {
    this.options = options ?? {}
    this.shownCount = 0
    this.closedCount = 0
    this.handlers = new Map()
    created.push(this)
  }

  on(event, cb) {
    this.handlers.set(event, cb)
    return this
  }

  show() {
    this.shownCount++
  }

  close() {
    this.closedCount++
    this.handlers.get('close')?.()
  }

  /** Test-only: simulate the user clicking the banner. */
  fire(event) {
    this.handlers.get(event)?.()
  }
}
