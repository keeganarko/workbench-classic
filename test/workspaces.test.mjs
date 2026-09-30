import { toHostPath, toNativePath } from '../src/main/host.js'
/**
 * Projects, workspaces and worktrees — run against real git, not a fake.
 *
 * A stub of `git worktree add` would only prove that the stub matches the code
 * that calls it. The behaviour worth protecting is git's: that the main
 * checkout is untouched, that concurrent adds do not race on the repository
 * lock, and that a removal refuses when refusing is the safe answer.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  describeProject,
  isDirty,
  listWorktrees,
  normalizeRemote,
  parseWorktreeList,
  readHeadBranch,
  runGit,
  toBranchName,
  uniqueName
} from '../src/main/git.js'
import { WorkspaceManager, findRepos, projectIdFor } from '../src/main/workspaces.js'
import { tempDir } from './helpers.mjs'

/** A repository with one commit on `main`, in a throwaway directory. */
async function makeRepo(prefix = 'term-repo-', destination) {
  // Realpath because git reports resolved paths and macOS hands out a
  // symlinked temp dir — comparing the two spellings otherwise fails for
  // reasons that have nothing to do with the code under test.
  const dir = destination ?? fs.realpathSync(tempDir(prefix))
  fs.mkdirSync(dir, { recursive: true })
  await runGit(['init', '-b', 'main', '-q', '.'], dir)
  await runGit(['config', 'user.email', 'test@terminal.local'], dir)
  await runGit(['config', 'user.name', 'Workbench Test'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n')
  await runGit(['add', '.'], dir)
  await runGit(['commit', '-q', '-m', 'init'], dir)
  return dir
}

function manager(dataDir = tempDir('term-data-')) {
  let changes = 0
  const wm = new WorkspaceManager({
    git: runGit,
    dataDir,
    onChange: () => {
      changes += 1
    }
  })
  return { wm, dataDir, changed: () => changes }
}

const gitAvailable = (await runGit(['--version'], process.cwd())).code === 0

describe('reading a repository', () => {
  test('a repository reports its root, branch and shared git directory', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const info = await describeProject(runGit, repo)

    assert.ok(info)
    assert.equal(info.root, repo)
    assert.equal(info.branch, 'main')
    assert.equal(info.defaultBranch, 'main')
    assert.ok(path.isAbsolute(info.commonDir), 'the common dir is absolute')
    assert.ok(info.commonDir.endsWith('.git'))
  })

  test('a subdirectory resolves to the same project as the root', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const sub = path.join(repo, 'src', 'deep')
    fs.mkdirSync(sub, { recursive: true })

    const fromRoot = await describeProject(runGit, repo)
    const fromSub = await describeProject(runGit, sub)
    assert.equal(projectIdFor(fromSub.commonDir), projectIdFor(fromRoot.commonDir))
  })

  test('a plain folder is not a repository, and that is not an error', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    // Somewhere that is definitely not inside a checkout.
    assert.equal(await describeProject(runGit, tempDir('term-plain-')), null)
  })

  test('ssh and https forms of one remote compare equal', () => {
    assert.equal(normalizeRemote('git@github.com:me/app.git'), 'github.com/me/app')
    assert.equal(normalizeRemote('https://github.com/me/app'), 'github.com/me/app')
    assert.equal(normalizeRemote('https://token@github.com/Me/App.git/'), 'github.com/me/app')
    assert.equal(normalizeRemote('  '), null)
  })
})

describe('parsing the worktree list', () => {
  test('the first record is the main tree and branches lose their ref prefix', () => {
    const entries = parseWorktreeList(
      [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /elsewhere/feature',
        'HEAD def456',
        'branch refs/heads/feat/x',
        'locked',
        ''
      ].join('\n')
    )

    assert.equal(entries.length, 2)
    assert.equal(entries[0].isMain, true)
    assert.equal(entries[0].branch, 'main')
    assert.equal(entries[1].isMain, false)
    assert.equal(entries[1].branch, 'feat/x')
    assert.equal(entries[1].locked, true)
  })

  test('a detached worktree has no branch rather than a bogus one', () => {
    const entries = parseWorktreeList(
      ['worktree /repo', 'HEAD abc', 'branch refs/heads/main', '', 'worktree /d', 'HEAD abc', 'detached', ''].join(
        '\n'
      )
    )
    assert.equal(entries[1].branch, null)
    assert.equal(entries[1].head, 'abc')
  })

  test('empty output is an empty list, not a crash', () => {
    assert.deepEqual(parseWorktreeList(''), [])
  })
})

