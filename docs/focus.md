# Focus: one central agent and all your projects

Open **Focus** in the main sidebar for the central conversation and project previews. Click the central agent’s name or drawing to show **Projects**; choose **Agents** for all sessions, including unfiled sessions. A project filter opens that project’s board. Projects still open to Terminals by default.

Choose one terminal in **Set up App Manager**, turn on **Enable agent communication**, select **App Manager**, and confirm the grant. You can also open **Permissions** from the shield at the top left. Start or restart that terminal after enabling communication so it connects with the current tools. Focus sends your message only to the selected central agent. Failed sends keep the draft. If several App Managers exist, explicitly choose the recipient. **Open conversation** returns to its real terminal.

Focus shows only projects with a live, unarchived session. Idle, waiting and
review sessions still count as ongoing work; stopped or archived sessions do
not keep a project on the board. Projects enter and leave on the existing
state stream, before any report images are loaded. Other views retain all
projects and their saved history.

Each update can carry its own PNG, JPEG, WebP or SVG: a screenshot of the
actual result, a diagram with concrete names and measurements, or an
illustration made for that milestone. Focus does not select a picture from
task categories. The latest report supplies the image, summary, date and next
action together. A new report replaces them together; an image from an older
report is never reused as evidence for a newer one. Older reports with steps
or metrics retain those values without generic decoration.

Images are copied from the reporting session's real folder into a separate
immutable file for each report, up to 4 MB. Rewriting the source image for the
next update does not rewrite history. SVG loads as an image, never an HTML
frame. Image copies follow the existing report retention limit; project
originals are preserved. Archiving a worker retains its attributed project
history; removed or moved authors cannot transfer old reports.

An App Manager reads the same bounded selection through `get_project_progress`, then directs workers inside their actual projects. It does not need a manager per project.

Each session gets a stable card showing its role, provider, live state, a small
visual, a short update, recent milestones and its latest visual output. **Needs
you** filters input requests and failures. **Compact view** hides the milestone
list. **Open terminal** returns to that existing session; it does not launch a
replacement. Archived and stopped sessions stay out of the worker roster.

Status and recorded output changes arrive through Workbench's existing update
stream. Agents use `publish_focus_update` whenever meaningful progress changes:
a useful discovery, a design revision, a verified fix, a blocker or a completed
milestone. A long turn can contain several updates. There is no fixed timer,
and agents should not wait for the final reply or report routine tool calls.
Only completed milestones use the milestone label. These are agent reports;
they do not change live status, verify a result, or grant permissions.

The new tool is announced when an agent connects to the session bus. Existing
agents keep their sessions and automatic activity cards after an app update;
new agents, or an agent whose MCP connection is refreshed, also receive the
reporting tool and guidance. Read, Full, Project Manager and App Manager grants can publish only the
caller's own project card. See [the session bus guide](session-bus.md).

The board creates no additional model calls, terminal processes, transcript
scanners, or document frames. Agents create images during their existing work;
opening Focus does not launch image generation. It renders at most twelve
agent cards per page. Observed
history is bounded to eight events per session and 240 total; authored reports
are bounded to six per session and 240 total. Full output documents load through
the existing preview service only when opened. Live terminals remain mounted
when changing views.

Observed history records events while a window is open and is not a complete
activity audit. Project ownership is saved with each event/report/output, so
moving a terminal does not move its earlier project's history into another
project. Dates come from the event or report, rather than ongoing terminal noise.

The former Auto / Focus / Cols / Rows toolbar is now one Focus board entry. Saved
layouts remain compatible, and the Arrange Panes menu retains layout presets;
the old one-large-pane Focus preset is labelled **Spotlight** there.
