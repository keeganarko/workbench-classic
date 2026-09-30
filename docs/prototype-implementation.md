# Desktop experience implementation

Promoted to Workbench Beta on both machine branches on 2026-09-04. This filename
is retained for existing links; the prototype branch is retired.

## Problem and goals

The owner wants the animated Workbench concept to be the usable desktop app,
not a document beside the old interface. Preserve the CLI/tmux experience while
making projects, attention, outputs, and scheduled work visible and navigable.

Success means: open the redesigned home on this desktop; create a real project;
filter and open existing terminals without restarting their agents; save context;
create, pause, and manually run a real scheduled task; retain the original Git
branches and a local data backup.

## User stories

- As the owner, I want projects organized by purpose, independently of folders.
- As a terminal user, I want a quiet task-name list, agent badges, and composable
  project/status/agent/search filters without losing splits, forks, or tools.
- As a reviewer, I want attention and document views connected to real sessions.
- As a user scheduling work, I want explicit permissions, host limits, and history.

## P0 requirements and acceptance

- The desktop uses a minimalist black, white, and gray shell in dark and light
  themes, with restrained color for status and no sample sessions.
- Overview, Inbox, Terminals, Scheduled, Outputs, and project Context work against
  real local state. Empty states explain their next action.
- Navigating away keeps terminal components alive; hidden panes are not reported
  as focused, and opening a session returns to the terminal workspace.
- Opening or creating a project defaults to Terminals without reordering tabs.
  Every project click chooses waiting, failed, then review work before falling
  back to the latest submitted prompt. Saved splits and other projects survive.
- Outputs has an explicit project selector and recorded source labels. Folder
  scans stay within that scope and cannot finish into a different project view.
- Project creation/editing and session filing use the existing project backend.
  Context is persisted separately and included in new agent launch prompts.
- Search, status, agent, project, and archive filters compose. Archiving changes
  visibility only, never kills a process or deletes a file.
- Schedules launch fresh Claude/Codex sessions using default approval permissions,
  never shell commands or inherited full-access preferences. No overlap per task.
  Missed intervals coalesce into one run; failures pause recurring work.
- Scheduled tasks are local to this machine and require Workbench to be running.
  No wake-from-sleep, remote host, or cloud scheduling is implied.
- Run records and output history persist. A launched task is not called complete
  until a real lifecycle signal indicates review; approvals remain visible.
- Preserve existing data and sessions; publish the same reviewed code to both machine branches.

## P1 and future work

P1: neutral light theme and compact density, per-output acknowledgment, folder
location guidance, explicit project edit actions and helpful error states.
Future: external scheduler host, full transcript search, sync, shared projects,
cron expressions, and attachment ingestion. They need separate architecture and
authority; this iteration does not pretend to implement them.

## Non-goals

- No replacement terminal renderer or chat emulator: existing xterm/tmux remains.
- No automatic folder consolidation or source deletion: folder bindings only.
- No auto-created agent work or schedules during rollout: the user creates them.
- No telemetry or new direct npm dependencies. Existing dependencies receive security updates.

## Verification and metrics

Leading acceptance: every core workflow passes a functional check; existing test
suite stays green; all pre-restart tmux sessions survive deployment. Negative
tests cover bad schedule inputs, overlaps, failed persistence, permissions,
archiving, missing projects, and context boundaries. Lagging validation is the
owner's next working session: can they organize and resume work without the old
layout? No usage tracking is added to measure this.

## Open questions and rollout

Non-blocking (owner): whether future scheduling should work with the app closed.
This implementation chooses app-open, local scheduling and labels it explicitly.
Engineering: verify the native Windows build and native terminal dependency on
this desktop, not merely the Linux compilation.

Implement and test the data layer, connect the shell, verify the app, snapshot
local state, deploy a separate Windows build, and launch it. Both machine branch
tips are `e9dca4e55f5fa3899597de96b9a3511dae00fa85` before this work. Git restores
source only; runtime state needs its own backup when rolling back.
