# The preview pane

The pane on the right of the window renders what an agent just produced: a
report, a table, a chart, a generated page. It exists because half of an agent's
output is not terminal text, and leaving the app to look at the other half
breaks the loop the app is for.

It is a **viewer**, not an editor. Nothing it shows can be changed from inside
it.

---

## What it renders

| Kind | Extensions | How it is shown |
| --- | --- | --- |
| Markdown | `.md` `.markdown` `.mdx` | Rendered to HTML here, then displayed as an inert document |
| HTML artifact | `.html` `.htm` | Loaded as a real page, with its own scripts running |
| Image | `.png` `.jpg` `.gif` `.webp` `.avif` `.bmp` `.ico` | An `<img>` on a checkerboard, so transparency reads as transparency |
| Vector | `.svg` | An `<img>`, which cannot run the script an SVG is allowed to carry |
| PDF | `.pdf` | Chromium's built-in viewer |
| Table | `.csv` `.tsv` | Parsed and rendered as a table with row numbers |
| Data | `.json` | Pretty-printed |
| Diff | `.patch` `.diff` | Parsed and rendered with line numbers on both sides |
| Live | *(no file — a `http://localhost:…` address)* | Loaded as a real page, like an artifact |
| Text | `.txt` `.log` `.yaml`, source files, and similar | Shown as-is in a monospaced block |

Anything else is refused by name rather than opened and guessed at.

**Diagrams.** A diagram arrives as an `.svg` file or as an `.html` artifact that
draws its own — both render. Mermaid code fences inside a Markdown file are
shown as code, not as a diagram: rendering them needs Mermaid and its layout
engines, which is several megabytes of dependency in an app that has none. See
"Why no dependencies" below.

**Diffs, with and without a file.** A `.patch` file opened off disk and a diff
the source-control panel generated are the same kind and render through the same
code. The generated one has no file behind it, which `PreviewDoc.virtual` marks:
there is nothing to watch, nothing to open in a system app, and no path to type
into a session, so the pane hides those controls. Refresh on a virtual document
re-runs the git query instead of re-reading a file — which is also what makes
the button mean the right thing after you stage something.

**A dev server.** The one kind with no file behind it and no path to classify.
It is created by `preview.openUrl`, never by `classifyPreview`, and it behaves
exactly like an HTML artifact: a real page on its own origin, running its own
script, with no access to this window. See "A local server in the pane" below
for how one gets there and what confines it.

## Getting something on screen

- **By itself**, when a session finishes a turn that produced a document — see
  below. The pane belongs to the focused chat; a background one gets a mark in
  the sidebar instead of the screen.
- **An agent asking for it** — `workbench show <path>`, from inside any session.
- **Open a file…** — the folder button in the pane header, `⌘⌥O`, or the command
  palette.
- **Drop a file** onto the pane.
- **The recents list** — an empty pane lists the previewable files that changed
  most recently under the focused session's working directory, which is usually
  the answer to "what did it just write".
- **A filename in the source-control panel**, which opens that file's diff.
- **A link inside a rendered document** — another local document opens in the
  pane, rendered; a web link opens in the system browser.
- **A dev server a session started** — a toast offers it, and the address stays
  in that session's pane footer afterwards.

`⌘P`, or the button at the top right of the window, shows and hides the pane. Its width is remembered.

## Using a file outside Workbench

An open document has a labeled action row directly above it:

- **Open** opens the original with the system app.
- **Save a copy** opens the native save dialog, starting in Downloads with the
  original filename. It copies the complete file, including binary images;
  cancelling leaves everything as it was.
- **Show in folder** selects the original in Finder or Explorer.
- **Drag file** drags the original into another app or an upload area. Images
  can also be dragged directly from the preview. The receiving app decides
  whether it accepts the file.

The Files tree also has an **Open** button beside each file and folder, and
beside the root folder. Clicking the name still previews a file or expands a
folder. These actions are explicit user interactions; documents inside the
preview frame cannot invoke them. Live URLs and virtual diffs have no original
file, so they do not show file actions.

Agents should copy generated images into the session's working folder before
using `workbench show <path>`. A tool's private generated-image directory is
outside the normal output scan. Keep copies that are only for local use in the
project's ignored artifacts directory when one exists.

Native drag implementation follows Electron's
[file drag documentation](https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop).

