# A private brain, a small context export

The brain is a separate local Markdown/Obsidian folder. Code stays in this
repository; the notes, machine paths, and source records stay outside it.

Agents can run `node scripts/brain.mjs context workbench` at startup. The reader
uses `BRAIN_ROOT` when set; otherwise it looks for the Windows `C:\Brain` folder
(through `/mnt/c/Brain` in WSL), or `~/Brain` on another host. A missing brain is
reported and does not prevent normal project work. A Mac's older `~/Dev/brain`
is not automatically searched or harvested.

Only the explicit export list is read. A local `brain.manifest.json` looks like:

```json
{
  "version": 1,
  "context": {
    "workbench": ["Exports/preferences.md", "Exports/workbench.md"]
  }
}
```

Exports must be Markdown files directly under `Exports/`. The reader rejects
traversal, symlinks into other folders, oversized files and combined context over
16 KB. It makes no network requests, edits, recursive reads, or model calls.
Selected text printed to an AI terminal may become provider-visible context.
This mechanism does not grant access to other notes or make the model local.

Update the selected export after reviewing new project lessons. Ordinary notes
and handoffs remain in the brain or their owning project; the reader does not
automatically collect every chat or continuously update running sessions.

Open the brain folder as an Obsidian vault to use its Home note and canvas.
Sync, off-device backups, and a native Workbench brain panel are separate from
this file-based context bridge. No remote or sync service is created by it.

For the user-adopted central-agent setup, use `node scripts/brain.mjs context coordinator`. The local manifest selects the same reviewed preferences plus a short coordinator export. Role naming does not grant Session Bus permissions. Project Manager remains bound to one Workbench project; App Manager is a separate explicit grant across the app.
