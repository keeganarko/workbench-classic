import fs from 'node:fs'
import { toNativePath } from './host.js'
import { purposeFromPrompt, taskText } from '../shared/sessionTitle.js'

/** Read only the conversation already bound to this session. Head and tail
 * windows keep a long-running agent's multi-megabyte transcript from blocking
 * startup, while recovering both its original role and most recent task. Tool
 * output and private reasoning never become a user's session description. */
export function readSessionNaming(file: string): { firstPrompt: string | null; lastPrompt: string | null; lastReply: string | null } {
  const result = { firstPrompt: null, lastPrompt: null, lastReply: null } as {
    firstPrompt: string | null; lastPrompt: string | null; lastReply: string | null
  }
  let fd: number | undefined
  try {
    // Hooks report a Linux path even when the UI runs natively on Windows.
    // Translate only at the filesystem boundary, preserving the agent's path.
    fd = fs.openSync(toNativePath(file), 'r')
    const size = fs.fstatSync(fd).size, window = 128 * 1024
    const ranges = size <= window * 2 ? [[0, size]] : [[0, window], [size - window, window]]
    for (const [start, count] of ranges) {
      const bytes = Buffer.alloc(count)
      const read = fs.readSync(fd, bytes, 0, count, start)
      const lines = bytes.subarray(0, read).toString('utf8').split('\n')
      if (start > 0) lines.shift()
      for (const line of lines) {
        let row
        try { row = JSON.parse(line) } catch { continue }
        if (!row || typeof row !== 'object' || row.isMeta) continue
        const message = row.message ?? (row.payload?.type === 'message' ? row.payload : null)
        let role = message?.role ?? row.type
        if (message?.channel === 'analysis' || row.channel === 'analysis') continue
        let content = message?.content
        if (row.type === 'event_msg' && row.payload?.type === 'user_message') {
          role = 'user'; content = row.payload.message
        }
        if (role !== 'user' && role !== 'assistant') continue
        const text = typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter((block) => block && ['text', 'input_text', 'output_text'].includes(block.type))
            .map((block) => typeof block.text === 'string' ? block.text : '').join('\n') : ''
        if (!purposeFromPrompt(text)) continue
        const clean = taskText(text).slice(0, 12000)
        if (role === 'user') {
          result.firstPrompt ??= clean
          // Repeating the same request is still a new turn. Keeping the old
          // answer here would let Inbox display a previous success while the
          // latest repeated request has not produced any reply at all.
          result.lastReply = null
          result.lastPrompt = clean
        } else result.lastReply = clean
      }
    }
  } catch { /* A missing or partial transcript leaves the saved task available. */ }
  finally { if (fd !== undefined) fs.closeSync(fd) }
  return result
}
