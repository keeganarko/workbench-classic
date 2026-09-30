# Files and Search

Two read-only views of the folder the focused agent is working in. They sit in
the sidebar next to Sessions and Source Control, and like Source Control they
**follow the focused pane** rather than holding a folder of their own — the
question worth answering is "what is *this* agent working on", not "what is in
some directory I picked an hour ago".

Neither panel writes, runs, renames, deletes, or drags anything. Editing files
is what the agent in the next pane is for.

## Files

A lazy tree of the session's working directory. Click a folder to open it, a
file to render it in the preview pane.

Three things are deliberately absent:

- **Generated folders.** `node_modules`, `dist`, `build`, `out`, `target`,
  `.git`, `.venv`, `.next` and the rest of the list in `main/preview.ts` never
  appear. `node_modules` alone is usually more files than the project that
  depends on it.
- **Symlinks.** Dropped rather than followed. A link is either a cycle waiting
  to happen or a way out of the session's folder, and a file tree is not the
  place to litigate which.
- **Sizes and timestamps.** The tree does not show them, so it does not `stat`
  a thousand entries to learn them.

Dot-files and dot-folders **are** shown, minus the generated ones — `.github`
and `.claude` are things people look for.

Folders load when you open them. A tree that read the whole project to draw its
first row would spend a second on folders nobody wanted.

### Git decoration

When the folder is inside a repository, changed files carry a letter in the
same colours the Source Control panel uses — `M`, `A`, `D`, `R`, `U` — and a
closed folder carries a dot when something inside it changed. The working-tree
side wins over the index, because it is the newer fact.

Git counts paths from the repository root and the tree counts from the
session's folder, and those are the same directory only when the agent happened
to be started at the top of the repo. `treeMarks` in `src/shared/files.ts` is
the translation, and it drops changes that sit above the session's folder —
they are not in this tree at all.

A folder that is not a repository still has a perfectly good tree. Decoration
is a bonus, not a requirement.

## Search

Type in the box; matches appear grouped by file, with the line number and the
matching line. Clicking one opens that file in the preview pane. `⌘⇧F` opens
the panel from anywhere. Searching a session's scrollback remains available
from the Edit menu and command palette.

### Literal text, not a pattern

This is a deliberate limit, not an unfinished feature. A regular expression
typed into the sidebar would be compiled and run **inside the process that also
drives every terminal in the window**, and one accidental backtrack would
freeze all of them at once. Substring matching cannot do that, and it is what
the box gets used for anyway.

Case-insensitive by default; `Aa` makes it exact.

### No ripgrep

The obvious implementation shells out to `rg`, and the plan said so. But `rg`
is not on a normal macOS or Ubuntu machine, and this project cannot add a
dependency to put it there. A search that works for the people who happen to
have installed a Rust CLI is worse than one that works for everybody, and the
difference on a project-sized tree is tens of milliseconds — this repository
answers in about 8ms.

So the sweep is written here, with bounds:

| Limit | Value | Why |
| --- | --- | --- |
| File size | 2 MB | The preview pane's own text limit. If the pane would not render it as text, the search does not read it as text. |
| Files | 6000 | Past this, the answer would be a list, not an answer. |
| Depth | 12 | |
| Matches | 300 total, 20 per file | One minified bundle cannot fill the result. |

Files with a NUL byte in their first 4 KB are binary and are skipped — a text
search does not want them, and splitting one on newlines produces nonsense.

**What this costs, stated rather than hidden:** `.gitignore` is not read. The
skip list removes the folders that account for nearly all of what a repository
ignores, but a `coverage/` or a stray `.env.local` will turn up. Reading the
ignore rules properly means either a parser or a `git ls-files` subprocess, and
neither is worth it until the skip list is demonstrably not enough.

### Not blocking the window

Every read is async, and that is load-bearing rather than stylistic. This runs
on the main process, which is also forwarding terminal output to every pane; a
synchronous sweep of a few thousand files would stall the whole window for as
long as it took. Twelve files are read at a time — enough to keep the disk
busy, few enough that the event loop gets a turn between them.

Typing produces a search per keystroke even behind the 250 ms debounce, and the
main process cannot abandon work it has already started unless the work asks.
Each sweep checks whether a newer one has begun and stops at its next file
boundary if so. The renderer was going to throw that answer away regardless;
this stops it from being paid for.

## What they can reach

The same authorisation model as the Git panel, for the same reason:

> **Every call names a session, never a directory.** The renderer cannot ask
> for the contents of a folder; it can only name a session it can already see,
> and the working directory comes off the session record in main.

A relative path in a `files:list` payload can only ever *narrow* that folder.
Three separate ways out are closed in `resolveInside`:

1. an absolute path, rejected before touching the disk;
2. a `..` that climbs past the root, likewise;
3. a symlink that resolves outside it — which needs a real `realpath`, because
   `path.resolve` is string arithmetic and knows nothing about links.

Search has no path parameter at all.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `src/shared/files.ts` | Sorting, excerpting, and restating git's paths in the tree's terms |
| `src/main/files.ts` | Listing, containment, and the sweep |
| `src/main/preview.ts` | Owns `SKIP_DIRS` and `isInsideRoot`, shared with the pane's own scan |
| `src/main/ipc.ts` | `files:list` and `files:search`, both session-addressed |
| `src/renderer/src/components/FileTree.tsx` | The tree |
| `src/renderer/src/components/SearchPanel.tsx` | The search box and results |
| `src/renderer/src/components/PanelEmpty.tsx` | What all three panels show when there is nothing to show |
| `test/files.test.mjs` | The rules above, pinned |
