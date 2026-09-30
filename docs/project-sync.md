# Share a project folder

Workbench Beta can automatically exchange saved project files with another
person running Workbench. Sharing uses a private GitHub repository. Each person
keeps a local folder, and Workbench checks for saved changes every 15 seconds
while the app is open.

## Start sharing

Install Git and GitHub CLI on the session host and sign in with `gh auth login`.
On Windows, run that command inside the Ubuntu/WSL distro Workbench uses.
On macOS, use the Mac terminal. GitHub stores the login; Workbench does not copy
its credentials into project files or app settings.

1. Open the project and choose **Share project**, or right-click its name and
   choose **Share project…**.
2. Choose **Share this folder**, enter a new private repository name, and click
   **Review files to share**.
3. Review the actual filenames, confirm automatic sharing of future eligible
   saved changes, then click **Create private share**.
4. Enter your friend's GitHub username and click **Send invitation**.
5. Your friend accepts the invitation on GitHub. They create a Workbench project
   pointing to an empty local folder, open **Share project**, choose **Join a
   shared project**, and enter the repository address shown in your dialog.

A GitHub username is required for invitations in this version. Email invitations
and a separate Workbench account service are not implemented. Creating a share
or sending an invitation requires the corresponding button click; opening the
sharing dialog does neither.

## What syncs

Eligible saved files sync both ways, including additions, edits, and deletions.
This is file synchronization, not simultaneous character-by-character editing.
Terminal sessions, prompts, agent permissions, project scheduling, credentials,
and local Workbench settings remain on each person's computer. Individual
terminal sharing remains a separate feature.

The file review excludes Git history, Git-ignored files in Git repositories,
dependencies, generated build folders, common credential filenames, symbolic
links, and `.github` workflows. Plain folders use Workbench's built-in
exclusions; they have no Git repository ignore rules. Review the list before
sharing: exclusion rules cannot identify every file containing private data.

Limits are 20 MB per file, 100 MB and 3,000 eligible files per project, with
portable Windows/macOS names. Large batches containing over 40 binary/blob
uploads are refused; choose a smaller shared folder. File contents are synced;
Unix executable-bit changes, empty directories, symlinks, and Git branches are
not synchronized. Existing local file modes are retained when files are replaced.

## Conflicts and recovery

If both people change the same file since the last agreed version, Workbench
keeps the local file and shows a conflict. **Keep mine** publishes the local
version; **Use shared** applies the latest shared version. Delete/edit conflicts
also require a choice. Replaced and deleted local files are backed up under
`sync-backups/<project-id>/` in Workbench's data directory. The private GitHub
repository also retains commit history.

Offline and permission errors leave local changes available for the next pass.
**Pause sync** stops new sync work. **Disconnect this computer** keeps local files
and the GitHub repository. Changing the project's local folder stops applying
updates until you disconnect and review a new connection. Deleting a Workbench
project disconnects it and keeps both the folder and its terminals.

To revoke a friend's repository access, use the private repository's GitHub
settings. Workbench reports loss of access on its next request. As with other
file-sharing systems, revocation does not remove copies already downloaded.

## Implementation and validation

`src/main/projectSync.ts` keeps a durable comparison baseline for each file.
It compares local content hashes and remote blob IDs, backs up replacements,
and publishes a new commit with a non-forced branch update. Concurrent writers
must compare against the new remote state before retrying. The project's own
Git checkout, index, remotes, and branches are never changed by sync.

The publication follows GitHub's [Git tree API](https://docs.github.com/en/rest/git/trees#create-a-tree)
and [reference update API](https://docs.github.com/en/rest/git/refs#update-a-reference).
Automated tests use two real local folders with an in-memory remote to exercise
round trips, binary files, deletion, conflicts, offline recovery, restarts,
revocation, ignore rules, and concurrent publication. API request tests verify
batching and non-forced reference updates. Live desktop checks verify the
sharing dialog. No personal project was uploaded or friend invited during the
audit; a live two-account GitHub sync remains to be exercised by configured users.
