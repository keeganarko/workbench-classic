# Workbench Beta updates

In **1.0.3-beta.2**, open **Updates** at the bottom of the project sidebar, or
**Settings → Updates**. When a newer Beta is available, **Update and restart**
downloads the right package, verifies it, saves your layout and unsent prompt,
installs the update, and reopens Workbench. It does not stop at a download folder.

Checks run about 15 seconds after startup, every four hours, and when you press
**Check for updates**. A check does not install anything. Your update click is
the instruction to download and restart. If a prompt is still sending at the
handoff, the verified update stays ready for **Restart to update** afterward.

## First installation and exceptions

**1.0.2-beta.1 and older builds still have their original updater code.** Their
Download update → Show installer flow needs to install 1.0.3-beta.2 once before
the new one-click behavior is available. A 1.0.0 app without Updates needs a
manual installation too. Get the [current Beta installers](https://github.com/keeganarko/workbench-classic/releases/tag/v1.0.3-beta.2).

Normal unsigned Beta installations can replace themselves with another verified
unsigned Beta. Published packages contain a size and SHA-512 checksum in the
Beta manifest. Downloads come only from the expected GitHub repository and its
HTTPS release hosts. Both download and installation check the bytes.

Signed installations never silently downgrade to unsigned packages or accept
a different publisher. That transition uses the manual installer. Operating
system application controls remain in effect; the updater does not remove
quarantine, disable signature validation, or change security settings.

Windows agent connections can use Workbench's executable as a Node runtime.
Finish those sessions before replacement: the helper refuses an install that
would terminate them. Ordinary tmux terminals retain their reconnect behavior.
On macOS, automatic replacement supports Workbench in `/Applications` or the
user's `Applications` folder with write access. Other locations or system
restrictions can require manual installation.

## What installation does

The renderer checkpoints the latest unsent prompt, project, recipients and
layout after the download finishes. A storage failure aborts the handoff. Main
checks that its store saves and stops Services before launching the installer; the normal quit path
flushes state and detaches tmux clients. Project files and app data live outside
the application being replaced.

On Windows, a detached PowerShell helper verifies the download, checks signing
state and active agent connections, then confirms readiness. It waits for the
old process to exit, rechecks the package, runs the installer silently against
the existing directory, and relaunches the application. Unsigned installation
requires an actually unsigned current executable and downloaded installer;
a broken or unexpected signature is never treated as unsigned.

On Mac, matching signed builds use Electron's native Squirrel updater and a
verified version-specific feed. An unsigned Beta DMG is verified and staged
beside the installed app before shutdown. The staged app must have valid ad-hoc
code integrity, the expected bundle identity, version and processor. A detached
helper waits for graceful exit, swaps the bundles, and relaunches with the system
application launcher. Failed replacement rolls back to the previous bundle.

Helpers preserve an installation error log if they cannot finish. On the next
launch, Workbench surfaces that error before an ordinary release check can hide
it. No success is inferred just because the old process exited.

## Publish a Beta

A branch push or version tag alone never distributes an update. **Publish Beta**
is an explicit GitHub Actions workflow; its default is a build-only rehearsal.

1. Update both package versions, for example
   `npm version 1.0.3-beta.3 --no-git-tag-version`.
2. Verify the source and push the reviewed commit to `main`.
3. Run [Publish Beta](https://github.com/keeganarko/workbench-classic/actions/workflows/release.yml)
   from either machine branch with the exact version and release notes.
4. Leave publishing off for a rehearsal, or enable **Publish update to users**
   to distribute. This builds Mac Apple silicon/Intel and Windows ARM64/x64 on
   native runners. Every package must pass before publication.

The publisher verifies every package's source commit, version, size and checksum,
uploads a draft, and publishes the complete GitHub prerelease last. Apps discover
that release through `workbench-update.json`. Published versions are immutable;
fix a released build with a higher version, never by replacing its assets.

For signed distribution, configure repository Actions secrets:

| Platform | Secrets |
| --- | --- |
| Mac | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |

Signing must succeed when configured. Signed Mac distribution also requires
notarization. Keep credentials in GitHub's secret settings.

## Source checkouts on the other machine

Installed-app updating does not pull your development checkout. On the Mac,
with local edits preserved:

```sh
git fetch origin --prune
git switch main
git pull --ff-only origin main
npm ci
npm run verify
```
