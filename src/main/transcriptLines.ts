/**
 * Read the newest JSONL records first without loading a conversation's entire
 * history. A relay normally needs one answer and an export needs a short tail;
 * neither should allocate every old tool result just to throw it away again.
 *
 * Chunks stay as bytes until a complete line is assembled. Decoding a chunk on
 * its own could split a UTF-8 character, silently changing the agent's answer.
 * A single long record is kept whole, even when it exceeds the chunk size:
 * limiting I/O must never become a hidden limit on handoff content. Memory is
 * proportional to the largest record examined, not the full transcript.
 */
import fs from 'node:fs'

const CHUNK_BYTES = 64 * 1024

export function* reverseTranscriptLines(file: string): Generator<string> {
  const fd = fs.openSync(file, 'r')
  try {
    // Snapshot the length so a busy agent cannot make this read chase an
    // indefinitely growing file. A later call sees anything appended after it.
    let position = fs.fstatSync(fd).size
    let fragments: Buffer[] = []
    while (position > 0) {
      const start = Math.max(0, position - CHUNK_BYTES)
      const chunk = Buffer.allocUnsafe(position - start)
      let read = 0
      while (read < chunk.length) {
        const size = fs.readSync(fd, chunk, read, chunk.length - read, start + read)
        // A concurrently truncated file has no coherent tail at these offsets.
        // Do not stitch bytes from different versions into a plausible reply.
        if (size === 0) throw new Error('Transcript changed while reading')
        read += size
      }
      let end = chunk.length
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== 10) continue
        const beginning = chunk.subarray(i + 1, end)
        const line = fragments.length
          ? Buffer.concat([beginning, ...fragments.reverse()]).toString('utf8')
          : beginning.toString('utf8')
        fragments = []
        yield line
        end = i
      }
      if (end > 0) fragments.push(chunk.subarray(0, end))
      position = start
    }
    if (fragments.length) yield Buffer.concat(fragments.reverse()).toString('utf8')
  } finally {
    // `for … of` closes a generator when the caller returns early. Closing the
    // descriptor here covers that common case as well as malformed/read errors.
    fs.closeSync(fd)
  }
}
