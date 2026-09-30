# Claude and OpenAI usage meters

The **Usage** strip sits across the bottom of Workbench, directly above the status
bar. Claude and OpenAI each show **Session** and **Week** allowance remaining.
Each number explicitly says **left**. A provider badge shows **Live**, **Cached**,
**Last turn**, or **Unavailable**. Click the strip to open **Usage & allowance**,
with reset countdowns, model-specific limits when available, the reading time,
and a **Refresh** button. Failed checks show their retry timing instead of
leaving an old percentage looking current.

**Session** is the provider's five-hour account window. It is shared across your
sessions; opening another terminal does not give you a fresh allowance. A missing
window says **Not reported**. A reset that has passed says **Awaiting refresh** until
another provider reading arrives; Workbench never assumes that means 100% is left.

The details also show **Tokens · last 7 days** for each provider and **Tokens · this
terminal** for the focused Claude or Codex conversation once its CLI transcript is
available. Input includes cache reads and cache writes; those are broken out beneath
the total. Reasoning tokens are already included in output. Repeated transcript
snapshots and copied messages are deduplicated.

Token totals cover local CLI history, including usage outside Workbench that wrote
to the same history folders. They do not cover web chats or other computers, and
are not billing estimates. The rolling seven-day token total has its own time
range; it is not the same as the account's weekly reset period.

## Sources and refresh

- Claude allowance uses Claude Code's existing local sign-in. Its usage endpoint
  is undocumented and may reject or throttle lookups. The panel reports this
  explicitly and respects retry delays; recorded token totals still work.
- OpenAI allowance comes from the CLI’s supported `account/rateLimits/read` API.
  This does not create a conversation or run an agent prompt. Workbench selects
  the ordinary `codex` pool; a model-specific pool such as Spark cannot fill in
  a missing five-hour allowance. Local turn history is an explicitly labeled
  fallback when a live account check fails.
- Local token totals refresh every 15 seconds. Account requests run every 90
  seconds, or when you click Refresh, subject to provider retry delays. Refresh
  applies its returned reading immediately instead of waiting for a state broadcast.
  If a token scan is already running, a manual refresh queues an account check
  after it instead of returning the cached quota from that scan.
- Inactive Claude limit entries are omitted; an inactive zero-use entry must not
  appear as a fresh 100% allowance.
- Windows reads both providers' history from the WSL home where the agents run.
  macOS reads the local home and Claude's existing Keychain credential.
- No credentials or conversation text are sent to the renderer. Only quota and
  numeric token summaries are passed to the UI.

The providers expose remaining subscription allowance as percentages rather than
a fixed token balance. See [OpenAI's account API documentation](https://developers.openai.com/codex/app-server/#6-rate-limits-chatgpt)
and [Claude Code's usage fields](https://code.claude.com/docs/en/statusline).

## Updating the other computer from source

On the Mac, from its Workbench checkout:

```sh
git fetch origin
git switch main
git pull --ff-only origin main
npm ci
npm run dist
```

Install the resulting DMG. A Git push updates source; it does not publish an
in-app update. See [the update guide](updater-design.md) for the release process.
