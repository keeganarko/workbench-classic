# Sharing a session

A share hands one session to up to five other people over a link. They open it
in a browser — no install, no account, no copy of Workbench — see the terminal
as you see it, and appear by name in your title bar.

This document is the reasoning, the limits, and the threat model. The feature
itself is one button.

## Using it

The share icon sits in the title bar, to the left of the command palette. It
acts on the session in the focused pane.

1. Click it, then **Create link**.
2. Copy the link and send it however you like.
3. The person opens it, is asked for a name, and lands in the session.
4. Their name appears in your title bar next to a green dot.

To let someone type, open the same dialog and click **Let them type** on their
row. To take it back, click **Revoke**. **Stop sharing** ends it for everyone at
once; their screens say so immediately rather than quietly freezing.

## What a guest sees

A rendered picture of the terminal, refreshed about twice a second, plus the
names of everyone else watching. They do not get a shell, a file tree, the
preview pane, your other sessions, or anything else in the app. The page they
are served is a single self-contained document with a `default-src 'none'`
content-security policy — it cannot load anything, and it cannot be framed.

## Why a picture and not the stream

The obvious design fans the pty's output to every guest and lets them run a
terminal emulator. That is the wrong shape for what Workbench actually runs.

A coding agent's TUI redraws constantly and moves the cursor to do it, so the
byte stream is meaningless without a full emulator on the other end. Shipping
one to a stranger's browser means a bundled terminal library, which this repo
does not take (see `AGENTS.md`), and a page far heavier than the thing it is
showing.

tmux has already rendered that screen for us. `capture-pane` returns exactly
what a human sitting at the pane would see, so a share ships periodic snapshots
of it over Server-Sent Events. Cheap, correct for full-screen TUIs, and the
guest needs nothing but a browser.

The cost is that a guest sees the screen, not the scrollback below it, and sees
it at snapshot cadence rather than keystroke-by-keystroke. For "watch what this
agent is doing" — the thing the feature is for — that is the right trade.

## Why the link reaches the internet, and how

The share server binds `127.0.0.1` and nothing else. On its own, the link opens
only on the machine running Workbench — not even the rest of your network.

Reach comes from `cloudflared`, spawned in quick-tunnel mode, which publishes an
`https://<random>.trycloudflare.com` hostname that proxies to that loopback port
and disappears when the process exits. No account, no configuration, no inbound
firewall rule, and nothing for this app to host.

### The link is withheld until it answers

cloudflared prints its hostname when the tunnel **registers**, which is before
an edge connection exists behind it. A link copied in that window serves the
guest Cloudflare's **error 1033** — "no tunnel is connected for this hostname" —
which looks to both people like the feature is broken.

So the URL is not handed over when it is printed. It is handed over when it has
answered a real HTTPS request: the tunnel stays `starting`, the field says it is
still publishing, and Copy stays disabled until then. Any status proves the
path works, including the share server's own 404 for `/`. A 530 does not — that
is the 1033 page, and it is read as "not yet".

Two consequences worth knowing:

- **Every link dies when the tunnel does.** The hostname is random per run and
  keeps resolving after the process exits, so an old link 1033s forever rather
  than failing to resolve. When the tunnel drops, reach falls back to `local`
  immediately so the app stops describing dead links as working.
- **The check does not use this machine's DNS.** It resolves through 1.1.1.1 and
  8.8.8.8 and pins the address onto the request, with TLS still validating the
  real hostname through SNI. This is not paranoia: a consumer router acting as a
  DNS proxy will resolve `trycloudflare.com` and NXDOMAIN every subdomain under
  it, so the host cannot open their own link while it works perfectly for
  everyone else. Checking through the system resolver would turn that into a
  false alarm and stop a working share.

If `cloudflared` is not installed the share still works — it just has no public
address, and the dialog says so with the one command that fixes it. It is not
an error, because a host sharing with someone at the same desk does not need it.

Binding the LAN instead would have been simpler and is the reason it was not
done: it would silently expose every share to whatever wifi you happened to be
on, with no moment where you chose that.

## Typing is off by default, and that is the whole security story

A share link is a remote-input surface into a terminal running coding agents on
your machine. Someone who could type into it would have arbitrary code execution
as you. Everything below follows from that one sentence.

- **Every guest joins as a watcher.** `canType` starts false. There is no
  setting that changes the default and no way to create a share that starts open.
- **Only the host can promote.** Promotion travels over an Electron IPC channel
  that no guest-facing route reaches. A guest cannot promote themselves however
  they craft the request.
- **Revocation is immediate.** It is checked per keystroke, not per session, so
  clicking Revoke stops the next character — not the next reload.
- **The token is the credential.** 24 random bytes, compared in constant time. A
  wrong token and an ended share return byte-identical 404s, so a probe cannot
  tell "never existed" from "stopped".
- **Guest ids never leak.** The presence payload carries names and typing state,
  never another guest's id — that id is the only handle that would let one guest
  act as another.
- **Input is bounded.** Keystrokes are capped at 4 KB and request bodies at
  64 KB; anything larger is refused before it is parsed.
- **Names are treated as hostile.** They arrive from strangers and are rendered
  next to your own, so control characters and angle brackets are stripped and
  the length is capped before the name is stored.

The remaining risk is the one the feature cannot remove: **anyone holding the
link can watch, and whoever you promote can run commands as you.** Send links to
people, not channels, and stop the share when you are done.

## Limits

- Five guests per session. A sixth is turned away with a plain message.
- A guest whose browser vanishes without saying so is dropped after 30 seconds.
- One tunnel per app, not per share: the first share brings it up, the last one
  to stop takes it down.
- Shares do not survive a restart of Workbench. Links are deliberately
  short-lived; there is nothing to revoke later because there is nothing stored.
- The tunnel hostname is random per run, so restarting invalidates old links.

## Where the code is

| Path | Responsibility |
| --- | --- |
| `src/shared/share.ts` | Types, limits, and the pure helpers both sides use. |
| `src/main/share.ts` | The HTTP/SSE server the guest's browser talks to. |
| `src/main/shareClient.ts` | The guest page, as one self-contained document. |
| `src/main/tunnel.ts` | `cloudflared` lifecycle and public reach. |
| `src/renderer/src/components/SharePresence.tsx` | Who is watching, in the title bar. |
| `src/renderer/src/components/ShareDialog.tsx` | The host's controls. |

`test/share.test.mjs` drives the real server over real HTTP with a stub host, so
every route above is exercised without electron, tmux, or a session.
