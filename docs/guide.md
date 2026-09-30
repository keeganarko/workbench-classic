# Workbench

**One desktop window for running and monitoring Claude Code and Codex.**

When several coding assistants are working at once, it is easy to lose track of
which one is busy, blocked, or finished. Workbench keeps those sessions together
and makes their status visible.

```text
Waiting on you  ·  Working  ·  Ready for review  ·  Recent
```

> **Project status:** beta. One `main` branch builds both the Mac and Windows apps.
> Native Windows setup uses WSL-hosted terminals; [setup](windows-native-prototype-setup.md).

## What you can do

- Run Claude Code and Codex side by side, or add another terminal assistant.
- See which sessions need a response and which are ready to review.
- Split the window, resize panes, search past output, and zoom into one session.
- Read each pane's model, permission mode, branch and remaining context off a
  single line under it.
- Send one prompt to several selected sessions.
- See what an assistant produced — Markdown, HTML, images, diagrams, PDFs, CSV
  and JSON — in a pane that opens beside the terminals when the file appears.
- Open a visual canvas where each prompt changes an HTML, SVG, image or PDF
  directly, with the assistant's text transcript kept behind the artwork.
- Browse the folder an agent is working in, and search it for a piece of text.
- Review what an agent changed — the file list, the diff, and staging and
  committing it — from the sidebar, without leaving the window.
- Hand a diff to a fresh agent and ask it to review the work.
- Hand a prompt from one agent to another and, optionally, wait for the reply.
- Get a desktop notification when an assistant needs attention.
- Close the app without stopping the underlying sessions.

## Projects and coordination

Projects open Terminals first and focus the session that most needs attention.
New terminals default to that project’s folder. Outputs can be filtered by their
recorded project. The composer offers **This Pane**, **This Project**, and
**All Sessions**. See
[Session Bus managers](session-bus.md) for permissions and agent coordination.
Scheduled tasks run locally while Workbench is open.

## A few useful definitions

| Term | Plain-English meaning |
| --- | --- |
| **Agent** | A coding assistant, such as Claude Code or Codex. You can add others. |
| **Session** | One ongoing conversation and terminal workspace for an agent. |
| **tmux** | The background terminal tool that keeps sessions alive when Workbench closes. |
| **WSL 2** | A Linux environment that runs inside Windows. |
| **WSLg** | The part of WSL that displays Linux desktop apps on Windows. |

## Run it on macOS

You need macOS, Node.js 22.16+ or 24+, `tmux`, and at least one supported coding
assistant installed on your `PATH`.

```sh
brew install node tmux
npm ci
npm run dev
```

To install Codex from the command line:

```sh
npm install -g @openai/codex
```

### If Electron did not install completely

A partial Electron download can fail at launch with a missing-framework error.
Re-extract the cached download, then rebuild the native terminal dependency:

```sh
ZIP=$(ls ~/Library/Caches/electron/*/electron-v*-darwin-*.zip | head -1)
rm -rf node_modules/electron/dist && mkdir -p node_modules/electron/dist
ditto -x -k "$ZIP" node_modules/electron/dist
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
npm run rebuild
```

## Run Workbench on Windows

The Windows path keeps Workbench's Linux terminal foundation by running it
inside WSL 2 and displaying the window through WSLg. Clone and run it from an
Ubuntu terminal inside WSL:

```sh
git clone https://github.com/keeganarko/workbench-classic.git
cd Workbench
npm ci
npm run doctor:wslg
npm run verify
npm run dev
```

Read the [complete Windows guide](windows-wslg.md) for prerequisites,
packaging, and the boundary between Windows and WSL files. This path has
automated checks but still needs end-to-end validation on Windows hardware.

## How it works

```text
Workbench window
   ↓ starts or reconnects
tmux sessions
   ↓ run
Claude Code / Codex
   ↓ send status events
Waiting / Working / Ready / Failed
```

The assistants report status through their supported notification hooks:

- **Claude Code:** Workbench passes a generated settings file to that session.
  It does not edit your normal Claude settings.
- **Codex:** Workbench passes a notification override to that process. It does
  not edit your normal Codex configuration.

Both send events to a token-protected local server inside the app. Text-pattern
triggers provide a fallback when a native event is unavailable.

## What each pane tells you

One line under every live terminal carries the things you would otherwise have
to remember: the permission mode, the model it was launched with, the branch,
how much room the conversation has left, and the folder it is running in.

**Full access** is shown first and in amber, because a session that runs
commands without asking is worth noticing from across the room.

