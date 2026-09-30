# Workbench beta: first-time Windows setup

These steps set up Workbench from source on Windows. You can follow them yourself, or paste them into Claude Code running in the Windows computer's terminal and let it install the prerequisites, clone the code, build an installer, and check the result. You still handle account sign-in yourself.

The result is a native Windows desktop application with an `.exe` installer and Start Menu/desktop shortcuts. Workbench's terminal engine runs tmux and the coding assistants inside Ubuntu on WSL 2. That background dependency is part of the current native Windows implementation. The app's window runs on Windows. See the [native Windows implementation](https://github.com/keeganarko/Workbench/blob/Windows/docs/windows-native-audit.md).

| Part | Where it belongs |
| --- | --- |
| Git checkout and build tools | Windows local drive; normally `C:\Users\<name>\Dev\workbench-beta` |
| Node, npm, Electron, and app dependencies | Windows-native installation, matching the processor architecture |
| Installed application | Windows; the installer creates its shortcuts |
| tmux and Claude Code sessions | Ubuntu inside WSL 2 |
| Session projects | Prefer Ubuntu's `~/Dev`; the native app can address them through `\\wsl.localhost\Ubuntu\home\<linux-user>\Dev` |
| Workbench session data | Normally `/home/<linux-user>/.config/Workbench` in the selected distro; confirm from the actual installation |

**1. Prepare Windows and Ubuntu.**

Claude should inspect the Windows version and processor architecture and install Windows Git plus the latest Node.js 22 patch release (at least 22.16). The checked-in lockfile requires Node 22.16.0 or newer for its rebuild tooling; the repository's CI uses Node 22. Use the matching Windows installer from [Node.js](https://nodejs.org/en/download) and [Git for Windows](https://git-scm.com/downloads/win). A recent supported Windows installation is the intended starting point.

From PowerShell, inspect WSL before changing it:

```powershell
wsl.exe --version
wsl.exe --list --verbose
```

If Ubuntu/WSL is missing, use an administrator PowerShell for installation:

```powershell
wsl.exe --install -d Ubuntu
```

Complete any requested restart, then open Ubuntu and create its Linux user and password. Update WSL as needed and confirm Ubuntu is listed as version 2. Microsoft's installation command supports Windows 10 version 2004/build 19041 or later and Windows 11; older systems require a different installation procedure. [Microsoft WSL installation instructions](https://learn.microsoft.com/en-us/windows/wsl/install).

If multiple distros already exist, select one deliberately and ensure the installed Workbench app uses it. The code supports `WORKBENCH_WSL_DISTRO`; a temporary setting in a build terminal alone will not configure a future Start Menu launch. Preserve existing distro choices where possible.

**2. Install the terminal tools inside Ubuntu.**

These commands belong in the Ubuntu terminal:

```bash
sudo apt update
sudo apt install -y tmux git curl ca-certificates
curl -fsSL https://claude.ai/install.sh | bash
```

Follow the installer's PATH instructions, reopen the Ubuntu shell if needed, and run:

```bash
command -v tmux
tmux -V
command -v claude
claude --version
claude
```

Your friend signs in personally. Verify that `claude` resolves to the Linux installation. The native installer is Anthropic's documented installation route for WSL. A Windows Claude installation can help with setup, while Workbench needs the CLI inside its session distro. [Claude Code setup](https://code.claude.com/docs/en/setup).

Codex is optional for a first Claude session. If your friend uses it, configure and authenticate it inside the same distro, including any Linux prerequisites its installation method needs.

**3. Clone the beta on the Windows drive.**

Return to a normal Windows PowerShell. Confirm these tools are Windows-native:

```powershell
Get-Command git, node, npm.cmd
node --version
node -p "process.platform + ' ' + process.arch"
```

The platform must be `win32`. In a new destination, clone explicitly:

```powershell
$workbenchDev = Join-Path $env:USERPROFILE 'Dev'
New-Item -ItemType Directory -Force -Path $workbenchDev | Out-Null
Set-Location $workbenchDev
git clone https://github.com/keeganarko/workbench-classic.git workbench-beta
Set-Location .\workbench-beta
git remote get-url origin
git branch --show-current
git rev-parse --abbrev-ref '@{upstream}'
git rev-parse HEAD
```

The branch must be `Windows`, tracking `origin/Windows`. If the destination exists, inspect it before proceeding; preserve any existing work. Read the repository instructions and `docs/windows-native-audit.md` before installation.

The checkout belongs on a Windows-local drive because native Windows build tools cannot reliably use a WSL UNC working directory. Install its dependencies on Windows; a Linux `node_modules` directory can load the wrong native terminal binary. These are documented build constraints in the repository's native Windows audit.

**4. Verify and build the Windows installer.**

Run each command in Windows PowerShell from the checkout and inspect its result before continuing:

```powershell
npm.cmd ci
npm.cmd run verify
npm.cmd run dist:win
Get-ChildItem .\release\Workbench-Setup-*.exe
```

`verify` runs the typecheck, build, and tests. `dist:win` builds the native Windows NSIS installer. Match the output architecture to the computer. The existing postinstall script uses Windows node-pty prebuilds, and packaging preserves the native files outside the Electron archive.

Some test fixtures carry POSIX assumptions and a possible signing-tool extraction failure caused by Windows symlink permissions. Claude should diagnose the exact output, make necessary compatibility fixes with meaningful tests, and record any remaining failures. A Linux test run does not establish that Windows tests pass. If a packaging permission issue occurs, follow the audit's applicable fix and obtain any required system approval. A failed installer build is still a failed installer build even if an unpacked app folder exists.

This installation uses `main` and `dist:win`. `doctor:wslg` checks a different runtime and should not be used as a native Windows readiness gate.

**5. Install and check the real app.**

Run the generated `Workbench-Setup-<version>-<architecture>.exe` and complete the per-user installer. Open Workbench through its installed Start Menu shortcut, so the check exercises the application your friend will actually use.

- The beta Home, Inbox, Terminals, Scheduled, Outputs, and project Context are present.
- Create a test project in a usable folder and start a Claude session.
- Send a simple prompt and confirm a response and session status updates.
- Create a small Markdown file in the session folder and check its preview.
- Test window controls, keyboard input, and clipboard behavior.
- Quit and reopen Workbench; confirm saved state and the tmux session reconnect.

Claude should identify anything it could not observe and let your friend complete that check. The installed shortcut must work without keeping a development server terminal open. Scheduled tasks run only while Workbench is open on this computer.

**6. Reopen, update, and preserve data.**

To reopen, use the Workbench Start Menu or desktop shortcut.

For an update, first quit Workbench gracefully and back up the actual Workbench data directory in its selected WSL distro, normally `/home/<linux-user>/.config/Workbench`. Preserve any local compatibility fixes. From the Windows checkout, inspect the branch and working tree:

```powershell
Set-Location (Join-Path $env:USERPROFILE 'Dev\workbench-beta')
git branch --show-current
git status --short
```

When the checkout is on `Windows` and local changes are safely accounted for, run each step and stop to resolve any failure:

```powershell
git pull --ff-only
npm.cmd ci
npm.cmd run verify
npm.cmd run dist:win
```

Run the newly generated installer again and reopen the installed app. Pulling source alone leaves the previously installed executable unchanged. Retain the previous installer and data backup for rollback; Git does not back up Workbench's runtime state.

tmux sessions survive quitting Workbench. They do not survive shutting down WSL or restarting Windows. Persisted Workbench records and an assistant's own saved conversations are different from live terminal processes.

This guide targets the promoted Windows branch. Record and verify the commit
actually installed. A setup guide does not establish that the installation
works on another person's hardware.
