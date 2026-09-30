# Background services

Open **Services** in the sidebar or a project's tabs. Each saved service has a name, project, working folder, PowerShell or Bash command, and an optional **Start when Workbench opens** setting. Save and start it once; its process continues when you change tabs. Start, Stop, Restart, and recent output stay on its card.

PowerShell runs on Windows. Bash uses Workbench's existing WSL host on Windows and the local shell on macOS/Linux. Run servers in the foreground so their lifetime remains attached to their service. Quitting Workbench stops its owned service processes and descendants. Agent terminal sessions retain their existing tmux lifecycle. A failed stop keeps Workbench open and shows a retryable error.

The Running label means the shell is alive. Confirm application readiness using its log and connection status. Exit codes and launch/cleanup failures remain visible. Recent output is limited to 64,000 characters per service and kept only for the current application session. Saved commands belong in the local services.json file, outside Git; credentials should be injected through the approved local environment rather than pasted into commands.

Services are distinct from Scheduled, which starts agent conversations at scheduled times. Opening the Services view never starts a command. App startup runs only definitions explicitly marked to start with Workbench. The feature adds no Session Bus tools or agent permissions.

Mission Control's cockpit and its approved status bridge can run as separate services. Preserve their existing Windows task definitions when transferring ownership; stop the old instance before starting a Workbench-owned instance so the port and publisher are not duplicated. The brokerage gateway and its provider login remain separate.

## Development validation

The service manager has independent persistence, validated IPC and disk input, serialized lifecycle operations, duplicate prevention, bounded logs, and process ownership checks. Synthetic tests exercise native PowerShell Jobs and POSIX process groups, child cleanup, failed startup/stop, restored definitions, and corruption preservation. The renderer was checked with fictional services and narrow/light/dark layouts.

This local delivery does not publish changes to either machine branch. There is no new remote commit for the other machine to pull yet. After an explicit future publication to Mac-OS, its usual update is `git switch Mac-OS`, `git pull --ff-only`, and `npm run verify`, followed by the normal Mac packaging/install workflow.
