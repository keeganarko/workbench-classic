/**
 * The preview dock's server half.
 *
 * The dock renders whatever an agent just wrote, which makes it the one place
 * in the app where a file's *contents* get to decide what happens next. The
 * rules worth pinning down are therefore about reach, not rendering:
 *   - a request only resolves for a file under a folder actually opened;
 *   - a symlink pointing out of that folder does not count as being inside it;
 *   - a generated document is served with a policy minted here, not one the
 *     renderer supplied;
 *   - `..` in a URL cannot walk up out of a root.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { PreviewServer, isInsideRoot, MAX_TEXT_BYTES } from '../src/main/preview.js'
import {
  classifyPreview,
  isPreviewable,
  mimeForPath,
  parseDelimited,
  pathFromPreviewUrl,
  previewDirUrl,
  previewUrlFor
} from '../src/shared/preview.js'
import { tempDir } from './helpers.mjs'

/** `tempDir` hands back `/var/...` on macOS, where the real path is `/private/var/...`. */
function realTempDir(prefix) {
  return fs.realpathSync.native(tempDir(prefix))
}

function write(dir, name, body) {
  const file = path.join(dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, 'utf8')
  return file
}

describe('classification', () => {
  test('maps extensions to the viewer that can show them', () => {
    assert.equal(classifyPreview('/x/report.md'), 'markdown')
    assert.equal(classifyPreview('/x/REPORT.MARKDOWN'), 'markdown')
    assert.equal(classifyPreview('/x/artifact.html'), 'html')
    assert.equal(classifyPreview('/x/chart.svg'), 'svg')
    assert.equal(classifyPreview('/x/shot.png'), 'image')
    assert.equal(classifyPreview('/x/paper.pdf'), 'pdf')
    assert.equal(classifyPreview('/x/rows.csv'), 'csv')
    assert.equal(classifyPreview('/x/rows.tsv'), 'csv')
    assert.equal(classifyPreview('/x/data.json'), 'json')
    assert.equal(classifyPreview('/x/notes.txt'), 'text')
    // A patch off disk and a diff the git panel generated are the same kind,
    // so both render through one path.
    assert.equal(classifyPreview('/x/fix.patch'), 'diff')
    assert.equal(classifyPreview('/x/fix.diff'), 'diff')
  })

  test('refuses what it cannot render, rather than guessing', () => {
    assert.equal(classifyPreview('/x/app.bin'), null)
    assert.equal(classifyPreview('/x/movie.mov'), null)
    assert.equal(isPreviewable('/x/app.bin'), false)
    assert.equal(isPreviewable('/x/report.md'), true)
  })

  test('serves SVG as its own type — never as HTML', () => {
    // An SVG served as text/html is a script host. It is shown in an <img>,
    // and the type it is served with has to agree with that.
    assert.equal(mimeForPath('/x/chart.svg'), 'image/svg+xml')
    assert.equal(mimeForPath('/x/page.html'), 'text/html; charset=utf-8')
    assert.equal(mimeForPath('/x/unknown.zzz'), 'application/octet-stream')
    assert.equal(mimeForPath('/x/fix.patch'), 'text/plain; charset=utf-8')
  })
})

describe('preview URLs', () => {
  test('round-trip a path with spaces, hashes and unicode', () => {
    for (const p of ['/tmp/a b/c#d.md', '/tmp/rapport été.md', '/tmp/50% done.csv']) {
      assert.equal(pathFromPreviewUrl(previewUrlFor(p)), p)
    }
  })

  test('a directory URL ends in a slash, so <base> resolves siblings', () => {
    // Without the trailing slash the last segment is replaced, and every
    // relative image in a rendered document resolves one folder too high.
    assert.ok(previewDirUrl('/tmp/docs').endsWith('/'))
  })

  test('anything that is not a file URL on the scheme resolves to nothing', () => {
    assert.equal(pathFromPreviewUrl('https://example.com/x.md'), null)
    assert.equal(pathFromPreviewUrl('wb-preview://doc/abc'), null)
    assert.equal(pathFromPreviewUrl('not a url'), null)
  })
})

