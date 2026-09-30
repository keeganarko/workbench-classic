# The pane footer

One line under each live terminal, answering the questions you would otherwise
have to reconstruct from scrollback: what this agent is allowed to do, what
model it is, which branch it is on, how much room the conversation has left,
and where it is running.

    full access   claude-opus-5 · high   ⎇ feat/preview   72% left   :5173   ~/Dev/Workbench

Everything but the context figure was already on the session record and simply
not shown. This document is mostly about the one that was not.

## Permission mode

First, and deliberately so. A **full access** session runs commands and edits
files with no approval prompt, and that is a thing you want to notice from
across the room rather than discover afterwards — so it is the one chip that
turns amber.

## Model

Shown only when the session was launched with a model pinned, with the
reasoning effort after it when there is one. An unpinned session shows nothing
here, because what it is running is whatever the CLI defaults to today, and
printing a guess would be worse than printing nothing.

## Context left

The one genuinely new datum in this row, and the only thing here that is not
already on the session record.

### Neither CLI tells us — both write it down

There is no API to ask. What there is: the JSONL each CLI keeps for its own
resume feature, whose path Workbench already tracks because the transcript
export and the fork-resume check both need it. So this is a read of a file that
exists, not a new channel into the agent.

The two formats say different amounts, and that difference is visible in the
UI:

| | Token count | Window size |
| --- | --- | --- |
| **Codex** | `info.last_token_usage.total_tokens` | `info.model_context_window`, stated outright |
| **Claude** | the four `message.usage` figures added up | never stated; only inferable from a `compact_boundary` |

Codex names its window in the same event as the count, so a Codex pane shows a
percentage from its first turn. Claude names the count but never the ceiling.
The one place a ceiling appears is the `compact_boundary` entry written when a
session compacts, whose `preTokens` is the size the conversation had reached
when the CLI decided it could not hold more.

So a Claude pane reads **`109k ctx`** until it has compacted once, and
**`64% left`** after. This is not a missing feature; it is the honest shape of
what is on disk.

### Why not just look up the model's window size

Because a table of model names to window sizes would be both perishable and,
on this machine, wrong twice over:

- `message.model` reads `claude-opus-5` for a session whose window is a million
  tokens. The name does not distinguish them.
- A session observed here compacted at **216,705** tokens — neither 200k nor
  1M. Compaction fires on a threshold the CLI chooses, not on the raw window.

With a hardcoded 200k, that session would have displayed a negative percentage
at the moment it was most useful. A number that is confidently wrong about how
much room is left is worse than no number.

### Ceilings are learned, and not written down

Once any session has revealed a ceiling for an agent and model, sibling
sessions on the same pairing use it — so the second Claude pane you open gets a
percentage without having to compact first.

That map lives in memory and is deliberately **not** persisted. A CLI upgrade
that changes the threshold would otherwise leave a stale number on disk with
nothing to correct it, and the failure mode of a wrong ceiling is exactly the
confidently-wrong percentage the previous section is about. Losing it on
restart costs one compaction to relearn.

### Reading a seven-megabyte file every two seconds

Which is what the naive version would do: the poll loop runs every 2 s per
session, and the two transcripts in this project's own history are 7 MB each.

Two things make it free:

1. **A `stat` first.** The result is cached against `mtimeMs:size` together —
   either alone is defeatable, both together cost one syscall, and an unchanged
   file never gets opened.
2. **The last 256 KB only.** The newest entry carrying a token count is
   essentially always inside that window; when it is not, the answer is
   "unknown" for one turn and the next entry brings it back. Starting mid-file
   means the first line is the tail of one that began before the window, so it
   is dropped rather than parsed into something wrong.

Inside the window, lines are scanned newest-first with a substring test
(`line.includes('"usage"')`) before `JSON.parse`, and the scan stops as soon as
it has what it needs. Parsing is the expensive part; rejecting nearly every
line without it is the point.

### 15%

Below that the chip turns amber, matching full-access. It is a rough number
chosen for one property: it leaves enough room to finish the thought you are in
and hand off deliberately, rather than have a compaction land in the middle of
one.

## Branch and folder

The branch comes from the workspace record when there is one, and the folder is
shortened to `~/…`. For a worktree these are the same fact told twice — the
path is under Application Support and tells you nothing, which is why the
branch is there.

## Server URL

When a session's output announces a local server, the URL stays in the footer
until the pane dies, and clicking it opens that address in the preview pane.
"What port did it come up on" is a question you ask twenty minutes after the
line that answered it has scrolled away.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `src/shared/context.ts` | What the two transcript formats mean; takes lines, so it is testable with a string |
| `src/main/context.ts` | The disk half: `stat` cache, tail read, partial first line |
| `src/main/sessions.ts` | `refreshContext` in the poll loop, and the learned-ceiling map |
| `src/renderer/src/components/TerminalPane.tsx` | `PaneFooter` and `ContextChip` |
| `test/context.test.mjs` | Both formats pinned against line shapes taken off real files |