describe('naming', () => {
  test('a task title becomes a branch git will accept', () => {
    assert.equal(toBranchName('Fix the login bug!'), 'term/fix-the-login-bug')
    assert.equal(toBranchName('  ...  '), 'term/session')
    // The slug is capped at 40; the rest is the prefix and its slash.
    assert.equal(toBranchName('a'.repeat(80)), `term/${'a'.repeat(40)}`)
  })

  test('a taken name gets a suffix instead of colliding', () => {
    assert.equal(uniqueName('term/x', []), 'term/x')
    assert.equal(uniqueName('term/x', ['term/x']), 'term/x-2')
    assert.equal(uniqueName('term/x', ['term/x', 'term/x-2']), 'term/x-3')
  })
})

describe('adopting a folder as it stands', () => {
  test('a repository checkout becomes a main workspace nobody may delete', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const { wm } = manager()
    const ws = await wm.adopt(repo)

    assert.equal(ws.kind, 'main')
    assert.equal(ws.branch, 'main')
    assert.equal(ws.createdByApp, false, 'the app did not make this checkout')
    assert.equal(wm.listProjects().length, 1)

    const res = await wm.remove(ws.id)
    assert.equal(res.removed, false)
    assert.ok(fs.existsSync(repo), 'the folder is still there')
  })

  test('a plain folder is a workspace with no project', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const dir = tempDir('term-plain-')
    const { wm } = manager()
    const ws = await wm.adopt(dir)

    assert.equal(ws.kind, 'local')
    assert.equal(ws.projectId, null)
    assert.equal(wm.listProjects().length, 0)
  })

  test('adopting the same folder twice is the same workspace', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const { wm } = manager()
    assert.equal((await wm.adopt(repo)).id, (await wm.adopt(repo)).id)
  })
})

describe('starting two agents', () => {
  test('"the folder as it stands" hands both agents the same workspace', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const { wm } = manager()
    const [a, b] = await wm.create({ cwd: repo, mode: 'current' }, 2)

    assert.equal(a.id, b.id)
    assert.equal(a.path, repo)
  })

  test('"one shared worktree" isolates from the main checkout but not from each other', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const { wm } = manager()
    const [a, b] = await wm.create({ cwd: repo, mode: 'shared', title: 'Try the fix' }, 2)

    assert.equal(a.id, b.id, 'both agents get the same workspace')
    assert.notEqual(a.path, repo, 'and it is not the main checkout')
    assert.equal(a.branch, 'term/try-the-fix')
    assert.equal(a.createdByApp, true)
    assert.ok(fs.existsSync(path.join(a.path, 'README.md')), 'the worktree has the files')

    // The whole promise of the mode: your own checkout did not move.
    const after = await describeProject(runGit, repo)
    assert.equal(after.branch, 'main')
    assert.equal(await isDirty(runGit, repo), false)
  })

  test('"parallel attempts" gives each agent its own branch', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const { wm } = manager()
    const [a, b] = await wm.create({ cwd: repo, mode: 'isolated', title: 'Race' }, 2)

    assert.notEqual(a.id, b.id)
    assert.notEqual(a.path, b.path)
    assert.notEqual(a.branch, b.branch)

    // An edit in one attempt is invisible to the other — that is the point.
    fs.writeFileSync(path.join(a.path, 'README.md'), '# changed by attempt one\n')
    assert.equal(fs.readFileSync(path.join(b.path, 'README.md'), 'utf8'), '# repo\n')
    assert.equal(await isDirty(runGit, repo), false, 'and the main checkout is still clean')
  })

  test('isolation is refused out loud when there is no repository to branch', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const { wm } = manager()
    await assert.rejects(
      () => wm.create({ cwd: tempDir('term-plain-'), mode: 'isolated', title: 'x' }, 2),
      /not a Git repository/
    )
  })

  test('worktrees live outside the repository, never inside it', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const { wm, dataDir } = manager()
    const [ws] = await wm.create({ cwd: repo, mode: 'shared', title: 'Outside' }, 1)

    assert.ok(ws.path.startsWith(path.join(dataDir, 'worktrees')))
    assert.equal(ws.path.startsWith(repo), false)
  })
})

