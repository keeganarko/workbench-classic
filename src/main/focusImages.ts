import fs from 'node:fs'
import path from 'node:path'
import { isInsideRoot } from './preview.js'
import { toNativePath } from './host.js'

export const MAX_FOCUS_IMAGE_BYTES = 4 * 1024 * 1024

/** A report owns its picture. Copy it once so rewriting the source for the next
 * milestone cannot silently rewrite the previous milestone's visual history.
 * The caller supplies the authenticated session's folder, never a model-selected
 * root. Render these as images, including SVG; never as executable HTML frames. */
export function snapshotFocusImage(directory: string, id: string, cwd: string, requested: string): string {
  const root = fs.realpathSync.native(toNativePath(cwd))
  const file = fs.realpathSync.native(path.resolve(root, toNativePath(requested)))
  if (!isInsideRoot(root, file)) throw new Error('Focus images must be inside the reporting session’s folder')
  const ext = path.extname(file).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(ext)) throw new Error('Unsupported Focus image type')
  // A named pipe can have an image extension. Opening it synchronously before
  // checking its type can freeze the entire desktop waiting for a writer. The
  // descriptor check below still protects a replaced file; nonblocking open on
  // POSIX closes the race where a regular file is swapped for a pipe after stat.
  if (!fs.statSync(file).isFile()) throw new Error('Focus images must be regular files')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK))
  let bytes: Buffer
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FOCUS_IMAGE_BYTES) throw new Error('Focus images must be files up to 4 MB')
    bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error('The Focus image changed while it was being read')
      offset += count
    }
  } finally { fs.closeSync(fd) }
  const valid = ext === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : ext === '.jpg' || ext === '.jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : ext === '.webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    : /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(bytes.toString('utf8'))
  if (!valid) throw new Error('The Focus image content does not match its file type')
  const folder = path.join(directory, 'focus-images')
  fs.mkdirSync(folder, { recursive: true })
  const saved = path.join(folder, id + ext)
  fs.writeFileSync(saved, bytes, { flag: 'wx', mode: 0o600 })
  return saved
}

/** Only cache files minted by us are eligible. Project originals and any other
 * file in the folder stay untouched; retention follows the existing report cap. */
export function pruneFocusImages(directory: string, retained: Set<string>): void {
  const folder = path.join(directory, 'focus-images')
  try {
    for (const name of fs.readdirSync(folder)) {
      if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.(?:png|jpe?g|webp|svg)$/i.test(name)) continue
      const file = path.join(folder, name)
      if (!retained.has(file)) fs.rmSync(file, { force: true })
    }
  } catch { /* A cache cleanup failure must not undo a saved progress report. */ }
}
