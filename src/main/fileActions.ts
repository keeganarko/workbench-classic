import fs from 'node:fs/promises'

/** Electron reports an OS open failure as a resolved error string. Turning it
 * into an exception here lets the normal IPC envelope show a useful message
 * instead of making an Open button appear to have done nothing. */
export async function openWithSystem(file: string, openPath: (file: string) => Promise<string>): Promise<string> {
  const error = await openPath(file)
  if (error) throw new Error(error)
  return file
}

/** A copy is the complete original file, never the preview's potentially
 * truncated text or rendered HTML. Only the native save dialog can select the
 * destination. Check the source again after that dialog: it can stay open
 * while an agent deletes a file or replaces it with a symlink. */
export async function savePreviewCopy(
  rawPath: string,
  assertReadable: (file: string) => string,
  chooseDestination: (source: string) => Promise<string | null>
): Promise<string | null> {
  const source = assertReadable(rawPath)
  const destination = await chooseDestination(source)
  if (!destination) return null
  const current = assertReadable(rawPath)
  if (current !== source) throw new Error('The original file moved while saving. Open it again and retry.')

  // Choosing the original, including an alias or hard link to it, is a no-op.
  // In particular, never truncate the source in an attempt to copy onto itself.
  const original = await fs.stat(source)
  const target = await fs.stat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (target && original.dev === target.dev && original.ino === target.ino) return destination
  await fs.copyFile(source, destination)
  return destination
}
