# Adding an agent

Workbench ships with Claude Code, Codex CLI and a plain login shell. Settings →
Agents adds any other CLI that runs a coding assistant in a terminal: a name, a
command, a colour.

What you get is a real profile, not a second-class one. It launches in tmux,
appears in the New Session dialog, the command palette, the sidebar, the pane
switcher and the minimised bar, takes broadcast prompts from the composer, and
reports its status through the same text-pattern triggers everything else uses.

What you do not get is resume, native fork, transcript export or a context
percentage. That is the subject of this document.

## Capabilities are claims, not wishes

An agent's row in the registry declares seven things it can do:

| | Meaning |
| --- | --- |
| `resume` | Reopens its own earlier conversation by id |
| `fork` | Branches a conversation, leaving the parent intact |
| `hooks` | Reports turn boundaries, so status is observed rather than guessed |
| `transcript` | Keeps a file we can read: export, handoff, context figure |
| `model` | Takes a model name at launch |
| `effort` | Takes a reasoning-effort setting at launch |
| `permissions` | Understands anything beyond `default` permission mode |

Each of those costs a flag on a real command line, and Workbench only ever
passes a flag it has verified. A profile you add declares **none** of them, and
that is not a placeholder to be filled in later — it is the honest answer for a
CLI whose argv this project has not read.

The reason is narrower than it sounds. A wrong `--model` is loud: the CLI
refuses to start and you see why. A wrong `--resume` is silent — it starts a
brand new conversation, prints a banner, and looks exactly like it worked. You
find out an hour later, when the context you thought you had turns out never to
have existed. Given the choice between a feature that might work and a feature
that is absent, absent is the one you can plan around.

So the presets in Settings ship a command name and a colour and nothing else.
`gemini`, `cursor-agent`, `aider`, `opencode` — the *existence* of these is well
known; their resume syntax is not something to infer.

## What happens instead of a fork

Forking a session whose agent cannot fork does not fail. It falls back to the
transcript handoff — the path that already existed for handing a Claude session
to Codex:

1. The source conversation is written to markdown (from the CLI's own JSONL when
   there is one, otherwise from scraped pane text, which any agent has).
2. A fresh session of the target agent starts in the same working copy.
3. It is sent a prompt pointing at that file.

The child does not inherit context in the CLI's own sense; it is told where to
read it. That works for anything you can type into, which is the point.

## Three launch strategies

`launch` on a definition is one of three values, and they are the three amounts
this project knows about a CLI.

- **`claude`** — `--session-id` on a fresh session, `--resume … --fork-session`
  on a branch, `--settings` for the hook bridge, `--mcp-config` for the session
  bus.
- **`codex`** — `resume` / `fork` subcommands, `-c` config overrides, and a
  lifecycle log we parse for turn boundaries.
- **`plain`** — the binary and its configured arguments. Nothing else.

`plain` is the floor, and it is also what the login shell uses. A shell and a
newly added agent are the same problem: run this command, show me the output,
tell me when something in it looks like a question.

## Ids

The id is derived from the label — "Gemini CLI" → `gemini-cli` — and then left
alone. It ends up in tmux session names, on every persisted session, and in
trigger rules, so renaming the profile must not change it; a renamed profile
whose id moved would orphan every session it ever started.

Ids are lowercase, start with a letter, and hold letters, digits and hyphens, up
to 32 characters. That is the intersection of what filenames, tmux and CSS class
names all accept.

A profile may not take a built-in's id. The built-in owns a hook bridge and a
transcript parser, and an override would silently switch both off while still
looking like Claude in the UI.

## Deleting one

Removing a profile does not touch the sessions it started. They keep running,
keep their history, and render with the id as their name and a neutral grey —
the app has a placeholder definition for exactly this, so a deleted profile
degrades to a legible row rather than a blank chip. Re-adding a profile with the
same id restores the name and colour.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `src/shared/agents.ts` | The registry itself: definitions, capabilities, presets, id rules |
| `src/main/agents.ts` | `buildLaunchSpec` — one function per launch strategy |
| `src/main/index.ts` | Resolving a definition's command on PATH, and rebuilding the menus when the list changes |
| `src/main/validate.ts` | `asCustomAgents`, the IPC boundary for what Settings sends |
| `src/renderer/src/lib/agents.ts` | `profileOf` and the hooks that ask the registry from a component |
| `test/agents.test.mjs` | The rules above, pinned |

## Why a registry at all

Before this, "which agents exist" was the type
`AgentKind = 'claude' | 'codex' | 'shell'`, and its consequences were spread
over a dozen files: an if/else chain in the launch builder, two
`Record<AgentKind, string>` maps in the renderer, three CSS variables, a literal
`['claude', 'codex']` in four dialogs, and a `switch` in the validator. Adding a
fourth agent meant finding all of them.

The union bought exhaustiveness checking, which was worth something. What
replaced it is the split the file tree already uses: **shape at the IPC
boundary, existence where the truth is.** `isAgentId` checks that a string could
be an agent; the launch path checks whether this one is, and can say something
useful when it is not — "Gemini CLI was not found on PATH (looked for
`gemini`)". A compiler error could never have said that.
