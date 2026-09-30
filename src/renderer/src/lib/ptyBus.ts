/**
 * Fan-out for `pty:data`. One IPC listener in App feeds every terminal view
 * that happens to be showing that session.
 */

type Handler = (data: string) => void

const handlers = new Map<string, Set<Handler>>()

export function subscribePty(sessionId: string, fn: Handler): () => void {
  let set = handlers.get(sessionId)
  if (!set) {
    set = new Set()
    handlers.set(sessionId, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) handlers.delete(sessionId)
  }
}

export function dispatchPty(sessionId: string, data: string): void {
  const set = handlers.get(sessionId)
  if (!set) return
  for (const fn of set) fn(data)
}