## A conversation as a visual canvas

`⌘F` (`Ctrl+F` on Windows/Linux) opens a visual pane to the right of the
focused pane. It launches a dedicated Codex session in the focused pane's
working folder, pinned to `gpt-5.6-luna` with low reasoning effort so iterative
visual turns favour latency. Those launch settings belong only to the canvas;
ordinary coding sessions are untouched. The pane is a normal layout leaf — the
same border, focus, resizing, arrangement, zoom and close behavior — with its
terminal presentation replaced by an artifact canvas and a prompt box. The
latest visual from the focused conversation is carried in when one exists. If
Codex cannot start, the pane falls back to mirroring the focused conversation
and reports that degraded mode.

Each direction is wrapped in a small presentation contract before it reaches
the CLI: scene and "show me" requests must use one self-contained animated HTML
artifact unless the user explicitly asks for a static format; visible motion
starts within one second and combines subject, secondary and environmental
movement. Moving scenes must animate the subject's position or geometry rather
than panning or decorating a static image. Follow-ups receive the exact current
artifact path, and the agent runs `workbench show <path>` when ready. The
agent's ordinary terminal response continues to exist in its durable tmux
session, but the visual pane never renders that transcript. A visual
artifact named by `workbench show` arrives immediately; the normal end-of-turn
scan is the fallback and remains active for visual sessions even when automatic
opening of the document dock is disabled.

The latest artifact path and a monotonically increasing revision live on the
pane leaf. The path makes the canvas survive an app restart, and the revision
forces a real frame navigation when the agent rewrites the same file. Reading
still goes through `PreviewServer.open`, so a visual pane has exactly the same
realpath, workspace-root and size boundaries as the document dock. It does not
take over the dock's one continuous file watcher; explicit show and turn events
are its refresh boundary.

The image/terminal button in the pane header changes presentation without
moving the session or discarding the artifact. It is also the escape hatch for
an interactive permission screen: waiting and failure states are surfaced over
the canvas, with a direct route back to the terminal. Find in Session moves off
`⌘F` but remains available from the Edit menu and command palette.

## One pane, one document per chat

There is a single preview pane, and what it holds belongs to the **focused
chat**. Focus session A and you see A's latest document; focus B and the pane
switches to B's. Each chat keeps its own, so the answer to "what did this agent
show me" is always one click away, on the chat that showed it.

That is what makes several agents working at once bearable. A background
session finishing a turn renders its document into its own slot and stops
there: a small document mark appears on its row in the sidebar, and the pane you
are reading is left exactly where it was. Clicking that session shows the
document immediately — it was built when the agent produced it, not when you got
round to looking.

A chat that has never shown you anything shows you an empty pane, which lists
what changed recently under *that* chat's working directory. A document you
opened yourself while no pane was focused belongs to no chat, so moving between
chats leaves it alone.

Closing the pane clears the focused chat's document rather than hiding it, so
switching away and back does not resurrect what you just dismissed. A session
that goes away takes its document with it.

The rule for which of the three things happens — show it, keep it, ignore it —
is one function, `previewRoute` in `src/shared/previewRoute.ts`, pinned by
`test/previewRoute.test.mjs`.

## Opening itself

When a session stops working — it finished, or it stopped to ask something —
Workbench looks for a document under that session's working directory with a
modification time inside the turn that just ended. If exactly one document
changed, the pane can show it. When several changed, the scan leaves the preview
alone: the newest file might be a handoff from different work in the same folder.
Use `workbench show <path>` to name the intended deliverable.

Four rules keep that from becoming noise:

- **Only documents count.** Markdown, HTML, SVG, images, PDFs and CSV. Source
  files, JSON, YAML, logs and plain text are excluded on purpose: they are most
  of what an agent writes on any turn, and a pane that opens itself for every
  `.ts` file is a pane you turn off. (You can still open any of them by hand.)
- **Only inside the turn.** The scan is scoped to the window between the session
  starting work and stopping, so yesterday's report does not resurface and a
  delayed scan does not collect files written after the turn ended.
- **Never over your own choice.** If you opened a document yourself, that chat's
  pane is yours until you close it or open another. Only a document the pane
  surfaced can be replaced by the next one. A file explicitly named with
  `workbench show` also keeps its place until another explicit choice.
