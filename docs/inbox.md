# Inbox

Inbox separates three kinds of session updates:

- **Needs input:** a current question or approval request. The card shows the captured request and opens that exact terminal to answer it.
- **Problems:** a reported error, shown separately from questions.
- **Updates:** a completed turn's captured response. These entries do not require a reply and do not prove the overall task is complete.

Project filters and counts use the same active-session queue. Archived sessions stay out of it. Missing or incomplete captures are labeled, with a direct route to the source terminal.

**Mark reviewed** acknowledges an update. **Clear status** dismisses a mistaken or already-handled indicator. Neither action stops a process, removes a terminal, sends a reply, or approves a tool. If a newer question arrived, the acknowledgment is refused so the newer request remains visible.

The status engine uses structured lifecycle events for live approvals. Completed Codex turns inspect the final request addressed to the person; quoted examples, ordinary progress reports, optional follow-up offers, and agent-to-agent relay replies do not become questions merely because they contain “Please confirm.” Free-text question detection is still heuristic; the source terminal remains available.

Native notifications suppress identical repeats during the same status episode, including after a banner is dismissed. Returning to work, clearing an entry, or removing its session withdraws stale banners. A new request may notify again, even if its wording matches an earlier one.

No extra model calls, background terminal clients, external services, or dependencies are used by Inbox.
