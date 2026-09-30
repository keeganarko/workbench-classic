/**
 * The review half of the git layer, run against real git.
 *
 * Porcelain output is the interface here, and a fake would only prove that the
 * fake matches the parser. What is worth protecting is git's actual behaviour
 * on the cases the panel meets daily and gets wrong quietly: a path with a
 * space in it, a rename (two records for one entry), a file staged and then
 * edited again, a conflict, and a repository with no commit yet — where
 * "unstage" is not spelled `reset` at all.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  MAX_PATCH_BYTES,
  commitStaged,
  parseAheadBehind,
  parseStatusPorcelain,
  readDiff,
  readStatus,
  runGit,
  stagePaths,
  unstagePaths
} from '../src/main/git.js'
import { GitReview } from '../src/main/review.js'
import { tempDir } from './helpers.mjs'

// Hosted Windows runners have no WSL distro. Pure parsing still runs there;
// actual Git/WSL integration runs on configured Windows desktops and Unix CI.
const gitMissing = (await runGit(['--version'], process.cwd())).code !== 0

/** A repository with one commit on `main`, in a throwaway directory. */
async function makeRepo(files = { 'README.md': '# repo\n' }) {
  // Realpath because git reports resolved paths and macOS hands out a
  // symlinked temp dir.
  const dir = fs.realpathSync(tempDir('term-git-'))
  await runGit(['init', '-b', 'main', '-q', '.'], dir)
  await runGit(['config', 'user.email', 'test@terminal.local'], dir)
  await runGit(['config', 'user.name', 'Workbench Test'], dir)
  for (const [name, body] of Object.entries(files)) write(dir, name, body)
  await runGit(['add', '.'], dir)
  await runGit(['commit', '-q', '-m', 'init'], dir)
  return dir
}

/** An empty repository — no commit, so no HEAD. */
async function makeUnborn() {
  const dir = fs.realpathSync(tempDir('term-git-'))
  await runGit(['init', '-b', 'main', '-q', '.'], dir)
  await runGit(['config', 'user.email', 'test@terminal.local'], dir)
  await runGit(['config', 'user.name', 'Workbench Test'], dir)
  return dir
}

function write(dir, name, body) {
  const full = path.join(dir, name)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
}

/** The status of one path, by path. */
function fileIn(status, p) {
  return status.files.find((f) => f.path === p) ?? null
}

describe('parsing porcelain', () => {
  test('the two sides of a record are read independently', () => {
    // Staged as modified, and modified again since — one path, two answers.
    const files = parseStatusPorcelain('MM src/app.ts\0A  new.ts\0 D gone.ts\0?? scratch\0')
    assert.deepEqual(files, [
      { path: 'src/app.ts', staged: 'modified', unstaged: 'modified', from: null },
      { path: 'new.ts', staged: 'added', unstaged: null, from: null },
      { path: 'gone.ts', staged: null, unstaged: 'deleted', from: null },
      { path: 'scratch', staged: null, unstaged: 'untracked', from: null }
    ])
  })

  test('a rename consumes the extra record that carries its source', () => {
    const files = parseStatusPorcelain('R  new.ts\0old.ts\0M  after.ts\0')
    assert.deepEqual(files, [
      { path: 'new.ts', staged: 'renamed', unstaged: null, from: 'old.ts' },
      // The entry after the rename must not be eaten by it.
      { path: 'after.ts', staged: 'modified', unstaged: null, from: null }
    ])
  })

  test('every unmerged combination is one conflicted state, not two sides', () => {
    for (const code of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      const [f] = parseStatusPorcelain(`${code} both.ts\0`)
      assert.equal(f.staged, 'conflicted', code)
      assert.equal(f.unstaged, 'conflicted', code)
    }
  })

  test('ignored entries are dropped, and short records cannot crash it', () => {
    assert.deepEqual(parseStatusPorcelain('!! build/\0'), [])
    assert.deepEqual(parseStatusPorcelain(''), [])
    assert.deepEqual(parseStatusPorcelain('M\0'), [])
  })

  test('ahead/behind reads left-right counts in git order', () => {
    // `--left-right --count upstream...HEAD` prints behind, then ahead.
    assert.deepEqual(parseAheadBehind('2\t5\n'), { ahead: 5, behind: 2 })
    assert.deepEqual(parseAheadBehind(''), { ahead: 0, behind: 0 })
  })
})

