import { pathToFileURL } from 'node:url'
/**
 * Attachments: pasting and dropping files onto a pane.
 *
 * The contract is narrow and worth pinning down, because every path here ends
 * up being typed into an agent that will then read whatever it points at:
 *   - a file that exists is referenced where it is, never copied;
 *   - a name supplied by whoever made the file can only ever land inside the
 *     attachments directory;
 *   - a batch reports its failures instead of quietly attaching fewer files.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  AttachmentStore,
  MAX_ATTACHMENTS_PER_BATCH,
  MAX_ATTACHMENT_BYTES,
  fileUrlToPath,
  safeAttachmentName
} from '../src/main/attachments.js'
import { formatAttachmentText, quoteForPrompt } from '../src/shared/attach.js'
import { tempDir } from './helpers.mjs'

/** A clipboard with nothing on it, which each test overrides as needed. */
function fakeClipboard({ png = null, fileUrl = '', throwOnRead = false } = {}) {
  return { read: async () => {
    if (throwOnRead) throw new Error('Clipboard is unavailable')
    const type = png ? 'image/png' : 'electron application/osclipboard;format="public.file-url"'
    return png || fileUrl ? [{ types: [type], getType: async () => new Blob([png ? Buffer.from(png) : fileUrl]) }] : []
  } }
}

describe('attachment names', () => {
  test('a name from elsewhere cannot steer the write out of the directory', () => {
    assert.equal(safeAttachmentName('../../.ssh/authorized_keys'), 'authorized_keys')
    assert.equal(safeAttachmentName('/etc/passwd'), 'passwd')
    assert.equal(safeAttachmentName('a/b/c.png'), 'c.png')
    // `..` has nothing left after the leading dots are stripped.
    assert.equal(safeAttachmentName('..'), 'attachment')
    assert.equal(safeAttachmentName(''), 'attachment')
    assert.equal(safeAttachmentName(null), 'attachment')
    assert.equal(safeAttachmentName(42), 'attachment')
  })

  test('shell metacharacters and control bytes collapse to dashes', () => {
    assert.equal(safeAttachmentName('my shot;rm.png'), 'my-shot-rm.png')
    assert.equal(safeAttachmentName('sh\u0000ot\u001b[0m.png'), 'sh-ot-0m.png')
    assert.equal(safeAttachmentName('$(whoami).png'), 'whoami-.png')
  })

  test('a hidden or flag-shaped name is neither', () => {
    assert.equal(safeAttachmentName('.env'), 'env')
    assert.equal(safeAttachmentName('--force.png'), 'force.png')
  })

  test('a very long name is truncated rather than rejected', () => {
    const name = safeAttachmentName(`${'x'.repeat(400)}.png`)
    assert.equal(name.length, 80)
  })
})

describe('paths as prompt text', () => {
  test('an ordinary path is typed bare', () => {
    assert.equal(quoteForPrompt('/tmp/shot.png'), '/tmp/shot.png')
    assert.equal(quoteForPrompt('/Users/me/Dev/a-b_c.2.png'), '/Users/me/Dev/a-b_c.2.png')
  })

  test('anything a shell would reinterpret is quoted', () => {
    // The pane underneath may be a bare shell, where an unquoted `$(...)` or
    // `;` in a filename is a command rather than a name.
    assert.equal(quoteForPrompt('/tmp/my shot.png'), "'/tmp/my shot.png'")
    assert.equal(quoteForPrompt('/tmp/$(id).png'), "'/tmp/$(id).png'")
    assert.equal(quoteForPrompt('/tmp/a;rm -rf b'), "'/tmp/a;rm -rf b'")
    assert.equal(quoteForPrompt(''), "''")
  })

  test('an embedded single quote is closed, escaped and reopened', () => {
    assert.equal(quoteForPrompt("/tmp/keegan's.png"), "'/tmp/keegan'\\''s.png'")
  })

  test('the typed text ends with a space so the next keystroke starts a word', () => {
    assert.equal(formatAttachmentText([]), '')
    assert.equal(formatAttachmentText(['/tmp/a.png']), '/tmp/a.png ')
    assert.equal(formatAttachmentText(['/tmp/a.png', '/tmp/b c.png']), "/tmp/a.png '/tmp/b c.png' ")
  })
})