- **Never over another chat.** Only the focused session may take the screen. A
  background one gets its slot and a mark in the sidebar.

A session that crashed or exited reports nothing — a failed turn should not take
the screen away from whatever you were reading.

Turn it off with **Settings → General → "Open the preview pane when a session
produces a document"**, or from the command palette.

The turn boundary comes from the same status machine that drives the sidebar
colours, so nothing new is watching your filesystem: `SessionManager` reports
"a turn ran between these two times", the preview server answers "here is what
appeared in it", and the pane decides whether it is allowed to take the screen.

## Being asked for a file

`workbench show <path>` puts an existing file on screen. It is on the PATH of
every session Workbench starts.

The auto-open above only ever sees documents a turn *produced*, which is the
right rule for "what did it just write" and useless for "show me the résumé that
has been in this repo for a month". Without a verb for the second case an agent
has no move at all — and what it does instead is invent one. We watched a
session spend 1m49s hunting for an `openArtifact` API that has never existed,
then try to open a browser, before giving up and pasting a path for the user to
open by hand.

The command is a shim over the same loopback bridge the hooks use: same port,
same rotating token, nothing new listening. It posts to `/preview/show`, which
is where every rule about it lives:

- The file must be inside the **asking session's working directory** or an open
  workspace. The pane is a window into a project, not into a disk, and holding
  the bridge token does not change that.
- It must be a kind the pane can render, and it must be a file.
- Failures come back as sentences, not status codes — the caller is an agent
  that should be told what it did wrong.

Unlike a surfaced document, this one is not the pane guessing, so within its own
chat it does not defer to what you had open, and turning auto-open off does not
silence it: someone asked for it by name. It still does not reach across chats.
A background session asking for a file fills its own slot like anything else it
produces — being asked for by name makes it important to *that conversation*,
which is not the same as important enough to interrupt a different one.

Use it for newly written deliverables as well as existing files. A link in an
agent's final message is not a preview selection. A successful show suppresses
that session's end-of-turn fallback, including on a visual canvas, so a later
handoff cannot replace the intended document. Reads and rendering keep their
original session ownership, and a slower earlier request cannot overwrite a
newer choice. Closing the preview also cancels a pending open.

## A local server in the pane

An agent that runs `npm run dev` prints an address and waits. Workbench reads
that address out of the session's output and offers it: a toast with a
**Preview** button, and a chip in that session's pane footer that stays put —
"what port did it come up on" is a question you ask twenty minutes after the
line that answered it has scrolled away.

Nothing connects to anything until you click. The address came out of agent
output, which is input rather than instruction, and an agent printing a URL is
not an agent asking for it to be opened.