describe('containment', () => {
  test('a sibling with a shared prefix is not inside the root', () => {
    assert.equal(isInsideRoot('/tmp/work', '/tmp/work/a/b.md'), true)
    assert.equal(isInsideRoot('/tmp/work', '/tmp/work'), true)
    assert.equal(isInsideRoot('/tmp/work', '/tmp/work-2/b.md'), false)
    assert.equal(isInsideRoot('/tmp/work', '/tmp/other/b.md'), false)
    assert.equal(isInsideRoot('/tmp/work', '/tmp/work/../secret.md'), false)
  })
})

describe('opening', () => {
  test('attaches text for the kinds the renderer has to turn into HTML', () => {
    const dir = realTempDir('preview-open-')
    const file = write(dir, 'report.md', '# Title\n\nbody\n')
    const server = new PreviewServer()

    const doc = server.open(file)
    assert.equal(doc.kind, 'markdown')
    assert.equal(doc.name, 'report.md')
    assert.equal(doc.text, '# Title\n\nbody\n')
    assert.equal(doc.truncated, false)
    assert.equal(doc.path, file)
  })

  test('leaves binary kinds to be loaded by URL rather than shipped over IPC', () => {
    const dir = realTempDir('preview-bin-')
    const file = path.join(dir, 'shot.png')
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const doc = new PreviewServer().open(file)
    assert.equal(doc.kind, 'image')
    assert.equal(doc.text, null)
  })

  test('truncates a huge text file at a line boundary and says so', () => {
    const dir = realTempDir('preview-big-')
    const line = 'x'.repeat(999) + '\n'
    const file = write(dir, 'big.txt', line.repeat(Math.ceil(MAX_TEXT_BYTES / 1000) + 10))
    const doc = new PreviewServer().open(file)
    assert.equal(doc.truncated, true)
    assert.ok(doc.text.length <= MAX_TEXT_BYTES)
    assert.ok(!doc.text.endsWith('\n'), 'cut back past the final newline')
  })

  test('a folder and an unrenderable file are both refused', () => {
    const dir = realTempDir('preview-refuse-')
    fs.mkdirSync(path.join(dir, 'sub'))
    const server = new PreviewServer()
    assert.throws(() => server.open(path.join(dir, 'sub')), /folder|preview/i)
    write(dir, 'app.bin', 'x')
    assert.throws(() => server.open(path.join(dir, 'app.bin')), /preview/i)
    assert.throws(() => server.open(path.join(dir, 'gone.md')), /not there/i)
  })

  test('opening widens the servable set to the file’s folder, and no further', () => {
    const dir = realTempDir('preview-root-')
    const file = write(dir, 'docs/report.md', 'hi')
    const server = new PreviewServer()
    server.open(file)

    assert.equal(server.isServable(file), true)
    assert.equal(server.isServable(path.join(dir, 'docs', 'other.md')), true)
    assert.equal(server.isServable(path.join(dir, 'secret.md')), false)
  })

  test('a workspace root widens it to the repository, when one is supplied', () => {
    const dir = realTempDir('preview-ws-')
    const file = write(dir, 'docs/report.md', 'hi')
    const server = new PreviewServer({ resolveRoot: () => dir })
    server.open(file)
    assert.equal(server.isServable(path.join(dir, 'assets', 'logo.png')), true)
  })

  test('a resolveRoot that does not contain the file is ignored', () => {
    // Otherwise the workspace lookup becomes a way to open the whole disk.
    const dir = realTempDir('preview-ws-bad-')
    const other = realTempDir('preview-ws-elsewhere-')
    const file = write(dir, 'report.md', 'hi')
    const server = new PreviewServer({ resolveRoot: () => other })
    server.open(file)
    assert.equal(server.isServable(path.join(other, 'anything.md')), false)
  })
})

