/**
 * The unified-diff parser behind the preview dock's `diff` kind.
 *
 * A patch is the only document in the app whose *content* can look exactly like
 * its own framing: a deleted line that began with `-- ` arrives as `--- `, and
 * a context line that began with `+` arrives as ` +`. So most of what is pinned
 * here is the parser refusing to be fooled by its own input, alongside the two
 * things a reader depends on being right — line numbers on both sides, and the
 * fact that every span of the patch reaches the document escaped.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { parseUnifiedDiff, diffStats, renderDiff } from '../src/shared/diff.js'

/** The lines of the first hunk of the first file, as `[kind, old, new, text]`. */
function rows(patch) {
  const [file] = parseUnifiedDiff(patch)
  return file.hunks[0].lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text])
}

describe('parsing', () => {
  test('an ordinary edit: paths, numbering, and counts', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/src/app.ts b/src/app.ts',
        'index 1111111..2222222 100644',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -10,4 +10,5 @@ function run() {',
        ' const a = 1',
        '-const b = 2',
        '+const b = 3',
        '+const c = 4',
        ' return a',
        ''
      ].join('\n')
    )

    assert.equal(files.length, 1)
    assert.equal(files[0].path, 'src/app.ts')
    assert.equal(files[0].oldPath, 'src/app.ts')
    assert.equal(files[0].status, null)
    assert.equal(files[0].additions, 2)
    assert.equal(files[0].deletions, 1)
    assert.equal(files[0].hunks.length, 1)
    assert.equal(files[0].hunks[0].header, '@@ -10,4 +10,5 @@ function run() {')
  })

  test('both sides are numbered from the hunk header, and skip where they must', () => {
    const patch = [
      '--- a/x',
      '+++ b/x',
      '@@ -10,3 +20,4 @@',
      ' keep',
      '-gone',
      '+new one',
      '+new two',
      ' tail'
    ].join('\n')

    assert.deepEqual(rows(patch), [
      ['context', 10, 20, 'keep'],
      // A deletion exists only on the left, an addition only on the right.
      ['del', 11, null, 'gone'],
      ['add', null, 21, 'new one'],
      ['add', null, 22, 'new two'],
      ['context', 12, 23, 'tail']
    ])
  })

  test('a hunk header with no ranges still numbers from 1', () => {
    const [file] = parseUnifiedDiff(['--- a/x', '+++ b/x', '@@ @@', ' one'].join('\n'))
    assert.deepEqual(file.hunks[0].lines[0], {
      kind: 'context',
      text: 'one',
      oldNo: 1,
      newNo: 1
    })
  })

  test('a deleted line that is itself a diff header stays inside the hunk', () => {
    // Deleting the text `-- more` produces the line `--- more`, which is
    // exactly the shape of a file header. Getting this wrong splits one file
    // into two and loses the rest of the hunk.
    const patch = [
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,3 +1,2 @@',
      ' intro',
      '--- more',
      ' outro'
    ].join('\n')

    const files = parseUnifiedDiff(patch)
    assert.equal(files.length, 1)
    assert.deepEqual(rows(patch), [
      ['context', 1, 1, 'intro'],
      ['del', 2, null, '-- more'],
      ['context', 3, 2, 'outro']
    ])
  })

  test('an added line beginning with +++ is an addition, not a header', () => {
    const patch = ['--- a/x', '+++ b/x', '@@ -1 +1,2 @@', ' a', '++++ b'].join('\n')
    const files = parseUnifiedDiff(patch)
    assert.equal(files.length, 1)
    assert.equal(files[0].additions, 1)
    assert.equal(files[0].hunks[0].lines[1].text, '+++ b')
  })

  test('an empty line inside a hunk is context, not the end of it', () => {
    // Many tools strip the trailing space from an empty context line.
    const patch = ['--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@', ' a', '', '+b'].join('\n')
    assert.deepEqual(rows(patch), [
      ['context', 1, 1, 'a'],
      ['context', 2, 2, ''],
      ['add', null, 3, 'b']
    ])
  })

  test('"\\ No newline at end of file" is kept, and numbered as nothing', () => {
    const patch = ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-old', '\\ No newline at end of file', '+new'].join('\n')
    assert.deepEqual(rows(patch), [
      ['del', 1, null, 'old'],
      ['meta', null, null, '\\ No newline at end of file'],
      ['add', null, 1, 'new']
    ])
  })

  test('/dev/null on the left is a new file, on the right a deletion', () => {
    const added = parseUnifiedDiff(
      ['--- /dev/null', '+++ b/fresh.txt', '@@ -0,0 +1 @@', '+hello'].join('\n')
    )[0]
    assert.equal(added.status, 'new')
    assert.equal(added.path, 'fresh.txt')
    assert.equal(added.oldPath, null)

    const removed = parseUnifiedDiff(
      ['--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye'].join('\n')
    )[0]
    assert.equal(removed.status, 'deleted')
    // The name has to come from the old side; there is no new side.
    assert.equal(removed.path, 'gone.txt')
    assert.equal(removed.newPath, null)
  })

  test('the extended headers git writes instead of hunks', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/old.ts b/new.ts',
        'similarity index 100%',
        'rename from old.ts',
        'rename to new.ts',
        'diff --git a/run.sh b/run.sh',
        'old mode 100644',
        'new mode 100755',
        'diff --git a/logo.png b/logo.png',
        'Binary files a/logo.png and b/logo.png differ'
      ].join('\n')
    )

    assert.equal(files.length, 3)
    assert.deepEqual(
      files.map((f) => [f.status, f.path]),
      [
        ['renamed', 'new.ts'],
        [null, 'run.sh'],
        ['binary', 'logo.png']
      ]
    )
    assert.deepEqual(files[1].notes, ['old mode 100644', 'new mode 100755'])
    assert.equal(files[0].oldPath, 'old.ts')
  })

  test('a bare `diff -u` patch with no git header', () => {
    const files = parseUnifiedDiff(
      ['--- one.txt\t2026-01-01', '+++ two.txt\t2026-01-02', '@@ -1 +1 @@', '-a', '+b'].join('\n')
    )
    assert.equal(files.length, 1)
    // The timestamp after the tab is not part of the path.
    assert.equal(files[0].oldPath, 'one.txt')
    assert.equal(files[0].path, 'two.txt')
  })

  test('several files in one patch stay separate, on the git header', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/x b/x',
        '--- a/x',
        '+++ b/x',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        'diff --git a/y b/y',
        '--- a/y',
        '+++ b/y',
        '@@ -1 +1 @@',
        '-c',
        '+d'
      ].join('\n')
    )
    assert.deepEqual(
      files.map((f) => f.path),
      ['x', 'y']
    )
  })

  test('without a git header, a second file inside a hunk reads as a deletion', () => {
    // Deliberate, and the same rule as the `-- more` case above: `--- a/y`
    // arriving mid-hunk is indistinguishable from someone deleting the line
    // `-- a/y`, so the hunk body wins. Every patch this app generates comes
    // from `git diff` — including `--no-index` — and carries the `diff --git`
    // line that settles it, so the ambiguity only exists for a hand-made patch
    // opened off disk, where losing a deleted line would be the worse failure.
    const files = parseUnifiedDiff(
      ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', '--- a/y', '+++ b/y'].join('\n')
    )
    assert.deepEqual(
      files.map((f) => f.path),
      ['x']
    )
    assert.equal(files[0].deletions, 2)
  })

  test('a commit message above the first file is not part of the change', () => {
    const files = parseUnifiedDiff(
      [
        'From 0123456 Mon Sep 17 00:00:00 2001',
        'Subject: [PATCH] fix the thing',
        '',
        'The body explains it, and mentions - and + a lot.',
        '',
        'diff --git a/x b/x',
        '--- a/x',
        '+++ b/x',
        '@@ -1 +1 @@',
        '-a',
        '+b'
      ].join('\n')
    )
    assert.equal(files.length, 1)
    assert.equal(files[0].additions, 1)
  })

  test('an empty patch is no files rather than one empty one', () => {
    assert.deepEqual(parseUnifiedDiff(''), [])
    assert.deepEqual(parseUnifiedDiff('\n\n'), [])
  })

  test('CRLF line endings parse the same as LF', () => {
    const files = parseUnifiedDiff('--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n')
    assert.equal(files[0].path, 'x')
    assert.equal(files[0].hunks[0].lines[0].text, 'a')
  })
})