**Only loopback.** `localhost`, the `*.localhost` names, and the whole
`127.0.0.0/8` block. A LAN address printed alongside (Vite's "Network:" line)
is not offered, and neither is anything else — a remote URL in agent output
goes to the OS browser if you click it, never into the pane. The rule is
`isLoopbackUrl` in `src/shared/localhost.ts`, and it is enforced three times: in
the renderer before the frame's `src` is set, in main's `will-frame-navigate`
guard, and by the renderer's `frame-src` policy. `[::1]` is deliberately
excluded from all three — a bracketed IPv6 host-source is the one CSP form this
app cannot test from here, and a `frame-src` that fails to parse takes the whole
pane with it. Detection rewrites `[::1]` and `0.0.0.0` to `localhost`, which
reaches the same server.

**What it can do.** The same as an HTML artifact, because it is one: script
runs, its own fetches work, and it cannot touch the app's DOM, navigate the
window, or reach the preload bridge. Its own links work while they stay on
loopback; the moment the page navigates off this machine it is an external link
like any other and goes to the browser.

The detector costs nothing: it reads the same 30-line tail the trigger sweep
already captures for quiet sessions, which is exactly the state a dev server is
in once it has finished starting. Each address is announced once — a server
that reprints itself on every request does not keep interrupting.

**Starting one.** `⌘K` lists the focused session's `package.json` scripts as
`Run: npm run dev`. Running one starts a plain **shell session** rather than
typing into the focused agent: an agent's REPL is not a shell, and a
long-running server wants a pane you can watch and interrupt. It also closes the
loop, because the new session prints the address the detector is watching for.

## Following a file

The eye button in the header follows the open file. Changes on disk re-render it
in place, keeping your scroll position — an agent rewriting a report while you
read it is the normal case here, not the exception.

The watch polls once every 700ms rather than subscribing to the file. Agents
rewrite files by replacing them, and an inode-based watch goes deaf the first
time that happens.

## The two kinds of document

Everything the pane shows is one of two things, and the difference is the whole
security model.

**A generated document** is what a Markdown, CSV, JSON, diff or text file
becomes. The
renderer turns it into an HTML body; the main process wraps that body, mints a
nonce, and serves it with `default-src 'none'` and `script-src` bound to that
one nonce. The only script that runs is a small bridge that reports the scroll
position and intercepts link clicks. Raw HTML inside the source file is passed
through — `<div align="center">` in a README means it — and is inert, because
the policy allows nothing the wrapper did not put there. The Markdown renderer
is explicitly not a sanitiser, and nothing about the pane's safety depends on it
being one.

**An artifact** is an `.html` file an agent wrote. It loads as itself, on its
own origin, and its scripts run — that is the point of previewing one. What it
does not get:

- **The app.** It is a cross-origin iframe, sandboxed without
  `allow-top-navigation`, `allow-modals` or `allow-downloads`. It cannot touch
  the app's DOM or navigate the window.
- **The bridge.** Electron does not inject the preload script into subframes, so
  the IPC surface does not exist inside it. Every IPC channel additionally
  verifies that the sender is the top-level window.
- **The disk.** It can fetch only through the `wb-preview:` scheme, and only for
  files under a folder already opened (see below).

## What a preview can reach

Files are served over a custom `wb-preview://` scheme registered before the app
starts. Every request goes through one gate in `src/main/preview.ts`:

1. The path is resolved with `realpath`, so a symlink is judged by where it
   actually points.
2. It must sit inside a **root** — a folder opened during this session. Opening
   a file inside a workspace or a session's working directory takes that
   directory as the root, so an artifact can load its own repository's assets;
   opening a loose file elsewhere takes only that file's folder. Roots are
   compared by path segment, so `/tmp/work-2` is not inside `/tmp/work`, and are
   capped at 12.
3. Only whole files are served. There are no directory listings.
4. Two size caps apply: 2MB for text crossing the IPC bridge (larger files are
   truncated at a line boundary and say so), and 128MB for anything streamed to
   the frame.

Serving `.svg` as `image/svg+xml` rather than `text/html` is deliberate — an SVG
served as HTML is a script host — and is pinned by a test.

"Open with the system app" and "Reveal in folder" re-run the same check: they
can only ever act on a file already open in the pane.

## Why no dependencies

The pane could have been a Markdown library, a CSV parser and Mermaid. It is
instead about 700 lines in `src/shared/markdown.ts` and `src/shared/preview.ts`.
This app runs other people's coding agents with filesystem access; every
dependency it does not have is one fewer thing to audit, and the test harness
note in `test/ts-resolve.mjs` makes the same argument for the same reason. The
renderer covers what agents actually write — headings, fenced code, tables,
task lists, quotes, links, images, inline emphasis — and is covered by
`test/markdown.test.mjs`.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `src/shared/preview.ts` | Kinds, MIME types, URL shapes, the document wrapper and its policy, delimited-text parsing |
| `src/shared/markdown.ts` | The Markdown renderer |
| `src/shared/diff.ts` | The unified-diff parser and renderer |
| `src/shared/previewRoute.ts` | Which chat a document belongs to, and whether it may take the screen |
| `src/shared/localhost.ts` | What counts as a local server, and how to spot one in output |
| `src/main/scripts.ts` | The `package.json` scripts a project already knows how to run |
| `src/main/preview.ts` | The gate: roots, containment, serving, watching, recents, and what a turn produced |
| `src/main/sessions.ts` | Emits `produced` at each turn boundary, with the session that produced it |
| `src/main/index.ts` | Scheme registration, `protocol.handle`, subframe navigation rules |
| `src/renderer/src/lib/preview.ts` | The client half — one funnel for every way of opening something |
| `src/renderer/src/components/PreviewDock.tsx` | The pane itself |
| `test/preview.test.mjs`, `test/markdown.test.mjs`, `test/previewRoute.test.mjs`, `test/localhost.test.mjs` | The rules above, pinned |