describe('serving', () => {
  test('a file inside an opened root is streamed back with its own type', async () => {
    const dir = realTempDir('preview-serve-')
    const file = write(dir, 'report.md', '# hi')
    const server = new PreviewServer()
    server.open(file)

    const res = await server.serve(previewUrlFor(file))
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/markdown/)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(await res.text(), '# hi')
  })

  test('a file outside every opened root is refused', async () => {
    const dir = realTempDir('preview-deny-')
    const secrets = realTempDir('preview-secrets-')
    const opened = write(dir, 'docs/report.md', 'hi')
    const secret = write(secrets, 'id_rsa.txt', 'PRIVATE KEY')

    const server = new PreviewServer()
    server.open(opened)

    const res = await server.serve(previewUrlFor(secret))
    assert.equal(res.status, 403)
  })

  test('a symlink pointing out of the root does not smuggle a file in', async () => {
    const dir = realTempDir('preview-link-')
    const secrets = realTempDir('preview-link-secrets-')
    const opened = write(dir, 'report.md', 'hi')
    const secret = write(secrets, 'secret.txt', 'PRIVATE KEY')

    // Directory junctions exercise the same escape on Windows without needing
    // Developer Mode or administrator permission to create file symlinks.
    const linkedDir = path.join(dir, 'looks-local')
    fs.symlinkSync(secrets, linkedDir, process.platform === 'win32' ? 'junction' : 'dir')
    const link = path.join(linkedDir, 'secret.txt')

    const server = new PreviewServer()
    server.open(opened)

    // The URL is inside the opened folder; the file it names is not.
    const res = await server.serve(previewUrlFor(link))
    assert.equal(res.status, 403)
    // And going in through `open()` fails the same way, at the same check.
    assert.equal(server.isServable(fs.realpathSync.native(link)), false)
  })

  test('a `..` in the URL cannot climb out of the root', async () => {
    const dir = realTempDir('preview-dots-')
    const outside = realTempDir('preview-dots-out-')
    write(outside, 'secret.txt', 'PRIVATE KEY')
    const opened = write(dir, 'docs/report.md', 'hi')

    const server = new PreviewServer()
    server.open(opened)

    const climb = previewUrlFor(path.join(dir, 'docs', '..', '..', path.basename(outside), 'secret.txt'))
    const res = await server.serve(climb)
    assert.equal(res.status, 403)
  })

  test('a directory is refused rather than listed', async () => {
    const dir = realTempDir('preview-dir-')
    const opened = write(dir, 'docs/report.md', 'hi')
    const server = new PreviewServer()
    server.open(opened)
    const res = await server.serve(previewUrlFor(path.join(dir, 'docs')))
    assert.equal(res.status, 403)
  })
})

