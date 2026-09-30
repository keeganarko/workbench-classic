# Agent permissions and the Session Bus

Click the **Permissions** shield at the top left, beside the sidebar and broadcast buttons. It opens access controls for every session across all projects. The command palette and Session menu also offer **Permissions**; searching the palette for **Session Bus** still finds it. Enable **Enable agent communication**, then choose the access level on an agent's row. Each row shows its project and short session ID so repeated agent names remain distinguishable. Start a new Claude or Codex terminal, or restart the terminal you want to connect. Existing conversations resume when their CLI has recorded them.

File the terminal under a Workbench project, choose **Project Manager** on its row, and confirm **Grant Manager for [project]**. The confirmation names both the agent and the project and explains its authority. Codex or Claude may separately ask permission to use the MCP server; that approval does not grant additional Workbench access.

The bus is local to this Workbench instance. Sharing a project with a friend's computer is a separate feature; see [project sync](project-sync.md).

For one central agent across the whole app, choose **App Manager** and confirm **Grant App Manager for all projects**. Its workers remain filed in their actual projects. The global Focus view contains the central composer and project previews. Existing Project Managers are never upgraded automatically.

## Grants

| Grant | What other agents can do to this session | What this session can do |
| --- | --- | --- |
| Off | Ordinary bus callers cannot see it. An authorized manager of its project can manage it. | Cannot call the bus. |
| Read | List, read, and wait for its status. | List and read opted-in sessions; message or fork targets whose grant permits it. |
| Full | Read, wait, send prompts, and fork. | Same outgoing target rules as Read. |
| Project Manager | Individually reachable like Full, and manageable by another manager in its project. | Manage sessions and scheduled tasks in the project named in its grant, including Off sessions. |

| App Manager | Individually reachable like Full; another App Manager can manage it. | Read progress and manage sessions across all projects and unfiled sessions. Requires an explicit grant; workers never inherit it. |

A Project Manager cannot reach another project, even if a session there has Full access. Its grant is bound to the project's ID, not a repository or a folder path. Moving or unfiling the manager, or removing its project, revokes the grant. Renaming the project retains the same ID and authority.

Only the Workbench interface can grant permissions. Agent tools cannot promote themselves, grant Manager to a child, change project membership, or raise CLI execution permissions. New workers get Full bus access and the CLI's normal execution permission mode. Forks preserve the source's existing CLI execution configuration, as ordinary Workbench forks do, and never inherit either management grant. App Manager creation requires an explicit `project_id`; `list_projects` reports saved IDs, folders and launch availability. Global grants persist across project moves and bind to the app, not the agent’s folder. Scheduled-task tools remain Project Manager only in this version.

Turning the master switch off or revoking a grant blocks subsequent calls. Pending reads and waits recheck permissions; relays also check while a busy recipient settles and before returning its reply. Already-delivered prompts and launches cannot be recalled. A launch whose manager was revoked before completion leaves its new worker Off.

## Tools

| Tool | Behavior |
| --- | --- |
| `publish_focus_update` | Publish a brief report on the caller's own project Focus card, with an image made for that update, or steps/metrics. Read, Full and both manager grants can report; identity and project come from Workbench. |
| `list_projects` | Managers: saved project IDs, names, default folders and creation availability within their scope. |
| `get_project_progress` | Managers: attributed project milestones, next actions, report visuals, timestamps and worker status. App Managers can page across projects, including inactive ones for coverage; Project Managers see only their own. |
| `list_sessions` | Reachable sessions, project IDs, status, and whether messaging or management is allowed. |
| `read_session` | Plain-text terminal scrollback, up to 4,000 lines. |
| `send_prompt` | Deliver an agent-to-agent prompt; optional `wait: true` returns its reply. |
| `wait_for` | Wait for specified statuses; maximum ten minutes; revocation ends the wait. |
| `fork_session` | Native conversation fork when supported, otherwise transcript handoff. |
| `create_session` | Either manager grant: create a worker in the target project's default folder (App Manager requires `project_id`), optionally with a first prompt. Saved project instructions apply to agent prompts, never shell commands. |
| `update_session` | Either manager grant: rename or pin/unpin a project session. |
| `interrupt_session` | Either manager grant: send Ctrl+C. |
| `stop_session` | Either manager grant: stop the process and retain the session. |
| `restart_session` | Either manager grant: restart in place and resume its recorded conversation when available. |
| `delete_session` | Either manager grant: stop and remove the session from Workbench. Project files and CLI transcripts remain on disk. |
| `list_scheduled_tasks` | Project Manager only: list the project's saved tasks and run history, with the computer's local time zone. |
| `create_scheduled_task` | Project Manager only: save a daily, weekday, or weekly task in the project; appears in Scheduled without launching it immediately. |
| `update_scheduled_task` | Project Manager only: edit supplied fields; set `enabled: false` to pause or `true` to resume. |
| `run_scheduled_task` | Project Manager only: run a saved task now; returns the new run record. Active runs cannot overlap. |
| `delete_scheduled_task` | Project Manager only: remove a task when no run is active; keep its run history and files. |

For example, tell an authorized manager:

> Create a Codex worker called Reviewer in this project. Ask it to review the changes and wait for its response. Report its findings, then stop the worker.

