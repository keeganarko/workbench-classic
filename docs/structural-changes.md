# When you rename or delete something structural

For the agent, and for whoever is driving it.

A structural change — renaming a branch, deleting one, moving a directory,
renaming an npm script, changing a path convention — is not finished when the
thing has its new name. It is finished when everything that *named* the old one
has been updated too.

That sounds obvious. The reason it needs writing down is that almost every one
of these failures is **silent**. Nothing throws. No test goes red. A CI trigger
pointed at a branch that no longer exists does not error — it matches nothing,
runs nothing, and reports nothing, which looks exactly like a green repository
until the day you need a check to have caught something.

So the rule is: **after any structural change, grep for the old name before you
call the work done.** Not because you think you missed something. Because the
places that break are the places nobody thinks about.

    git grep -n '<the old name>'
    git grep -n '<the old name>' -- .github/    # triggers and required checks
    ls -a && git grep -n '<the old name>' -- '*.json' '*.yml' '*.md'

Include untracked local notes if the change is worth recording (`context/`),
and remember `.git/info/exclude`, which `git grep` does not see.

---

## What silently breaks, by kind of change

| You changed | What stops working without saying so |
| --- | --- |
| a branch name | `.github/workflows/*.yml` push triggers; every other machine's upstream ref; the default-branch setting; branch protection rules, which are matched by name |
| the default branch | fresh clones; where new PRs target; `origin/HEAD`, until someone runs `git remote set-head origin -a` |
| deleted a branch | any open PR from it is **closed**, and reads as abandoned unless someone says where the work went |
| a directory or file | imports resolve by path, so those *do* error — but docs, `package.json` globs, `.gitignore`, and CI `paths:` filters do not |
| an npm script | `docs/*.md`, CI steps, and this file's own instructions |
| a path convention | `docs/preview.md`, `docs/branching.md`, and the agent policy in `AGENTS.md` |

The pattern: **code fails loudly, configuration and prose fail quietly.** Spend
the sweep on the quiet half.

---

## Renaming a branch, end to end

The branch is the case that comes up most, and it has a step people forget on
each of the two machines.

On the machine doing the rename:

    git push origin <old>:<new>          # create the new name first
    gh repo edit --default-branch <new>  # only if <old> was the default
    git push origin --delete <old>       # a default branch cannot be deleted
    git branch -m <old> <new>
    git branch -u origin/<new>
    git fetch --prune origin
    git remote set-head origin -a

Then update `.github/workflows/quality.yml`'s `branches:` list **in the same
commit**, so the repository is never in a state where a push runs no checks.
Note that `quality.yml` also has job ids named after platforms (`macos:`,
`wslg-linux:`) — those are job names, not branches, and renaming them would
break any required-check list that refers to them. Leave them alone.

On the *other* machine, later:

    git fetch --prune origin
    git branch -m <old> <new>
    git branch -u origin/<new>

Without that last line the branch tracks a ref that no longer exists, and
`git push` starts asking for arguments it used to infer.

### The one that bites: case-only renames

If old and new differ only in case — `windows` → `Windows` — then on macOS and
on Windows, where the filesystem is case-insensitive, git cannot hold both
names at once and `git branch -m` can leave the ref in a confused state. Rename
through a third name:

    git branch -m windows tmp-rename
    git branch -m tmp-rename Windows

GitHub's refs *are* case-sensitive, so the remote side needs no such dance —
only the local checkouts do. This machine's checkout lives on ext4 inside WSL
and is not affected; the MacBook is.

---

## Deleting a branch

Check containment before deleting, and record the tip either way:

    git merge-base --is-ancestor origin/<branch> origin/<the branch you keep> \
      && echo "contained — the name is all you are deleting" \
      || echo "NOT contained — it holds work that exists nowhere else"

A branch that is not contained holds work. Merge it, cherry-pick it, or write
its tip SHA into `docs/branching.md` before the name goes away. A commit is
recoverable exactly as long as somebody can still name it.

If the branch had an open PR, deleting it closes that PR. Leave a comment
saying where the work actually went — otherwise the history reads as abandoned,
and the next person re-does it. GitHub keeps a closed PR's head commits
reachable forever:

    git fetch origin refs/pull/<n>/head:<a-local-name>

---

## The Windows build copy

A Windows folder such as `C:\Users\you\Dev\workbench-win` is a hand-synced copy, not a checkout, so it
does not follow a rename, a branch switch, or a `git pull`. Any structural
change has to be re-synced into it by hand before the next `npm run dist:win`,
or the installer ships the old shape and nothing says otherwise.
`docs/branching.md` has the reason it exists.

---

## Say what you changed

End a structural change by telling the user, in the answer, the commands *they*
have to run on their other machine. They cannot infer the `git branch -u` from
a green build, and nothing will remind them.