describe('file urls', () => {
  test('a percent-encoded file url decodes to a real path', () => {
    const file = path.resolve('a b.png')
    assert.equal(fileUrlToPath(pathToFileURL(file).href), file)
    assert.equal(fileUrlToPath(`  ${pathToFileURL(file).href}\n`), file)
  })

  test('anything that is not a file url is not one', () => {
    assert.equal(fileUrlToPath('https://example.com/x.png'), null)
    assert.equal(fileUrlToPath('/tmp/x.png'), null)
    assert.equal(fileUrlToPath(''), null)
    assert.equal(fileUrlToPath(null), null)
  })
})

describe('saving clipboard bytes', () => {
  test('bytes land in the attachments directory, owner-only', () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    const file = store.saveBytes(Buffer.from('PNGDATA'), 'shot.png', Date.parse('2026-09-03T10:11:12Z'))

    assert.equal(path.dirname(file), store.dir)
    assert.equal(fs.readFileSync(file, 'utf8'), 'PNGDATA')
    // Windows uses inherited profile ACLs; chmod bits have no meaning there.
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      assert.equal(fs.statSync(store.dir).mode & 0o777, 0o700)
    }
    assert.match(path.basename(file), /^2026-09-03T10-11-12-[0-9a-f]{6}-shot\.png$/)
  })

  test('two pastes in the same second do not overwrite each other', () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    const now = Date.parse('2026-09-03T10:11:12Z')
    const a = store.saveBytes(Buffer.from('one'), 'shot.png', now)
    const b = store.saveBytes(Buffer.from('two'), 'shot.png', now)

    assert.notEqual(a, b)
    assert.equal(fs.readFileSync(a, 'utf8'), 'one')
    assert.equal(fs.readFileSync(b, 'utf8'), 'two')
  })

  test('empty and oversized payloads are refused, not written', () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    assert.throws(() => store.saveBytes(Buffer.alloc(0), 'x.png'), /empty/)
    assert.throws(
      () => store.saveBytes(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), 'x.png'),
      /larger than 25 MB/
    )
    assert.equal(fs.existsSync(store.dir) ? fs.readdirSync(store.dir).length : 0, 0)
  })
})

describe('adopting dropped files', () => {
  test('a file already on disk is referenced, never copied', () => {
    const work = tempDir('term-src-')
    const original = path.join(work, 'screenshot.png')
    fs.writeFileSync(original, 'ORIGINAL')

    const store = new AttachmentStore(tempDir('term-attach-'))
    assert.equal(store.adopt({ path: original }), original)
    // Nothing was written into our own directory — the point of passing paths.
    assert.equal(fs.existsSync(store.dir), false)
  })

  test('a relative path is resolved before it is handed to an agent', () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    const rel = path.relative(process.cwd(), path.join(process.cwd(), 'package.json'))
    assert.equal(store.adopt({ path: rel }), path.join(process.cwd(), 'package.json'))
  })

  test('a folder is a legitimate thing to point an agent at', () => {
    const dir = tempDir('term-src-')
    const store = new AttachmentStore(tempDir('term-attach-'))
    assert.equal(store.adopt({ path: dir }), dir)
  })

  test('a path that has since vanished fails by name', () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    assert.throws(() => store.adopt({ path: '/tmp/term-not-here-9182.png' }), /term-not-here-9182\.png: no longer on disk/)
  })

  test('bytes with no file behind them are written out', () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    const file = store.adopt({
      name: 'dragged.png',
      dataBase64: Buffer.from('FROMWEB').toString('base64')
    })
    assert.equal(fs.readFileSync(file, 'utf8'), 'FROMWEB')
    assert.equal(path.dirname(file), store.dir)
  })

  test('an item with neither a path nor bytes is an error, not a silent skip', () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    assert.throws(() => store.adopt({}), /no file behind it/)
    assert.throws(() => store.adopt({ path: '' }), /no file behind it/)
  })
})

