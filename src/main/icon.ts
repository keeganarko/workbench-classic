/**
 * Menu-bar template images use the same captured website outline as the app
 * icon. The build-time generator renders both native menu-bar sizes so the
 * system can tint their alpha in light/dark mode without scaling a dock tile.
 * Keeping these alongside the packaged app assets also avoids relying on a
 * machine's installed fonts to draw the command symbol.
 */
import fs from 'node:fs'
import path from 'node:path'

export function trayIconPng(resources: string, scale = 1): Buffer {
  return fs.readFileSync(path.join(resources, `tray-${scale === 2 ? 32 : 16}.png`))
}