describe('status, against real git', { skip: gitMissing ? 'Session-host Git is unavailable (Windows requires WSL)' : false }, () => {
  test('a clean repository reports no files and knows its branch', async () => {
    const dir = await makeRepo()
    const status = await readStatus(runGit, dir)
    assert.equal(status.root, dir)
    assert.equal(status.branch, 'main')
    assert.equal(status.unborn, false)
    assert.equal(status.upstream, null)
    assert.deepEqual(status.files, [])
  })

  test('a path with a space in it survives, unquoted and unescaped', async () => {
    const dir = await makeRepo()
    write(dir, 'my notes/a b.md', 'hello\n')
    const status = await readStatus(runGit, dir)
    // Without `-z` git would hand back `"my notes/a b.md"` with the quotes.
    assert.ok(fileIn(status, 'my notes/a b.md'), JSON.stringify(status.files))
    assert.equal(fileIn(status, 'my notes/a b.md').unstaged, 'untracked')
  })

  test('staged and then edited again shows both, from real porcelain', async () => {
    const dir = await makeRepo({ 'app.ts': 'one\n' })
    write(dir, 'app.ts', 'two\n')
    await stagePaths(runGit, dir, ['app.ts'])
    write(dir, 'app.ts', 'three\n')

    const f = fileIn(await readStatus(runGit, dir), 'app.ts')
    assert.equal(f.staged, 'modified')
    assert.equal(f.unstaged, 'modified')
  })

  test('a rename git detects arrives with its source', async () => {
    const dir = await makeRepo({ 'old.ts': 'a\nb\nc\nd\ne\nf\n' })
    await runGit(['mv', 'old.ts', 'new.ts'], dir)
    const f = fileIn(await readStatus(runGit, dir), 'new.ts')
    assert.equal(f.staged, 'renamed')
    assert.equal(f.from, 'old.ts')
  })

  test('a repository with no commit yet is unborn, not broken', async () => {
    const dir = await makeUnborn()
    write(dir, 'first.ts', 'hello\n')
    const status = await readStatus(runGit, dir)
    assert.equal(status.unborn, true)
    assert.equal(status.ahead, 0)
    assert.equal(status.behind, 0)
    assert.equal(fileIn(status, 'first.ts').unstaged, 'untracked')
  })

  test('a directory outside any repository is null, which is an answer', async () => {
    assert.equal(await readStatus(runGit, fs.realpathSync(tempDir('term-bare-'))), null)
  })
})