describe('generated documents', () => {
  test('are served with a policy minted here, matching their own nonce', async () => {
    const server = new PreviewServer()
    const url = server.documentUrl({
      title: 'report.md',
      body: '<h1>hi</h1>',
      baseHref: previewDirUrl('/tmp'),
      bodyClass: 'doc'
    })

    const res = await server.serve(url)
    assert.equal(res.status, 200)
    const csp = res.headers.get('content-security-policy')
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)
    assert.ok(nonce, 'the policy names a nonce')

    const html = await res.text()
    assert.ok(html.includes(`nonce="${nonce[1]}"`), 'the only script carries that nonce')
    // Nothing else may run: no inline handlers, no other origin.
    assert.ok(csp.includes("default-src 'none'"))
    assert.ok(!csp.includes("script-src 'unsafe-inline'"))
    assert.ok(csp.includes('base-uri wb-preview:'), '<base> has to keep working')
  })

  test('two documents never share a nonce', async () => {
    const server = new PreviewServer()
    const nonces = []
    for (let i = 0; i < 2; i++) {
      const url = server.documentUrl({ title: 't', body: '<p>x</p>', baseHref: previewDirUrl('/tmp') })
      const res = await server.serve(url)
      nonces.push(/nonce-([A-Za-z0-9_-]+)/.exec(res.headers.get('content-security-policy'))[1])
    }
    assert.notEqual(nonces[0], nonces[1])
  })

  test('carry a <base> for the file’s folder, a body class, and a restored scroll', async () => {
    const server = new PreviewServer()
    const url = server.documentUrl({
      title: 'rows.csv',
      body: '<table></table>',
      baseHref: previewDirUrl('/tmp/docs'),
      bodyClass: 'data',
      initialScroll: 640
    })
    const html = await (await server.serve(url)).text()

    // Without the <base> every relative image in a rendered document breaks;
    // without the scroll, a watched file jumps to the top on every save.
    assert.ok(html.includes('<base href="wb-preview://f/tmp/docs/"'))
    assert.ok(html.includes('<body class="data">'))
    assert.ok(html.includes('640'))
    assert.ok(html.includes('<title>rows.csv</title>'))
  })

  test('a title with markup in it cannot escape the head', async () => {
    const server = new PreviewServer()
    const url = server.documentUrl({
      title: '</title><script>alert(1)</script>',
      body: '<p>x</p>',
      baseHref: previewDirUrl('/tmp')
    })
    const html = await (await server.serve(url)).text()
    assert.ok(!html.includes('</title><script>'))
    assert.ok(html.includes('&lt;script&gt;'))
  })

  test('an id that was evicted or never existed 404s instead of throwing', async () => {
    const res = await new PreviewServer().serve('wb-preview://doc/nope')
    assert.equal(res.status, 404)
  })
})

describe('reveal and open-with', () => {
  test('only ever resolves a file the pane already has open', () => {
    const dir = realTempDir('preview-reveal-')
    const secrets = realTempDir('preview-reveal-secrets-')
    const opened = write(dir, 'report.md', 'hi')
    const secret = write(secrets, 'secret.txt', 'nope')

    const server = new PreviewServer()
    server.open(opened)

    assert.equal(server.assertReadable(opened), opened)
    assert.throws(() => server.assertReadable(secret), /not open/i)
  })
})

describe('recents', () => {
  test('lists previewable files newest first, skipping build output', () => {
    const dir = realTempDir('preview-recent-')
    write(dir, 'old.md', 'a')
    write(dir, 'node_modules/pkg/readme.md', 'no')
    write(dir, 'dist/bundle.html', 'no')
    write(dir, '.hidden/notes.md', 'no')
    write(dir, 'binary.bin', 'no')
    write(dir, 'nested/new.md', 'b')

    // Make the ordering unambiguous rather than relying on write speed.
    const old = path.join(dir, 'old.md')
    fs.utimesSync(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))

    const names = new PreviewServer().recent(dir).map((e) => e.name)
    assert.deepEqual(names, ['new.md', 'old.md'])
  })

  test('a directory that is not there yields nothing rather than throwing', () => {
    assert.deepEqual(new PreviewServer().recent('/definitely/not/here'), [])
  })
})

