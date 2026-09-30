**Share project: what you and the other person see today**

Workbench shares eligible saved files through a private GitHub repository. Each computer has its own Workbench project and local folder connected to that repository. Your screens, terminals, and conversations remain separate.

**On your current computer**

1. Open a project and click **Share project**, or right-click its name in the sidebar and choose **Share project…**.
2. Select **Share this folder** and enter a new private repository name.
3. Click **Review files to share**, inspect the filenames, and check the box agreeing to share these files and future saved changes.
4. Click **Create private share**. The dialog then shows a repository address such as `https://github.com/your-name/workbench-notes`.

**On your MacBook**

With Workbench, Git, and GitHub CLI installed, sign in to GitHub in the Mac terminal:

```sh
gh auth login
```

Use the same GitHub account as the computer that created the share; you do not need to invite yourself. If already signed in to that account, skip this step.

Create a new, empty folder, then create a Workbench project pointing to it. Open **Share project → Join a shared project**, paste the repository address, and click **Join and start syncing**. Joining requires an empty folder, including when your Mac already has another copy of the project. You choose the local project name and folder independently.

**On your friend's computer**

In your sharing dialog, enter their GitHub username and click **Send invitation**. Your friend accepts the invitation on GitHub, signs GitHub CLI into their own account, and follows the same empty-folder joining steps in Workbench. On Windows, Git and GitHub CLI need to be available inside the Ubuntu/WSL environment Workbench uses.

The repository address opens GitHub in a browser. It does not automatically open Workbench or add a project to their sidebar. This version has no incoming-project invitation popup in Workbench.

**What appears on their screen after joining**

| Where they look | What they see |
| --- | --- |
| Left sidebar → Projects | The ordinary project entry they just created, with their chosen name. |
| Project → Terminals | Their local terminals. A fresh project starts with none; your conversations are not imported. |
| Project → Share project | The shared repository address, **Up to date** and a last-sync time after successful sync, plus **Sync now**, **Pause sync**, and **Disconnect this computer…**. Errors and conflicts appear here too. |
| Project → Outputs → Find recent files | Previewable documents downloaded into their project folder. Clicking a document opens it in their preview pane. Your output history and source-terminal links do not transfer. |
| Files panel in a terminal started in that folder | The local project files. Use the refresh button, **Re-read the folder**, if the listing is stale. |

For example, save an eligible `plan.md` on your desktop. Workbench uploads it; the MacBook or friend's Workbench downloads it on a subsequent sync. They can find and open it, edit it through their own agent or editor, and send saved changes back through the same process.

Each running app checks every 15 seconds, so a change needs an upload pass and a download pass; it is not instantaneous. A computer can catch up after reopening Workbench. If both computers change the same file differently, the sharing dialog asks **Keep mine** or **Use shared** and preserves a backup before replacing local content.

Dependencies, build folders, Git history, common credential files, and other excluded paths do not sync. Workbench project settings, Context-tab data, schedules, and agent permissions stay local. Invitation access allows your friend to publish saved file changes too.

**If you want someone to watch your terminal**

Use the separate session-sharing icon in the title bar. That creates a browser link to one terminal's rendered screen, with viewing by default and typing enabled only when you grant it. It requires a working public tunnel to reach another computer. Project sharing itself does not mirror your screen.

Checked against the current [sharing dialog](../src/renderer/src/components/ProjectShareDialog.tsx), [workspace UI](../src/renderer/src/components/ExperienceShell.tsx), [Outputs view](../src/renderer/src/components/ExperienceViews.tsx), and [sync engine](../src/main/projectSync.ts). All 12 focused project-sync tests passed on this checkout. They use a simulated remote; no live GitHub share or invitation was created for this walkthrough. See also [project-sync details](project-sync.md) and [terminal-sharing details](sharing.md).
