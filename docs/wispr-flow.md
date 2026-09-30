# Dictate into Workbench with Wispr Flow

Use **Dictate** beside the prompt, or open **Settings → Wispr Flow**. The integration
can detect and open the desktop app, prepare the prompt, paste a copied transcript,
and match spoken filenames to real files in the selected session's project.

Workbench provides a normal prompt text box, terminal paste shortcuts, and accessible terminal text for desktop dictation tools. The compatibility changes are implemented in source. A live dictation check with the native Windows and macOS apps is still required; this is not a Wispr-certified IDE integration.

## Use it

Prerequisites: Wispr Flow installed on the same desktop as Workbench, and a Workbench build containing this change. On macOS, grant Microphone and Accessibility permissions to Flow as requested by Flow. Workbench does not record audio or call a transcription API.

1. Open **Settings → Wispr Flow** and use **Open Flow** to check your shortcut in Flow's settings.
2. Return to Workbench and click **Prepare prompt**, or use **Dictate** beside the prompt.
3. Use your configured Flow shortcut, dictate, and wait for insertion to finish.
4. Review the text and selected recipients, then send.

The command palette also has **Dictate prompt with Wispr Flow** and **Wispr Flow
setup**. Prepare prompt enables accessibility immediately. Open Flow opens the
app; it does not start recording. Installation detection is not an account login,
microphone permission check, or successful dictation test.

The composer is the recommended place for long prompts because the complete draft stays visible before sending. Input-method composition commits do not trigger Send. Standard paste preserves newlines in the draft.

For direct terminal input, click the terminal first. Workbench handles Ctrl+V, Ctrl+Shift+V, and Shift+Insert on Windows/Linux through the same bracketed-paste path. macOS uses the native Cmd+V menu role. Whether multiline terminal text is treated as a paste also depends on the foreground program supporting bracketed paste; the composer provides a separate review step.

## Accessibility

The dedicated Wispr Flow settings panel includes the same accessibility switch.

Settings → Terminal includes **Terminal accessibility and dictation support**, enabled by default. It enables Chromium’s native accessibility support and xterm’s screen-reader representation of the visible terminal rows. Existing terminals update when the setting changes.

The prompt and terminal input have stable accessible labels. Workbench uses standard editable controls instead of impersonating another editor or maintaining a separate hidden dictation draft. Turning off terminal accessibility also disables the explicit Chromium accessibility setting.

## Windows, WSL, and macOS

Run the native Windows Workbench application with Flow on Windows. Workbench’s terminal process may still run in WSL: the native Windows input surface forwards received text to that session. This architecture avoids relying on Flow to discover a Linux application window, but it still needs an actual native-desktop insertion test.

Wispr documents limitations for direct insertion into WSL/Linux windows. If using the older WSLg Workbench build, use Flow’s **Paste last transcript** action or **Copy last transcript**, then paste into the composer. Shortcut bindings can be customized; check Flow’s settings. On macOS, Flow needs Accessibility permission, and its native paste path is used.