**Context left** is read out of the transcript the assistant is already writing
for its own resume feature. Codex records the size of its context window, so a
Codex pane shows a percentage straight away. Claude records the tokens but not
the window, and only reveals where its ceiling is the first time a conversation
is compacted — so a fresh Claude pane shows a token count such as `109k ctx`
and switches to `64% left` once it knows. Workbench does not guess the number
from the model's name: the names do not distinguish a 200k session from a 1M
one, and a percentage that is confidently wrong is worse than none.

`docs/pane-footer.md` covers the rest.

## Adding another assistant

Settings → Agents takes a name and a command, and any CLI that runs a coding
assistant in a terminal becomes a profile like the built-in two: it starts in
its own pane, appears in every list and menu, takes broadcast prompts, and shows
status from the text-pattern triggers. There are one-click presets for a few
well-known ones.

Resume, native fork, transcript export and the context figure stay off for
these, deliberately. Each of those is a flag on a specific command line, and
Workbench only sends flags it has actually verified — a wrong resume flag starts
a brand new conversation and looks like it worked. Forking one of these sessions
falls back to the transcript handoff instead, which works for anything you can
type into.

`docs/agents.md` explains the trade-off and what a profile does and does not
claim.

## The preview pane

When a session finishes a turn that produced a document — a report, a chart, a
generated page — the pane opens on the right and shows it. Only documents count
(Markdown, HTML, images, SVG, PDF, CSV), never the source files and logs that
make up most of an agent's output, and it never replaces something you opened
yourself. Turn it off in Settings → General.

The pane holds one document **per chat**. Focus one session and you see its
latest document; focus another and the pane switches. An agent finishing in the
background never takes the page away from what you are reading — it gets a small
document mark on its row in the sidebar, and clicking that session shows the
document straight away, already rendered.

You can also open the pane yourself with `⌘⌥B`, then drop a file on it or press
`⌘⌥O` to choose one. It renders Markdown, HTML pages, images, SVG diagrams,
PDFs, CSV tables, JSON, patch files and plain text; an empty pane lists the
files that changed most recently in the focused session's folder.

Turn on the eye button and the pane re-renders when the file changes on disk, so
you can watch a report being written.

**Dev servers.** When a session prints a `http://localhost:…` address, Workbench
offers to open it in the pane — a live page, next to the agent that is editing
it — and keeps the address in that session's pane footer. Only loopback ever
loads there; anything else goes to your browser. `⌘K` lists the project's
`package.json` scripts, so `Run: npm run dev` starts one in its own shell
session and the address turns up by itself.

A previewed file can only reach the folder it was opened from, and a rendered
document cannot run scripts or reach the app. `docs/preview.md` explains what it
renders and why those limits are drawn where they are.

## The visual pane

Press `⌘F` (`Ctrl+F` on Windows/Linux) to open a visual split backed by a
dedicated Codex session pinned to `gpt-5.6-luna` with low reasoning effort. The
speed-first profile is local to that canvas; it does not change ordinary coding
sessions. The pane uses the same border, resizing, zoom and close controls,
but replaces the terminal transcript with a canvas and a prompt box. Describe
the scene, diagram, composition or change; the agent creates or updates one
animated, self-contained HTML artifact and the canvas refreshes to show it
directly. Scene requests animate by default; a static image is produced only
when the direction explicitly asks for one.

The visual session starts in the focused conversation's working folder and
carries its latest visual into the canvas when one exists. If the fast session
cannot start, Workbench falls back to mirroring the focused conversation. Text
replies never render in the visual pane. If an agent
needs an interactive permission answer or fails, the pane says so and offers
the terminal view; the image/terminal button in every pane header switches the
same session between the two presentations without losing its latest artwork.

Find in Session remains available from the Edit menu and command palette.

## Files and search

The folder and magnifier icons on the left-hand strip give the sidebar two more
views, both scoped to whichever pane you are looking at.

**Files** is a tree of that session's folder. Build output and dependencies are
left out, changed files carry the same letters the source-control panel uses,
and clicking a file renders it in the preview pane.

**Search** finds a piece of text in the same folder with `⌘⇧F`. It looks
for literal text rather than a pattern, on purpose: a regular expression would
run in the process that drives every terminal in the window. Results are
grouped by file, and clicking one opens it.

Both are read-only. `docs/sidebar-panels.md` covers the limits and why they are
drawn where they are.

## Sharing a session

The share icon in the title bar hands the focused session to up to five people
over a link. They open it in a browser — no install, no account, nothing to set
up on their side — watch the terminal as you see it, and appear by name next to
the status chips.