describe('diffs', { skip: gitMissing ? 'Session-host Git is unavailable (Windows requires WSL)' : false }, () => {
  test('worktree and staged are different questions', async () => {
    const dir = await makeRepo({ 'app.ts': 'one\n' })
    write(dir, 'app.ts', 'staged\n')
    await stagePaths(runGit, dir, ['app.ts'])
    write(dir, 'app.ts', 'worktree\n')

    const staged = await readDiff(runGit, dir, { side: 'staged', file: 'app.ts' })
    assert.ok(staged.patch.includes('+staged'))
    assert.ok(!staged.patch.includes('+worktree'))
    assert.equal(staged.label, 'Staged')

    const tree = await readDiff(runGit, dir, { side: 'worktree', file: 'app.ts' })
    assert.ok(tree.patch.includes('+worktree'))
    assert.ok(tree.patch.includes('-staged'))
  })

  test('an untracked file diffs against nothing rather than failing', async () => {
    const dir = await makeRepo()
    write(dir, 'fresh.ts', 'brand new\n')
    // `git diff --no-index` exits 1 when the files differ, which is always.
    const res = await readDiff(runGit, dir, {
      side: 'worktree',
      file: 'fresh.ts',
      untracked: true
    })
    assert.ok(res.patch.includes('+brand new'))
    assert.equal(res.label, 'New file')
  })

  test('an untracked diff without a file is refused', async () => {
    const dir = await makeRepo()
    await assert.rejects(
      () => readDiff(runGit, dir, { side: 'worktree', file: null, untracked: true }),
      /needs a file/
    )
  })

  test('a branch diff is taken from the merge base, not the branch tip', async () => {
    const dir = await makeRepo({ 'app.ts': 'base\n' })
    await runGit(['checkout', '-q', '-b', 'feature'], dir)
    write(dir, 'app.ts', 'feature work\n')
    await stagePaths(runGit, dir, ['app.ts'])
    await commitStaged(runGit, dir, 'feature commit')

    // main moves on after the fork. A naive `main..HEAD` would report this
    // file as something the feature branch deleted.
    await runGit(['checkout', '-q', 'main'], dir)
    write(dir, 'unrelated.ts', 'landed on main later\n')
    await stagePaths(runGit, dir, ['unrelated.ts'])
    await commitStaged(runGit, dir, 'later work on main')
    await runGit(['checkout', '-q', 'feature'], dir)

    const res = await readDiff(runGit, dir, { side: 'branch', file: null, base: 'main' })
    assert.ok(res.patch.includes('+feature work'))
    assert.ok(!res.patch.includes('unrelated.ts'), res.patch)
    assert.equal(res.label, 'main…working tree')
  })

  test('a branch diff includes what is still uncommitted', async () => {
    const dir = await makeRepo({ 'app.ts': 'base\n' })
    await runGit(['checkout', '-q', '-b', 'feature'], dir)
    write(dir, 'app.ts', 'committed\n')
    await stagePaths(runGit, dir, ['app.ts'])
    await commitStaged(runGit, dir, 'work')
    write(dir, 'app.ts', 'and still editing\n')

    const res = await readDiff(runGit, dir, { side: 'branch', file: null, base: 'main' })
    assert.ok(res.patch.includes('+and still editing'))
  })

  test('a branch diff with nothing to compare against is refused', async () => {
    const dir = await makeRepo()
    await assert.rejects(
      () => readDiff(runGit, dir, { side: 'branch', file: null, base: '' }),
      /No branch to compare/
    )
  })

  test('an oversized patch is cut at a line boundary and says so', async () => {
    const dir = await makeRepo()
    const line = 'x'.repeat(99) + '\n'
    write(dir, 'big.txt', line.repeat(Math.ceil((MAX_PATCH_BYTES * 1.2) / line.length)))
    const res = await readDiff(runGit, dir, {
      side: 'worktree',
      file: 'big.txt',
      untracked: true
    })
    assert.equal(res.truncated, true)
    assert.ok(res.patch.length <= MAX_PATCH_BYTES + 1)
    // Cut mid-line, the last thing the reviewer reads is half a line of code.
    assert.ok(res.patch.endsWith('\n'))
    const lines = res.patch.split('\n')
    assert.equal(lines[lines.length - 2], `+${line.trimEnd()}`)
  })
})

describe('the three writes', { skip: gitMissing ? 'Session-host Git is unavailable (Windows requires WSL)' : false }, () => {
  test('stage and unstage move one path without touching the file', async () => {
    const dir = await makeRepo({ 'app.ts': 'one\n' })
    write(dir, 'app.ts', 'two\n')

    await stagePaths(runGit, dir, ['app.ts'])
    assert.equal(fileIn(await readStatus(runGit, dir), 'app.ts').staged, 'modified')

    await unstagePaths(runGit, dir, ['app.ts'])
    const after = fileIn(await readStatus(runGit, dir), 'app.ts')
    assert.equal(after.staged, null)
    assert.equal(after.unstaged, 'modified')
    // The edit itself is still there — unstaging is not undoing.
    assert.equal(fs.readFileSync(path.join(dir, 'app.ts'), 'utf8'), 'two\n')
  })

  test('unstaging before the first commit does not reset against a HEAD that is not there', async () => {
    const dir = await makeUnborn()
    write(dir, 'first.ts', 'hello\n')
    await stagePaths(runGit, dir, ['first.ts'])
    assert.equal(fileIn(await readStatus(runGit, dir), 'first.ts').staged, 'added')

    await unstagePaths(runGit, dir, ['first.ts'])
    // Back to untracked, and still on disk.
    assert.equal(fileIn(await readStatus(runGit, dir), 'first.ts').unstaged, 'untracked')
    assert.equal(fs.existsSync(path.join(dir, 'first.ts')), true)
  })

  test('staging nothing is a no-op rather than `git add` with no paths', async () => {
    const dir = await makeRepo()
    write(dir, 'loose.ts', 'x\n')
    await stagePaths(runGit, dir, [])
    await unstagePaths(runGit, dir, [])
    // `git add --` with no pathspec would have staged everything.
    assert.equal(fileIn(await readStatus(runGit, dir), 'loose.ts').staged, null)
  })

  test('a commit takes what is staged and nothing else', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
    write(dir, 'a.ts', 'changed a\n')
    write(dir, 'b.ts', 'changed b\n')
    await stagePaths(runGit, dir, ['a.ts'])

    const res = await commitStaged(runGit, dir, 'only a\n\nbody line')
    assert.ok(res.sha)
    assert.equal(res.subject, 'only a')

    const status = await readStatus(runGit, dir)
    assert.equal(fileIn(status, 'a.ts'), null)
    assert.equal(fileIn(status, 'b.ts').unstaged, 'modified')
  })

  test('committing with nothing staged is refused, not attempted', async () => {
    const dir = await makeRepo()
    write(dir, 'unstaged.ts', 'x\n')
    await assert.rejects(() => commitStaged(runGit, dir, 'nope'), /Nothing is staged/)
    await assert.rejects(() => commitStaged(runGit, dir, '   '), /needs a message/)
  })
})