describe('adopting a batch', () => {
  test('one bad file does not cost you the good ones, and is named', () => {
    const work = tempDir('term-src-')
    const good = path.join(work, 'a.png')
    fs.writeFileSync(good, 'A')
    const store = new AttachmentStore(tempDir('term-attach-'))

    const res = store.adoptAll([
      { path: good },
      { path: path.join(work, 'gone.png') },
      { name: 'b.png', dataBase64: Buffer.from('B').toString('base64') }
    ])

    assert.equal(res.paths.length, 2, 'both usable items were attached')
    assert.equal(res.paths[0], good)
    assert.equal(res.errors.length, 1)
    assert.match(res.errors[0], /gone\.png/)
  })

  test('an oversized batch is truncated and says how much it dropped', () => {
    const work = tempDir('term-src-')
    const items = []
    for (let i = 0; i < MAX_ATTACHMENTS_PER_BATCH + 3; i += 1) {
      const p = path.join(work, `f${i}.txt`)
      fs.writeFileSync(p, String(i))
      items.push({ path: p })
    }

    const store = new AttachmentStore(tempDir('term-attach-'))
    const res = store.adoptAll(items)

    assert.equal(res.paths.length, MAX_ATTACHMENTS_PER_BATCH)
    assert.equal(res.errors.length, 1)
    assert.match(res.errors[0], new RegExp(`first ${MAX_ATTACHMENTS_PER_BATCH} of ${items.length}`))
  })

  test('an empty batch is not an error', () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    assert.deepEqual(store.adoptAll([]), { paths: [], errors: [] })
  })
})

describe('reading the system clipboard', async () => {
  test('an image on the clipboard becomes a png on disk', async () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    const res = await store.fromClipboard(fakeClipboard({ png: [0x89, 0x50, 0x4e, 0x47] }))

    assert.equal(res.errors.length, 0)
    assert.equal(res.paths.length, 1)
    assert.match(path.basename(res.paths[0]), /pasted-image\.png$/)
    assert.deepEqual(Array.from(fs.readFileSync(res.paths[0])), [0x89, 0x50, 0x4e, 0x47])
  })

  test('a file copied in Finder arrives as a url and is adopted in place', async () => {
    const work = tempDir('term-src-')
    const original = path.join(work, 'from finder.png')
    fs.writeFileSync(original, 'F')

    const store = new AttachmentStore(tempDir('term-attach-'))
    const res = await store.fromClipboard(
      fakeClipboard({ fileUrl: pathToFileURL(original).href })
    )

    assert.deepEqual(res, { paths: [original], errors: [] })
    assert.equal(fs.existsSync(store.dir), false, 'still no copy')
  })

  test('an empty clipboard is an empty result, not a failure', async () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    assert.deepEqual(await store.fromClipboard(fakeClipboard()), { paths: [], errors: [] })
  })

  test('a clipboard failure is returned as an actionable paste error', async () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    assert.deepEqual(await store.fromClipboard(fakeClipboard({ throwOnRead: true })), {
      paths: [],
      errors: ['Clipboard is unavailable']
    })
  })
  test('an oversized image is rejected before its bytes are allocated', async () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    let readBytes = false
    const result = await store.fromClipboard({ read: async () => [{ types: ['image/png'],
      getType: async () => ({ size: MAX_ATTACHMENT_BYTES + 1, arrayBuffer: async () => { readBytes = true; return new ArrayBuffer(0) } })
    }] })
    assert.equal(readBytes, false)
    assert.equal(result.paths.length, 0)
    assert.match(result.errors[0], /25 MB/)
  })
})

describe('pruning', async () => {
  test('stale attachments go and fresh ones stay', async () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    // Real wall-clock, because the freshness check compares against the mtime
    // the filesystem actually stamped on the file we just wrote.
    const now = Date.now()
    const old = store.saveBytes(Buffer.from('old'), 'old.png', now)
    const fresh = store.saveBytes(Buffer.from('new'), 'new.png', now)
    const day = 24 * 60 * 60 * 1000
    fs.utimesSync(old, new Date(now - 30 * day), new Date(now - 30 * day))

    assert.equal(store.prune(now, 7 * day), 1)
    assert.equal(fs.existsSync(old), false)
    assert.equal(fs.existsSync(fresh), true)
  })

  test('pruning before anything has ever been attached is a no-op', async () => {
    const store = new AttachmentStore(tempDir('term-attach-'))
    assert.equal(store.prune(), 0)
  })
})
