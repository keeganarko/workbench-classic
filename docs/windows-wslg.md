# Running Workbench on Windows through WSLg

Workbench's session engine is tmux. The supported Windows route therefore runs
the Linux build inside WSL 2 and presents its Electron window on the Windows
desktop through WSLg. This preserves detached sessions, hooks, logging, forks,
and the same Claude/Codex command lines used on macOS.

This is not a native Win32/ConPTY port. Do not copy the macOS `.app`, its
`node_modules`, or its runtime state to Windows.

## Quick start — one command

Install WSL 2 first (below), then run this inside Ubuntu:

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/keeganarko/workbench-classic/main/scripts/bootstrap-wslg.sh)
```

That script checks WSL 2 and the WSLg display, installs the system packages
Electron needs, installs Node 22 if yours is older than 20, clones the repo,
recreates the `context/` exclusion, runs `npm ci`, the doctor and the full
verify, and installs the agent CLIs. It is idempotent — re-run it to repair or
update an install.

It stops short of authenticating `claude` and `codex`, because that is
interactive and opens a browser. Those two commands are printed at the end.

The rest of this document is what the script does, in case you want to do it by
hand or something fails.

## 1. Install WSL 2 and Ubuntu

Run in an elevated Windows PowerShell, then restart Windows if prompted:

```powershell
wsl --install -d Ubuntu
wsl --update
```

Open Ubuntu and install the native dependencies:

```sh
sudo apt update
sudo apt install -y git tmux build-essential python3 \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64
```

The libraries after `python3` are Electron's, not Workbench's. A default Ubuntu
WSL image ships none of them, and a missing one makes the app exit silently or
fail with a bare `error while loading shared libraries` that never mentions
Electron. On Ubuntu 22.04 and older, `libasound2t64` is called `libasound2`.

Install Node.js 22.16+ or 24+ inside Ubuntu (the doctor enforces 20; 22 is the
tested line). Ubuntu's own `nodejs` package is too old on most releases — use
NodeSource:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Install the agent CLIs inside Ubuntu too:

```sh
sudo npm install -g @anthropic-ai/claude-code @openai/codex
```
 Authenticate them inside Ubuntu by running `claude` and `codex` once each;
Windows-host binaries and Windows credentials are not on the WSL `PATH`
Workbench launches.

## 2. Clone the Windows branch

Keep the checkout in the Linux filesystem. It is faster and avoids file watcher
and permission edge cases under `/mnt/c`.

```sh
git clone https://github.com/keeganarko/workbench-classic.git ~/Dev/workbench
cd ~/Dev/workbench
npm ci
npm run doctor:wslg
npm run verify
```

The doctor must find Linux, WSL 2, a WSLg display, tmux, and at least one agent
CLI before the app is ready.

## 3. Run or package Workbench

Development mode:

```sh
npm run dev
```

Unpacked Linux application:

```sh
npm run package:wslg
./release/linux-unpacked/workbench
```

Single-file AppImage:

```sh
npm run dist:wslg
chmod +x release/Workbench-WSLg-*.AppImage
./release/Workbench-WSLg-*.AppImage
```

WSLg integrates Linux GUI windows with the Windows taskbar and Alt-Tab. A
Windows shortcut can launch development mode with:

```text
wsl.exe -d Ubuntu -- bash -lc "cd ~/Dev/workbench && npm run dev"
```

## State and operating boundaries

- WSLg runtime state lives at `~/.config/Workbench` inside Ubuntu.
- tmux sessions live inside that WSL distribution and survive closing
  Workbench, but not `wsl --shutdown` or a Windows shutdown.
- Re-authenticate each CLI in WSL rather than copying credentials from macOS.
- Start with fresh Workbench state. macOS state contains absolute paths and
  descriptors for tmux sessions that do not exist in WSL.
- Repositories may live under `/mnt/c`, but `~/Dev` inside WSL is the preferred
  location for Git and agent workloads.
- Tray presentation, notifications, the global hotkey, Windows Explorer drag
  and drop, and clipboard images depend on WSLg integration and should be
  treated as host-specific features. Core terminal and session behavior is
  covered by the Linux CI job.