Everyone joins as a watcher. Typing is off until you turn it on for one person,
and it is checked per keystroke, so revoking it stops the next character rather
than the next reload. That default is not a convenience setting: a share link is
a remote-input surface into a terminal running coding agents on your machine.

The server binds loopback and nothing else. Reach beyond this machine comes from
a `cloudflared` quick tunnel, spawned on demand and killed when the last share
stops. Without `cloudflared` installed the link still works locally and the
dialog names the one command that upgrades it.

`docs/sharing.md` covers what a guest can and cannot see, why they watch a
rendered snapshot rather than the raw stream, and the threat model behind the
typing rules.

## Reviewing what an agent changed

The branch icon on the left-hand strip swaps the sidebar for source control. It
follows whichever pane you are looking at, so it always answers "what has *this*
agent done" — the branch it is on, how far ahead of the remote it is, and every
file it has touched.

Click a filename to read the diff in the preview pane. The `+` and `−` buttons
stage and unstage a file, and the box at the bottom commits what is staged;
`⌘⏎` commits without reaching for the mouse. Pushing takes two clicks, and the
second one names the exact remote and branch it is about to write to — it is the
only thing in the app that leaves your machine.

"Everything since main" shows the whole of what this session has done since it
branched, which is usually the thing you actually want to read at the end of a
run. "Review this work" forks a new agent and asks it to review that diff: the
patch is written to a file and the new session is pointed at it, so nothing gets
retyped and the reviewing agent has the repository in front of it.

Nothing here rewrites history. There is no rebase, no cherry-pick, no branch
surgery — for those, use the terminal, where you can see exactly what you typed.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build and open the development app. |
| `npm run build` | Build the Electron and React code. |
| `npm run typecheck` | Check TypeScript without producing files. |
| `npm test` | Run the automated test suite. |
| `npm run verify` | Run the main quality checks together. |
| `npm run doctor:wslg` | Check that the Windows/WSLg requirements are ready. |
| `npm run rebuild` | Rebuild `node-pty` for the installed Electron version. |
| `npm run dist` | Package a macOS disk image in `release/`. |
| `npm run dist:wslg` | Package the WSLg build as an AppImage. |

## Technical map

| Path | Responsibility |
| --- | --- |
| `src/main/` | Agent launch, tmux, session storage, status hooks, tray, and IPC. |
| `src/preload/` | Safe bridge between Electron and the interface. |
| `src/renderer/` | React interface, state, and styles. |
| `src/shared/` | Types, the Markdown renderer, and other code used by more than one process. |
| `docs/` | How the preview pane, the sidebar panels, the pane footer, session sharing, added agents, and the Windows path work. |

Runtime state lives in `~/Library/Application Support/Workbench` on macOS and
`~/.config/Workbench` under Linux/WSLg. It is not stored in this repository.

## Handing work between sessions

Two agents can work in turn without you carrying the prompt between them.

**From the composer** — type `@` and pick a session. The name comes from the
session's title, so rename sessions by role (`Reviewer`, `Builder`) and they
become addresses. A named session overrides the scope chips: `@reviewer look at
this` goes to that one session, never to the broadcast set. Tick **Wait for
reply** and the composer blocks until that agent finishes its turn, then shows
what it said.

**From inside an agent** — every session gets a `workbench` command on its PATH:

```sh
workbench list                                   # who can I reach?
workbench send @reviewer "Cross-check this diff" # hand it over, keep working
workbench send @reviewer "..." --wait            # block, print their reply
```

With `--wait` the reply goes to stdout, so an agent can use another agent as a
tool. Exit status is 0 only when a reply actually came back.

Three things the relay refuses to do, because each one costs an hour to
diagnose after the fact:

- **Deadlock.** A blocking chain that would close a cycle (A waits on B waits on
  A, or any longer loop) is rejected up front rather than left to two timeouts.
- **Interrupt a turn.** A busy recipient is given time to finish; text typed into
  a mid-turn TUI merges into whatever that agent submits next.
- **Answer with the previous turn.** A turn-end signal arriving in the first
  moments after delivery is treated as the tail of the last turn, not a reply to
  this one.

A recipient that stops to ask *you* something is reported as needing a human —
not as a failure, and not as an answer.

You can also inspect or attach to a session from another terminal:

```sh
tmux -L terminal ls
tmux -L terminal attach -t term_<session-id>
```

## Credits

Built by [Keegan Arko](https://github.com/keeganarko) and
[hiteshsv1](https://github.com/hiteshsv1).

Git history under-credits the collaboration: every commit so far was authored
from a single machine, so the contributor graph shows one name. The work was
joint.

## License

Workbench is available under the [MIT License](../LICENSE).
