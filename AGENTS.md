# Workbench — agent notes

Notes for coding agents (Claude Code, Codex and others) working in this repository.

## Focus updates

Publish a short Focus update when meaningful progress changes: a useful
discovery, a design revision, a verified fix, a blocker, or a completed
milestone. A long turn can contain several such updates. Do not wait for the
final reply, use a fixed timer, or report every tool call. Mark completed
milestones as milestones; investigation and partial work remain updates.

Give each substantial update an image specific to that result: a screenshot,
custom SVG diagram, or generated illustration with concrete names, content,
and measured results where useful. Do not choose a generic discipline icon or
recolor the previous picture. Save it inside the session's folder and pass
`visual: { kind: 'image', path, alt }` to `publish_focus_update`; Workbench
preserves a separate copy for the report. If the connected app still exposes
the older steps/metrics schema, use that supported schema and retain the image
for the app update; do not modify live state or bypass a refused tool call.

## Showing the user something visual

**Write a file. Do not open a browser, do not build a viewer, do not ask.**

Sessions in this app run inside Workbench, which has a preview pane on the
right. After writing and checking the document you intend to show, run
`workbench show <path>` before your final response. Use the same command when
revising a document already on screen. This identifies the exact deliverable;
a Markdown link in the response does not select the preview.

The end-of-turn file scan is only a fallback. It cannot tell a deliverable from
a later handoff or a file another session wrote in the same folder. Do not
depend on modification times to decide what the user should see.

Kinds that open the pane:

    .md .markdown .mdx   .html .htm   .svg   .png .jpg .gif .webp .avif   .pdf   .csv .tsv

Kinds that deliberately do **not** (they are most of what a turn writes, and
auto-opening them makes the pane noise): source files, `.json`, `.txt`, `.log`.

So:

- Report, summary, comparison, plan → write a `.md`.
- Chart, diagram, dashboard, anything interactive → write a standalone `.html`
  or `.svg`. Inline the CSS and JS; the frame gets its own strict CSP.
- Tabular results → write a `.csv`.

Do not spend a turn explaining that you cannot display something. Write the
file and show it through the existing preview command.

An explicit show replaces the asking session's preview, while background
sessions keep their own preview slots. Automatic scans do not replace a file
chosen explicitly. Files must be inside the session's working directory or an
open workspace. Details: `docs/preview.md`.

## Build and test

    npm run verify     # typecheck + build + tests
    npm test           # node --test via test/ts-resolve.mjs

Put large build copies, dependency trees, downloaded archives and unpacked
Electron applications under `~/.cache/workbench/builds/`, not `/tmp`. Use a
unique directory for each build.

## Renaming or deleting something structural

A branch, a directory, an npm script, a path convention. These changes fail
**silently** — a CI trigger naming a branch that no longer exists matches
nothing, runs nothing and reports nothing, which is indistinguishable from a
green repository. Code errors when it is wrong; configuration and prose do not.

So after any such change, before calling it done:

    git grep -n '<the old name>'

and read `docs/structural-changes.md`, which lists what breaks quietly for each
kind of change, the end-to-end recipe for a branch rename, and the two-step
needed when a rename differs only in case.

This repository has one branch, `main`.

## Constraints

- **No new npm dependencies.** This is a hard rule; work around it.
- Comments explain *why*, at length. Match the density already in the file.

## Project presentation

When editing the README, project descriptions, or demo captions, follow
[the writing guide](docs/writing.md). Preserve the accurate setup instructions
and product limitations in the linked technical guide.