The `workbench list` and `workbench send @name "message" [--wait]` shell commands use the same permissions and ledger as MCP. A copied session ID is a more precise address when names are ambiguous. The human composer remains a direct user control and does not require an agent bus grant.

## Agent progress on Focus

The MCP startup instructions and `publish_focus_update` description ask agents
to report whenever meaningful progress changes in their current turn. A long
turn can have several useful updates: discoveries, design revisions, verified
fixes, blockers and completed milestones. There is no fixed timer and no need
to wait for the final reply. Workbench does not start extra model calls or
poll agents for reports. Sessions need an enabled bus, a current Read, Full or
either manager grant, and an existing Workbench project. Refresh the MCP
connection after installing a build that changes the tool schema.

Each report has a `kind` (`update`, `milestone`, `blocked`, or `decision`), a plain-text `summary` of up to 180 characters, and an optional `next` of up to 140 characters. An optional `visual` contains one to four `steps` items (`label`, `state`: `done`, `active`, or `pending`) or `metrics` items (`label`, string `value`). Labels allow 48 characters and values allow 32. HTML, remote URLs, unknown fields and malformed nested values are refused.

For a substantial update, prefer an image made for that exact result:
`visual: { "kind": "image", "path": "artifacts/preview-fix.svg", "alt": "The chosen concept stays visible after a later handoff finishes." }`.
The path must resolve inside the reporting session's folder, including after
symlink resolution. PNG, JPEG, WebP and SVG up to 4 MB are supported. Workbench
copies the image into the report's own immutable snapshot. The description is
plain text up to 180 characters. Do not select generic category art or merely
recolor the previous image. The report's stored `visual.path` points to its
snapshot; `get_project_progress` exposes the real latest visual and leaves the
legacy `task_art` field null. A metrics report remains supported:

```json
{
  "kind": "milestone",
  "summary": "The report backend saves updates and rejects forged ownership.",
  "next": "Check the project card in the integrated build.",
  "visual": { "kind": "metrics", "items": [{ "label": "Checks passed", "value": "12" }] }
}
```

Workbench assigns the report ID, time, caller session and its actual current project. Agents cannot report on behalf of peers or choose a project, including managers. Reports are saved atomically in `experience.json`, retaining six per session and 240 overall; removed sessions and projects are pruned. Earlier project attribution stays fixed when a session moves. Reports are agent-authored claims, separate from live lifecycle status: even `blocked` does not create an Inbox request or grant additional authority.

## Scheduling through an advisor

An agent needs **Manager** in its project to manage schedules. Read and Full do not grant this authority. After installing a Workbench build with scheduling tools, restart the app and restart the advisor's terminal so its MCP tool list includes them. Recorded conversations resume when available. Enable the Session Bus and grant Manager using its project-specific confirmation in the interface.

For example, ask the authorized advisor:

> Schedule a weekday briefing at 09:00 local time. Read the notes in this project and save the briefing as a Markdown document here. Check the saved task and tell me its next run time.

The advisor can call `list_scheduled_tasks` to check the machine's time zone, then `create_scheduled_task` with `name`, `prompt`, `cadence`, and `time`. The agent defaults to the caller's agent; it may explicitly select `codex` or `claude`. New tasks default to enabled. Weekly tasks also require `weekday` (0 Sunday through 6 Saturday). Creation and editing return the durable task record, including its ID and next run time. The task appears in the project's **Scheduled** view, where the user can also edit, pause, run, or remove it.

Each run starts a new conversation with a self-contained task prompt and saved project instructions. It does not inherit the advisor's conversation, and it uses normal CLI approvals. Workbench must remain open; sleeping or closed computers do not run tasks. Missed occurrences are coalesced into one catch-up run. The scheduler supports daily, weekdays, and weekly recurrence, not arbitrary cron or one-time reminders.

The manager cannot choose another project, override the working folder, or raise execution permissions. Task IDs from another project are refused without revealing their contents. Pausing or revoking Manager does not stop a run already launched. Revoking Manager blocks further tool calls; saved schedules remain visible and enabled until paused or removed in Scheduled.

## Implementation and checks

The MCP server uses the existing authenticated loopback bridge and Node built-ins; there are no additional dependencies or listeners. Each session receives a distinct credential derived from a private, persisted signing key. Credentials are checked against the caller's ID and never appear in renderer state or MCP command arguments. A shared hook token alone is insufficient to impersonate a manager.

This is an application permission boundary, not an OS sandbox between processes owned by the same account. An agent with unrestricted access to the user's files or processes can access other local resources outside the bus. Workbench's Manager grant does not grant that OS access.

Codex's stdio MCP launch explicitly forwards the three required session variables and sets a tool timeout long enough for bus waits. These settings follow the [official OpenAI MCP configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). The allowlist matters: a server can successfully advertise tools while lacking the environment needed to execute any of them.

Run `npm run verify` for typechecking, the production build, and regression tests. The bus tests cover real HTTP and generated MCP stdio transport, credentials, project isolation, management, revocation, and role persistence. Scheduling tests exercise the real task store behind MCP, durable saves, due runs, project isolation, partial edits, pausing, deletion, and normal launch approvals. The relay tests cover delivery, timeouts, busy recipients, stale turn signals, permission revocation, and deadlock prevention. See the system audit for the earlier desktop test results.