describe('what a finished turn produced', () => {
  const ago = (ms) => Date.now() - ms
  // A freshly written NTFS timestamp can be ahead of Date.now() on Windows
  // ARM. Place fixtures inside their intended turn explicitly so these tests
  // exercise document selection and turn boundaries on every filesystem.
  const writeAt = (dir, name, body, time = ago(500)) => {
    const file = write(dir, name, body)
    fs.utimesSync(file, new Date(time), new Date(time))
    return file
  }

  test('finds a document written during the turn, and ignores older ones', () => {
    const dir = realTempDir('preview-produced-')
    const old = write(dir, 'previous.md', 'a')
    fs.utimesSync(old, new Date(ago(60_000)), new Date(ago(60_000)))
    writeAt(dir, 'report.md', 'b')

    const found = new PreviewServer().producedSince(dir, ago(10_000))
    assert.equal(found?.name, 'report.md')
  })

  test('ignores source, config and log files — the bulk of any turn', () => {
    // The pane opening itself for every `.ts` file it wrote is the failure mode
    // that would make people turn this off, so those kinds never qualify.
    const dir = realTempDir('preview-noise-')
    for (const name of ['index.ts', 'package.json', 'run.log', 'notes.txt', 'a.yaml']) {
      writeAt(dir, name, 'x')
    }
    assert.equal(new PreviewServer().producedSince(dir, ago(10_000)), null)
  })

  test('a turn that wrote nothing worth showing surfaces nothing', () => {
    const dir = realTempDir('preview-quiet-')
    const old = write(dir, 'report.md', 'a')
    fs.utimesSync(old, new Date(ago(60_000)), new Date(ago(60_000)))
    assert.equal(new PreviewServer().producedSince(dir, ago(10_000)), null)
  })

  test('does not guess when a deliverable and a later handoff both changed', () => {
    const dir = realTempDir('preview-several-')
    const first = write(dir, 'first.md', 'a')
    fs.utimesSync(first, new Date(ago(5_000)), new Date(ago(5_000)))
    writeAt(dir, 'chart.svg', '<svg />')

    assert.equal(new PreviewServer().producedSince(dir, ago(10_000)), null)
  })

  test('an explicit show prevents a later handoff from replacing it, only for its own session and turn', () => {
    const server = new PreviewServer()
    const dir = realTempDir('preview-named-')
    const since = ago(10_000)
    server.noteShown('coordinator', ago(5000))
    writeAt(dir, 'file-controls.md', '# Unrelated handoff')
    assert.equal(server.producedFor('coordinator', dir, since), null)
    assert.equal(server.producedFor('other-session', dir, since)?.name, 'file-controls.md')
    assert.equal(server.producedFor('coordinator', dir, ago(1000))?.name, 'file-controls.md',
      'a previous turn’s show does not suppress every future scan')
  })

  test('a newer explicit show also cancels an older deferred scan', () => {
    const server = new PreviewServer()
    const dir = realTempDir('preview-deferred-')
    const since = ago(10_000), until = ago(2000)
    const file = write(dir, 'earlier.md', '# Earlier turn')
    fs.utimesSync(file, new Date(ago(3000)), new Date(ago(3000)))
    server.noteShown('coordinator')
    assert.equal(server.producedFor('coordinator', dir, since, until), null)
  })

  test('a deferred scan excludes files written after the turn ended', () => {
    const server = new PreviewServer()
    const dir = realTempDir('preview-end-')
    const until = ago(2000)
    const file = write(dir, 'concept.html', '<h1>The intended result</h1>')
    fs.utimesSync(file, new Date(ago(3000)), new Date(ago(3000)))
    writeAt(dir, 'later-handoff.md', '# Written after the boundary')
    assert.equal(server.producedSince(dir, ago(10_000), until)?.name, 'concept.html')
  })

  test('images and PDFs count; so do tables', () => {
    const dir = realTempDir('preview-kinds-')
    writeAt(dir, 'shot.png', 'x')
    assert.equal(new PreviewServer().producedSince(dir, ago(10_000))?.kind, 'image')
  })
})

describe('delimited text', () => {
  test('parses quoted fields, embedded delimiters and doubled quotes', () => {
    const rows = parseDelimited('a,b\n"x,y","he said ""hi"""\n')
    assert.deepEqual(rows, [
      ['a', 'b'],
      ['x,y', 'he said "hi"']
    ])
  })

  test('handles CRLF and a quoted newline', () => {
    const rows = parseDelimited('a,b\r\n"line\none",2\r\n')
    assert.deepEqual(rows, [
      ['a', 'b'],
      ['line\none', '2']
    ])
  })

  test('takes an alternate delimiter, for .tsv', () => {
    assert.deepEqual(parseDelimited('a\tb\n1\t2\n', '\t'), [
      ['a', 'b'],
      ['1', '2']
    ])
  })
})
