#!/usr/bin/env bash
# Workbench on Windows — one-command setup, run inside Ubuntu on WSL 2.
#
# Curl-able, so it works before the repo exists:
#   bash <(curl -fsSL https://raw.githubusercontent.com/keeganarko/workbench-classic/main/scripts/bootstrap-wslg.sh)
#
# Or from an existing checkout:
#   ./scripts/bootstrap-wslg.sh
#
# Idempotent: safe to re-run. It skips anything already done rather than
# reinstalling, so it doubles as a repair tool when something drifts.
#
# What it deliberately does NOT do: authenticate the agent CLIs. That is
# interactive and opens a browser, so it stays a human step and is printed at
# the end. Everything before that point is unattended.

set -euo pipefail

REPO_URL="${WORKBENCH_REPO:-https://github.com/keeganarko/workbench-classic.git}"
TARGET="${WORKBENCH_DIR:-$HOME/Dev/workbench}"
NODE_MAJOR=22   # doctor requires 20+; 22 is the tested line

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()   { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
step()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ── 0. Refuse to run in the wrong place ───────────────────────────────────────
# Every one of these failures produces a confusing error much later if it is not
# caught here. The /mnt/c check is the one people actually hit: the repo works
# there but file watching and npm are slow enough to feel broken.

step "Checking the environment"

[ "$(uname -s)" = "Linux" ] || die "Run this inside Ubuntu on WSL, not Windows PowerShell and not macOS."

if ! grep -qi wsl2 /proc/sys/kernel/osrelease 2>/dev/null; then
  grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null \
    && die "This is WSL 1. Workbench needs WSL 2: run 'wsl --set-version Ubuntu 2' in PowerShell." \
    || warn "Not detected as WSL. Continuing, but WSLg is required for the window to appear."
fi
ok "WSL 2 ($(tr -d '\0' < /proc/sys/kernel/osrelease | head -c 40))"

if [ -z "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]; then
  warn "No WSLg display detected. The app will build but the window cannot open."
  warn "Fix: run 'wsl --update' in PowerShell, then 'wsl --shutdown', then reopen Ubuntu."
else
  ok "WSLg display (${WAYLAND_DISPLAY:-$DISPLAY})"
fi

case "$TARGET" in
  /mnt/*) die "$TARGET is on the Windows drive. Use a Linux path like ~/Dev/workbench — /mnt/c is slow enough to look broken." ;;
esac

# ── 1. System packages ────────────────────────────────────────────────────────
# Electron needs a pile of X/GTK shared libraries that a default Ubuntu WSL
# image does not ship. Missing one produces a silent exit or a bare
# "error while loading shared libraries" with no hint that it is Electron's.

step "Installing system packages"

APT_PKGS=(git tmux build-essential python3 ca-certificates curl
          libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0
          libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64)

missing=()
for p in "${APT_PKGS[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
done

# libasound2t64 is Ubuntu 24.04+; older releases call it libasound2.
if [ ${#missing[@]} -gt 0 ]; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${missing[@]}" 2>/dev/null \
    || sudo apt-get install -y -qq "${missing[@]/libasound2t64/libasound2}"
  ok "installed ${#missing[@]} package(s)"
else
  ok "all present"
fi

# ── 2. Node.js ────────────────────────────────────────────────────────────────
# Ubuntu's own nodejs package is far too old on most releases. NodeSource is the
# route the Node project itself documents.

step "Checking Node.js"

need_node=1
if command -v node >/dev/null 2>&1; then
  cur=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$cur" -ge 20 ]; then ok "Node $(node -v)"; need_node=0
  else warn "Node $(node -v) is too old (need 20+)"; fi
fi

if [ "$need_node" -eq 1 ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs
  ok "Node $(node -v)"
fi

# ── 3. The repository ─────────────────────────────────────────────────────────

step "Getting Workbench"

if [ -d "$TARGET/.git" ]; then
  git -C "$TARGET" fetch --quiet origin
  # Only fast-forward. A rebase or reset here could destroy local work, and this
  # script is also run as a repair tool on a machine that may have edits.
  if git -C "$TARGET" merge --ff-only origin/main --quiet 2>/dev/null; then
    ok "updated to $(git -C "$TARGET" log --oneline -1)"
  else
    warn "local changes or diverged history — leaving the checkout alone"
    warn "  at $(git -C "$TARGET" log --oneline -1)"
  fi
else
  mkdir -p "$(dirname "$TARGET")"
  git clone --quiet "$REPO_URL" "$TARGET"
  ok "cloned to $TARGET"
fi

cd "$TARGET"

# ── 4. Working memory ─────────────────────────────────────────────────────────
# context/ holds agent decision notes and is deliberately local: excluded via
# .git/info/exclude rather than a tracked .gitignore, so no repo gains a diff
# and nothing reaches GitHub. info/exclude is not versioned, so a fresh clone
# has to recreate it — which is exactly this step.

step "Setting up working memory"

mkdir -p context/inbox
if ! grep -qxF 'context/' .git/info/exclude 2>/dev/null; then
  printf '\n# Agent working memory, harvested by the librarian. Local only.\ncontext/\n' >> .git/info/exclude
fi
[ -f context/inbox/.keep ] || touch context/inbox/.keep
ok "context/ ready and git-excluded"

# ── 5. Dependencies and verification ──────────────────────────────────────────

step "Installing dependencies (a few minutes on first run)"
npm ci --no-audit --no-fund
ok "installed"

step "Running the doctor"
npm run doctor:wslg || true   # non-fatal: CLI auth is the usual gap and comes next

step "Verifying the build"
if npm run verify >/tmp/wb-verify.log 2>&1; then
  ok "typecheck, build and tests all pass"
else
  warn "verify failed — see /tmp/wb-verify.log"
  tail -15 /tmp/wb-verify.log
fi

# ── 6. Agent CLIs ─────────────────────────────────────────────────────────────
# Windows-host binaries are not on the PATH that Workbench launches, so these
# must exist inside WSL even if they are already installed on Windows.

step "Agent CLIs"

for pkg in "claude:@anthropic-ai/claude-code" "codex:@openai/codex"; do
  bin="${pkg%%:*}"; name="${pkg##*:}"
  if command -v "$bin" >/dev/null 2>&1; then
    ok "$bin already installed"
  else
    warn "$bin not found — installing $name"
    sudo npm install -g "$name" --silent 2>/dev/null && ok "$bin installed" \
      || warn "could not install $name; run: sudo npm install -g $name"
  fi
done

# ── Done ──────────────────────────────────────────────────────────────────────

bold ""
bold "═══════════════════════════════════════════════════════════"
bold " Workbench is installed at $TARGET"
bold "═══════════════════════════════════════════════════════════"
cat <<EOF

Two things left, both interactive, both one-time:

  1. Authenticate the agents. These open a browser and must be run
     inside Ubuntu — Windows credentials are not shared with WSL:

       claude          # then follow the login prompt
       codex           # same

  2. Start it:

       cd $TARGET && npm run dev

To get a Windows Start-menu shortcut, run this in PowerShell (one line):

  wsl.exe -d Ubuntu -- bash -lc "cd $TARGET && npm run dev"

Re-run this script any time to repair or update the install.
EOF