describe('addressed by session, not by directory', { skip: gitMissing ? 'Session-host Git is unavailable (Windows requires WSL)' : false }, () => {
  /** A GitReview over one fake session, the way main wires it. */
  function review(sessions) {
    return new GitReview({
      sessions: { get: (id) => sessions[id] },
      dataDir: tempDir('term-review-')
    })
  }

  test('an unknown session is refused before git is reached', async () => {
    const gr = review({})
    await assert.rejects(() => gr.status('nope'), /no longer exists/)
    await assert.rejects(() => gr.stage('nope', ['a.ts']), /no longer exists/)
    await assert.rejects(() => gr.push('nope'), /no longer exists/)
  })

  test('a path that leaves the repository is refused', async () => {
    const dir = await makeRepo()
    const gr = review({ s1: { id: 's1', cwd: dir, title: 'work', agent: 'claude' } })

    for (const bad of ['../outside.ts', 'a/../../outside.ts', '/etc/passwd', 'C:\\Windows\\x']) {
      await assert.rejects(() => gr.stage('s1', [bad]), /repository/, bad)
    }
    await assert.rejects(() => gr.stage('s1', ['']), /Invalid path/)
    // A dot segment that does not climb is fine — `./x` is still inside.
    await gr.stage('s1', ['./README.md'])
  })

  test('the review fork writes an applicable patch and a prompt that points at it', async () => {
    const dir = await makeRepo({ 'app.ts': 'one\n' })
    const gr = review({ s1: { id: 's1', cwd: dir, title: 'fix the parser', agent: 'claude' } })
    write(dir, 'app.ts', 'two\n')

    const out = await gr.patchFileFor({ sessionId: 's1', side: 'worktree', file: 'app.ts' })
    assert.equal(out.empty, false)
    const patch = fs.readFileSync(out.file, 'utf8')
    // Nothing is prepended, so `git apply` still accepts the file.
    assert.ok(patch.startsWith('diff --git '), patch.slice(0, 40))
    assert.ok(patch.includes('+two'))

    assert.ok(out.prompt.includes(out.file))
    assert.ok(out.prompt.includes('fix the parser'))
    assert.ok(out.prompt.includes('app.ts'))
    assert.ok(/not change any files/i.test(out.prompt))
  })

  test('a clean tree produces an empty patch, and says so rather than forking', async () => {
    const dir = await makeRepo()
    const gr = review({ s1: { id: 's1', cwd: dir, title: 'idle', agent: 'claude' } })
    const out = await gr.patchFileFor({ sessionId: 's1', side: 'worktree', file: null })
    assert.equal(out.empty, true)
  })

  test('a session outside a repository is a clear message, not a git error', async () => {
    const dir = fs.realpathSync(tempDir('term-bare-'))
    const gr = review({ s1: { id: 's1', cwd: dir, title: 'nowhere', agent: 'claude' } })
    assert.equal(await gr.status('s1'), null)
    await assert.rejects(
      () => gr.diff({ sessionId: 's1', side: 'worktree', file: null }),
      /not inside a git repository/
    )
  })
})