describe('stats', () => {
  test('sums across every file', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/x b/x',
        '--- a/x',
        '+++ b/x',
        '@@ -1 +1,2 @@',
        '-a',
        '+b',
        '+c',
        'diff --git a/y b/y',
        '--- a/y',
        '+++ b/y',
        '@@ -1,2 +1 @@',
        '-d',
        '-e',
        '+f'
      ].join('\n')
    )
    assert.deepEqual(diffStats(files), { files: 2, additions: 3, deletions: 3 })
  })
})

describe('rendering', () => {
  const patch = ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-const a = 1', '+const a = 2'].join('\n')

  test('one section per file, with a table of rows', () => {
    const html = renderDiff(patch, { title: 'x.ts · worktree' })
    assert.ok(html.includes('<section class="diff-file">'))
    assert.ok(html.includes('<span class="diff-file-path">x.ts</span>'))
    assert.ok(html.includes('class="diff-row diff-row--add"'))
    assert.ok(html.includes('class="diff-row diff-row--del"'))
    assert.ok(html.includes('class="diff-row diff-row--hunk"'))
    assert.ok(html.includes('x.ts · worktree'))
  })

  test('the sign column is a glyph, so a copied selection has no +/- in it', () => {
    // The gutters are `user-select: none` in the document stylesheet; using a
    // minus sign rather than a hyphen means even a forced copy is unambiguous.
    const html = renderDiff(patch)
    assert.ok(html.includes('<td class="diff-sign">+</td>'))
    assert.ok(html.includes('<td class="diff-sign">−</td>'))
  })

  test('patch text is escaped, including text that looks like markup', () => {
    const html = renderDiff(
      ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-<b>old</b>', '+<script>alert(1)</script>'].join('\n')
    )
    assert.ok(!html.includes('<script>'))
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
    assert.ok(html.includes('&lt;b&gt;old&lt;/b&gt;'))
  })

  test('a path that looks like markup is escaped too', () => {
    const html = renderDiff(['--- a/<x>', '+++ b/<x>', '@@ -1 +1 @@', '-a', '+b'].join('\n'))
    assert.ok(html.includes('<span class="diff-file-path">&lt;x&gt;</span>'))
  })

  test('a note rides above the patch, escaped', () => {
    const html = renderDiff(patch, { note: 'cut short <here>' })
    assert.ok(html.includes('<p class="doc-note">cut short &lt;here&gt;</p>'))
  })

  test('an empty patch says so instead of rendering nothing', () => {
    const html = renderDiff('', { title: 'nothing' })
    assert.ok(html.includes('No changes here.'))
    // With no files there is nothing to count, so no counts are claimed.
    assert.ok(!html.includes('diff-add-count'))
  })

  test('a binary file shows its note and no table', () => {
    const html = renderDiff(
      ['diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ'].join('\n')
    )
    assert.ok(html.includes('diff-file-tag--binary'))
    assert.ok(html.includes('Binary files a/logo.png and b/logo.png differ'))
    assert.ok(!html.includes('<table'))
  })

  test('an empty line still occupies a row', () => {
    const html = renderDiff(['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' a', '+'].join('\n'))
    assert.ok(html.includes('<td class="diff-code">&nbsp;</td>'))
  })
})