These platform behaviors are described in [Wispr’s terminal guide](https://docs.wisprflow.ai/articles/6478598909-using-flow-with-linux-wsl-and-terminal-applications).

## Vibe coding: variable recognition and file tagging

Flow’s **Settings → Vibe coding** page offers **Variable recognition (VS Code, Cursor, Windsurf)** with a **Set up** dialog, and a **File Tagging in Chat (Cursor & Windsurf)** switch. Workbench mirrors the set-up flow with the same names, and stays honest about the parts that are Cursor-only.

### How Flow actually does it (verified against Flow 1.6.774)

- Flow’s helper process only runs its IDE pipeline when the focused window’s **process name** is Cursor, Code or Windsurf. It then looks for a status-bar control named exactly **Screen Reader Optimized** before reading the open file through the accessibility tree.
- Flow’s set-up dialog says: “Variable recognition reads your open file to better understand code as you dictate. It requires Screen Reader mode to be enabled in your IDE,” then lists three steps: open the Command Palette, run **Toggle Screen Reader Accessibility Mode**, and confirm the **Screen Reader Optimized** flag in the bottom bar.
- File tagging (“at”, “tag”, “@” plus a filename) is applied only in Cursor’s and Windsurf’s chat boxes.
- For every other app, including Workbench, Flow reads nearby text from the focused control and its ancestor document through the same accessibility tree. That is the generic path Workbench feeds.

Workbench cannot join the IDE list without modifying Flow. It does not spoof another editor’s process name.

### The same three steps in Workbench

| Flow’s step | In Workbench |
|---|---|
| Open the Command Palette | `Ctrl+K` (`⌘K` on Mac) |
| Search for and run **Toggle Screen Reader Accessibility Mode** | Same command name, in the palette. It toggles the existing terminal-accessibility preference. |
| Confirm the **Screen Reader Optimized** flag appears in the bottom bar | Same text, in the status bar while the preference is on. Clicking it turns the mode off. |

**Settings → Wispr Flow → Vibe coding** shows the current state, a **Set up** panel with those steps, and a toggle. When the flag is on, Electron accessibility support and xterm’s screen-reader rows are enabled, so Flow’s accessibility reader can see the terminal contents and the prompt while you dictate. The preference is on by default.

The window title now leads with the active agent’s label (“Claude Code · Workbench”, “Codex CLI · Workbench”). Flow’s coding-agent detection also reads window titles, and its confirmed terminal list (Windows Terminal, cmd, PowerShell, Warp, Alacritty, Hyper, kitty, WezTerm) does not include Workbench. Whether the title alone raises Flow’s confidence enough to chunk long Claude Code dictations the way it does in Windows Terminal is **not verified**; sessions run inside WSL, so Flow’s Windows process probe cannot see the `claude` process. Treat chunking as unconfirmed.

File tagging stays Workbench’s own: dictate the filename, then use **Find file references** (below). Flow’s automatic `@file` chips are not available outside Cursor and Windsurf.

## Prompt Engineer on every dictation

Flow’s **Prompt Engineer** transform rewrites a dictation into a structured prompt. Flow can apply a transform automatically to every dictation through **Auto Apply After Dictation**; the choice is saved in Flow’s own settings and is **global**, so it changes what Flow pastes into every app, not only Workbench.

To turn it on:

1. Open the menu on the Flow bar (the chevron, or right-click the bar) and choose **Auto Apply After Dictation**.
2. Select **Prompt Engineer**. **Configure transforms** in the same menu opens Flow’s Transforms page if you want to edit the prompt Flow applies.
3. In Workbench, open **Settings → Wispr Flow** and click **Check again**.

Workbench reads only the `autoPolishAfterDictation` entry from Flow’s `config.json` (Windows: `%APPDATA%\Wispr Flow`; through WSL: `/mnt/c/Users/<you>/AppData/Roaming/Wispr Flow`; Mac: `~/Library/Application Support/Wispr Flow`) and reports one of four states: Prompt Engineer applied, another transform applied, auto-apply off, or unreadable. It never writes that file: Flow rewrites it while running, so an outside edit would be lost or could corrupt Flow’s settings. Nothing else from the file is read into Workbench.

See [Wispr’s IDE integration guide](https://docs.wisprflow.ai/articles/6434410694-use-flow-with-cursor-vs-code-and-other-ides) and [xterm’s screen-reader option](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/#screenreadermode). No private Wispr protocol, account token, or unsupported plugin has been added.

## Workbench's file-reference helper

After dictating, choose one recipient and click **Find file references**. Workbench
matches phrases such as “index dot tsx”, “tag my parser”, or “cursor formatting dot
ts” against the files in that session's folder. Click the intended file to insert
its relative path in backticks. Ambiguous names offer the actual alternatives;
unknown names remain text. Existing code spans are left alone.

This is local matching after transcription, independent of Wispr's IDE tagging.
It reads filenames, not file contents. The existing session file tree excludes
links; the helper also excludes hidden entries, credential names, generated
folders, and dependencies. Git ignore rules are not interpreted by this file
tree. A bounded scan reports truncation and suggests at most eight phrases. A
changed draft or recipient invalidates an in-flight lookup.

## Transcript recovery

Use **Copy last transcript** in Flow, return to the helper, then click **Paste
transcript**. This reads the current system clipboard once; it does not retrieve
Flow history. It preserves the draft around the selection, keeps newlines, and
does not send. If the draft changes during the clipboard request, insertion stops
instead of overwriting the new typing. Recovery accepts up to 50,000 characters.

Flow may restore the previous clipboard after a paste, so explicitly copy its
last transcript before using this fallback.

## Desktop app and API

This integration uses the existing Flow app and requires no API key or additional
API subscription. Wispr also provides a [Voice Interface API](https://api-docs.wisprflow.ai/introduction)
with [separate usage billing](https://api-docs.wisprflow.ai/usage_billing); no API
account, key, recording, or audio upload was added here.

The Windows installation check found Flow 1.6.774 through WSL. Windows launch
arguments come only from the discovered installation path, with explicit quoting;
the renderer cannot name an executable. On Mac, the check validates the bundle
identifier in the standard Applications folders. Custom installations can be
opened manually.

## Desktop acceptance check

The automated checks cover shortcut classification, preference validation, and the application build. They cannot verify whether a running copy of Flow successfully targets the OS window.

On both native Windows and Mac, check a short phrase, a long multiline draft, insertion in the middle of an existing draft, and direct terminal paste. Verify exactly one insertion, preserved text around the caret, no unexpected submit, and the intended recipient. Try terminal accessibility both on and off. File-tagging and variable-recognition behavior must be recorded separately from successful text insertion.

For vibe coding: run **Toggle Screen Reader Accessibility Mode** from the palette, confirm **Screen Reader Optimized** appears and disappears in the status bar, and dictate a phrase that names an identifier visible in the terminal. Record whether Flow spelled it as shown. With **Auto Apply After Dictation → Prompt Engineer** chosen in Flow, confirm Settings → Wispr Flow reports it after **Check again** and that a dictation arrives rewritten. Neither result is claimed by the automated checks.

Rebuild and install the native application to use UI changes; running command-line AI tools from source does not update an installed Workbench bundle. Preserve the existing Windows and Mac-OS branch histories when syncing the change.