describe('concurrent worktree creation', () => {
  test('four at once all succeed on distinct branches', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    // Unserialized, these race on the repository lock and one of them dies with
    // a `.git/worktrees.lock` error that means nothing to the person reading it.
    const repo = await makeRepo()
    const { wm } = manager()

    const made = await Promise.all(
      ['one', 'two', 'three', 'four'].map((name) =>
        wm.create({ cwd: repo, mode: 'shared', title: name }, 1).then((r) => r[0])
      )
    )

    assert.equal(new Set(made.map((w) => w.branch)).size, 4)
    assert.equal(new Set(made.map((w) => w.path)).size, 4)
    for (const ws of made) assert.ok(fs.existsSync(ws.path))
    // git agrees: the main tree plus four.
    assert.equal((await listWorktrees(runGit, repo)).length, 5)
  })

  test('two workspaces from the same title do not collide', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const { wm } = manager()
    const [a] = await wm.create({ cwd: repo, mode: 'shared', title: 'Same' }, 1)
    const [b] = await wm.create({ cwd: repo, mode: 'shared', title: 'Same' }, 1)

    assert.equal(a.branch, 'term/same')
    assert.equal(b.branch, 'term/same-2')
  })
})

describe('removing a workspace', () => {
  test('a clean workspace Workbench made is removed, and its branch survives', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const { wm } = manager()
    const [ws] = await wm.create({ cwd: repo, mode: 'shared', title: 'Done' }, 1)

    const res = await wm.remove(ws.id)
    assert.equal(res.removed, true)
    assert.equal(fs.existsSync(ws.path), false)
    assert.equal(wm.get(ws.id), undefined)

    // Committed work is never destroyed as a side effect of tidying up.
    const branch = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${ws.branch}`], repo)
    assert.equal(branch.code, 0, 'the branch is still there')
  })

  test('a workspace with uncommitted work is refused, and says where the work is', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const { wm } = manager()
    const [ws] = await wm.create({ cwd: repo, mode: 'shared', title: 'Busy' }, 1)
    fs.writeFileSync(path.join(ws.path, 'notes.md'), 'an hour of work\n')

    const res = await wm.remove(ws.id)
    assert.equal(res.removed, false)
    assert.match(res.reason, /uncommitted/i)
    assert.equal(res.path, ws.path, 'the caller can tell the user where to look')
    assert.equal(fs.readFileSync(path.join(ws.path, 'notes.md'), 'utf8'), 'an hour of work\n')
  })

  test('an explicit confirmation removes it', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const { wm } = manager()
    const [ws] = await wm.create({ cwd: repo, mode: 'shared', title: 'Busy' }, 1)
    fs.writeFileSync(path.join(ws.path, 'notes.md'), 'throwaway\n')

    const res = await wm.remove(ws.id, { force: true })
    assert.equal(res.removed, true)
    assert.equal(fs.existsSync(ws.path), false)
  })

  test('a worktree Workbench did not create is never removed, even with force', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const theirs = path.join(tempDir('term-theirs-'), 'wt')
    await runGit(['worktree', 'add', '-q', '-b', 'their-branch', toHostPath(theirs)], repo)

    const { wm } = manager()
    const ws = await wm.adopt(theirs)
    assert.equal(ws.kind, 'worktree')
    assert.equal(ws.createdByApp, false)

    for (const opts of [{}, { force: true }]) {
      const res = await wm.remove(ws.id, opts)
      assert.equal(res.removed, false)
      assert.match(res.reason, /did not create/)
    }
    assert.ok(fs.existsSync(theirs), 'their worktree is untouched')
  })

  test('removing something that is already gone is a refusal, not a throw', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const { wm } = manager()
    const res = await wm.remove('ws_nope')
    assert.equal(res.removed, false)
    assert.match(res.reason, /No such workspace/)
  })
})

describe('surviving a restart', () => {
  test('a workspace whose directory the user deleted by hand is dropped', async (t) => {
    if (!gitAvailable) return t.skip('git is not installed')
    const repo = await makeRepo()
    const { wm } = manager()
    const [kept] = await wm.create({ cwd: repo, mode: 'shared', title: 'Kept' }, 1)
    const [gone] = await wm.create({ cwd: repo, mode: 'shared', title: 'Gone' }, 1)
    fs.rmSync(gone.path, { recursive: true, force: true })

    const next = manager().wm
    next.load(wm.listProjects(), wm.list())

    assert.ok(next.get(kept.id), 'the one still on disk is restored')
    assert.equal(next.get(gone.id), undefined, 'the one that vanished is not')
  })
})

/**
 * The drawer case: `~/Dev` is not a repository, it is six repositories in a
 * folder. Pointing the dialog there used to be a dead end.
 */
describe('finding repositories inside a folder', { skip: !gitAvailable ? 'Session-host Git is unavailable (Windows requires WSL)' : false }, () => {
  test('lists the subdirectories that are repositories, and only those', async () => {
    const drawer = fs.realpathSync(tempDir('term-drawer-'))
    await makeRepo('unused', path.join(drawer, 'beta'))
    fs.mkdirSync(path.join(drawer, 'alpha-plain'), { recursive: true })
    fs.writeFileSync(path.join(drawer, 'loose.txt'), 'not a folder\n')

    const found = findRepos(drawer)
    assert.deepEqual(
      found.map((r) => r.name),
      ['beta'],
      'the plain folder and the loose file are left out'
    )
    assert.equal(found[0].path, path.join(drawer, 'beta'))
  })

  test('sorts by name, case-insensitively', async () => {
    const drawer = fs.realpathSync(tempDir('term-drawer-'))
    for (const name of ['Zebra', 'apple', 'Mango']) {
      await makeRepo('unused', path.join(drawer, name))
    }
    assert.deepEqual(
      findRepos(drawer).map((r) => r.name),
      ['apple', 'Mango', 'Zebra']
    )
  })

  test('finds a worktree checkout, whose .git is a file rather than a folder', async () => {
    const drawer = fs.realpathSync(tempDir('term-drawer-'))
    const repo = await makeRepo()
    const wt = path.join(drawer, 'feature')
    await runGit(['worktree', 'add', '-b', 'feature', toHostPath(wt), 'main'], repo)

    assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'precondition: .git is a file here')
    assert.deepEqual(
      findRepos(drawer).map((r) => r.name),
      ['feature'],
      'a checkout created by Workbench itself must not be invisible'
    )
  })

  test('skips dotfolders, and answers nothing for a folder it cannot read', async () => {
    const drawer = fs.realpathSync(tempDir('term-drawer-'))
    // Create the fixture where it will be discovered. Copying an active .git
    // tree can race Git's background maintenance on APFS; discovery needs a
    // hidden repository, not a snapshot of another repository's object store.
    await makeRepo('unused', path.join(drawer, '.hidden'))

    assert.deepEqual(findRepos(drawer), [], 'a dotfolder is not offered')
    assert.deepEqual(findRepos(path.join(drawer, 'nope')), [], 'a missing folder does not throw')
  })
})

describe('which branch a checkout is on, right now', () => {
  test('reads the branch, and follows a checkout the app did not make', async (t) => {
    if (!gitAvailable) return t.skip('git not available')
    const dir = await makeRepo('term-head-')
    assert.equal(readHeadBranch(dir), 'main')

    // The whole point: someone switched branches outside Workbench.
    await runGit(['checkout', '-q', '-b', 'feature/x'], dir)
    assert.equal(readHeadBranch(dir), 'feature/x')
  })

  test('a detached HEAD reports the object id rather than a stale branch', async (t) => {
    if (!gitAvailable) return t.skip('git not available')
    const dir = await makeRepo('term-detached-')
    const head = (await runGit(['rev-parse', 'HEAD'], dir)).stdout.trim()
    await runGit(['checkout', '-q', '--detach'], dir)
    // Not null: "you are not on a branch" is exactly what the footer must say.
    assert.equal(readHeadBranch(dir), head.slice(0, 7))
  })

  test('a linked worktree reports its own branch, not the main checkout it shares a .git with', async (t) => {
    if (!gitAvailable) return t.skip('git not available')
    const dir = await makeRepo('term-linked-')
    const tree = path.join(fs.realpathSync(tempDir('term-linked-tree-')), 'wt')
    await runGit(['worktree', 'add', '-q', '-b', 'side', toHostPath(tree)], dir)
    assert.equal(readHeadBranch(dir), 'main')
    assert.equal(readHeadBranch(tree), 'side')
  })

  test('a folder that is not a repository is not an error', () => {
    assert.equal(readHeadBranch(tempDir('term-nonrepo-')), null)
    assert.equal(readHeadBranch(path.join(tempDir('term-gone-'), 'nope')), null)
  })

  test('listLive overrides the recorded branch, and list does not', async (t) => {
    if (!gitAvailable) return t.skip('git not available')
    const dir = await makeRepo('term-live-')
    const { wm } = manager()
    const ws = await wm.adopt(dir)
    assert.equal(ws.branch, 'main')

    await runGit(['checkout', '-q', '-b', 'moved'], dir)
    assert.equal(wm.list().find((w) => w.id === ws.id).branch, 'main')
    assert.equal(wm.listLive().find((w) => w.id === ws.id).branch, 'moved')
  })

  test('a workspace with no repository behind it keeps its null branch', async () => {
    const { wm } = manager()
    const ws = await wm.adopt(tempDir('term-plainfolder-'))
    assert.equal(ws.projectId, null)
    assert.equal(wm.listLive().find((w) => w.id === ws.id).branch, null)
  })
})
