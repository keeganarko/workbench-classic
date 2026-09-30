/**
 * The preview dock's client half.
 *
 * One funnel — `preview.open(path)` — behind every way of getting a document on
 * screen: the recents list, a drop, the Open dialog, a link inside a rendered
 * document, and the watcher noticing the file changed underneath you.
 *
 * What happens after that depends on the kind, and the split is the same one
 * main enforces. An HTML artifact and a PDF are loaded as themselves, on their
 * own origin, with script allowed — that is what makes an artifact worth
 * previewing. Everything else is turned into HTML here and handed to main to be
 * wrapped in a document that cannot run anything at all.
 */

import { useStore } from '../state/store'
import { formatAttachmentText } from '../../../shared/attach'
import { renderMarkdown } from '../../../shared/markdown'
import { renderDiff } from '../../../shared/diff'
import { previewRoute } from '../../../shared/previewRoute'
import { isLoopbackUrl } from '../../../shared/localhost'
import {
  delimitedTableHtml,
  escapeHtml,
  extensionOf,
  parseDelimited
} from '../../../shared/preview'
import { activeSessionId } from './actions'
import type { DiffQuery, PreviewDoc, PreviewEntry } from '../../../shared/types'

const api = window.term

interface PreviewRequest {
  owner: string | null
  focused: string | null
  display: boolean
  revision: number
  path: string
  auto: boolean
}

// Reserve the choice before reading or rendering starts. Otherwise a slow
// Markdown build can finish after an explicit HTML show and put the old file
// back on screen. Pending choices also protect a named document while its
// first read is still in flight, before it has a completed session slot.
const pending = new Map<string | null, PreviewRequest>()
let revision = 0
let latestDisplay: PreviewRequest | null = null
function beginRequest(owner: string | null, path: string, auto: boolean, display = true): PreviewRequest {
  const request = { owner, path, auto, focused: activeSessionId(), display, revision: ++revision }
  pending.set(owner, request)
  if (display) latestDisplay = request
  return request
}
function current(request: PreviewRequest): boolean {
  return pending.get(request.owner) === request
}
function finishRequest(request: PreviewRequest): void {
  if (current(request)) pending.delete(request.owner)
}

function mayDisplay(request: PreviewRequest): boolean {
  const active = activeSessionId()
  // A human can open another project's output from Focus without moving the
  // terminal underneath it. Agent background deliveries still wait for their
  // own chat, and neither route may undo a newer explicit screen choice.
  const target = active === request.owner || (request.display && active === request.focused)
  const superseded = latestDisplay && latestDisplay.revision > request.revision
    && (latestDisplay.focused === active || latestDisplay.owner === active)
  return target && !superseded
}

function deliver(request: PreviewRequest, doc: PreviewDoc, url: string, diff: DiffQuery | null, quiet = false): void {
  if (!current(request)) return
  const st = useStore.getState()
  const focused = mayDisplay(request)
  if (quiet && (st.preview.owner !== request.owner || st.preview.doc?.path !== doc.path)) return
  if (focused) {
    if (!quiet) preview.show()
    st.setPreview({ doc, url, diff, auto: request.auto, owner: request.owner, loading: false, error: null })
  }
  if (request.owner) {
    st.setSessionPreview(request.owner, { doc, url, diff, auto: request.auto, seen: focused })
  }
}

/** Kinds the frame loads directly rather than having a document built for them. */
function isDirect(doc: PreviewDoc): boolean {
  return (
    doc.kind === 'html' ||
    doc.kind === 'pdf' ||
    doc.kind === 'image' ||
    doc.kind === 'svg' ||
    doc.kind === 'url'
  )
}

/** Where "recently changed files" is scanned from when nothing is open yet. */
export function previewHomeDir(): string | null {
  const st = useStore.getState()
  const session = st.sessions.find((s) => s.id === activeSessionId())
  return session?.cwd ?? st.prefs.defaultCwd ?? null
}

export const preview = {
  /** Shows the pane, without touching what is in it. */
  show(): void {
    const st = useStore.getState()
    if (!st.prefs.previewVisible) void api.setPrefs({ previewVisible: true })
  },

  toggle(): void {
    const st = useStore.getState()
    void api.setPrefs({ previewVisible: !st.prefs.previewVisible })
  },

  /**
   * Opens a path. Every route in ends here.
   *
   * `quiet` is for the watcher: a file that changed should re-render without
   * flashing a spinner or stealing the pane if you have moved on to something
   * else in the meantime. `auto` marks a document the pane chose rather than
   * you, which is what lets the next one replace it without argument.
   */
  async open(
    filePath: string,
    opts: { quiet?: boolean; auto?: boolean; owner?: string | null; background?: boolean } = {}
  ): Promise<void> {
    const st = useStore.getState()
    const owner = opts.quiet ? st.preview.owner : opts.owner !== undefined ? opts.owner : activeSessionId()
    if (opts.quiet && pending.size) return
    const request = beginRequest(owner, filePath, opts.quiet ? st.preview.auto : opts.auto === true, !opts.background)
    if (!opts.quiet && !opts.background) {
      preview.show()
      st.setPreview({ loading: true, error: null })
    }
    try {
      const doc = await api.previewOpen(filePath)
      if (!current(request)) return
      if (opts.quiet && useStore.getState().preview.doc?.path !== doc.path) return
      const url = isDirect(doc) ? cacheBust(doc.url, doc.mtimeMs) : await buildDocument(doc)
      deliver(request, doc, url, null, opts.quiet)
    } catch (err) {
      const message = (err as Error).message
      if (opts.quiet || opts.background || !current(request) || !mayDisplay(request)) return
      useStore.getState().setPreview({ loading: false, error: message, doc: null, url: null })
    } finally {
      finishRequest(request)
    }
  },

  /**
   * A turn finished and left a document behind.
   *
   * Which chat produced it decides what happens. The focused one opens the
   * pane, as it always did — but never over something you opened by hand in
   * that chat. A background one renders into its own slot and stops there: it
   * gets a dot in the sidebar, and the document is already built by the time
   * you switch to it. A background agent finishing has never been a good
   * reason to take the page you are reading off the screen.
   */
  async surface(sessionId: string, entry: PreviewEntry): Promise<void> {
    await route(sessionId, entry.path, false)
  },

  /**
   * A session named a file outright — `workbench show <path>`.
   *
   * Asked for by name, so within its own chat it does not defer to what you
   * had open. It still does not reach across chats: a background session gets
   * its slot and a dot, the same as anything else it produces.
   */
  async showFor(sessionId: string, filePath: string): Promise<void> {
    await route(sessionId, filePath, true)
  },

  /**
   * Renders a document into a chat's slot without touching the pane.
   *
   * The build happens now rather than on the switch, so clicking into a chat
   * that has been working shows the document immediately instead of a spinner.
   */
  async stash(sessionId: string, filePath: string, auto: boolean): Promise<void> {
    await preview.open(filePath, { owner: sessionId, auto, background: true })
  },

  /**
   * Pane focus moved. The dock follows it.
   *
   * A chat that has shown you something gets it back, already rendered and
   * marked read. A chat that has shown you nothing empties the pane — which is
   * the honest answer, and puts the recents list for *that* chat's folder in
   * front of you instead of the last chat's report.
   */
  followFocus(sessionId: string | null): void {
    const st = useStore.getState()
    if (st.preview.owner === sessionId) return
    const slot = sessionId ? st.preview.bySession[sessionId] : undefined
    if (!slot) {
      // Only a document that belongs to a *different* chat is cleared. One you
      // opened with no pane focused belongs to nobody, so it stays put rather
      // than disappearing the moment you click into a terminal.
      if (st.preview.owner !== null || st.preview.loading) {
        st.setPreview({ doc: null, url: null, loading: false, error: null, auto: false, diff: null, owner: null })
      }
      return
    }
    st.setPreview({
      doc: slot.doc,
      url: slot.url,
      diff: slot.diff,
      auto: slot.auto,
      owner: sessionId,
      loading: false,
      error: null
    })
    if (!slot.seen && sessionId) st.setSessionPreview(sessionId, { ...slot, seen: true })
  },

  /**
   * Puts a local dev server in the pane.
   *
   * Synchronous on purpose: it takes the pane in the same tick as the caller,
   * so a click that also moves session focus cannot race the focus effect into
   * clearing the pane it just filled.
   *
   * The address came out of a session's own output, which is untrusted text,
   * so it is checked here before the frame is pointed at it — and checked
   * again by main's frame-navigation guard, which is what actually enforces
   * it. Anything not on this machine goes to the browser instead.
   */
  openUrl(rawUrl: string, opts: { owner?: string | null } = {}): void {
    const st = useStore.getState()
    if (!isLoopbackUrl(rawUrl)) {
      st.setToast('The preview only loads addresses on this machine.', 'error', {
        label: 'Open in browser',
        run: () => void api.openExternal(rawUrl)
      })
      return
    }
    preview.show()
    let host = rawUrl
    try {
      host = new URL(rawUrl).host
    } catch {
      // Unreachable: `isLoopbackUrl` already parsed it.
    }
    const doc: PreviewDoc = {
      path: rawUrl,
      name: host,
      kind: 'url',
      mime: 'text/html',
      size: 0,
      mtimeMs: Date.now(),
      url: rawUrl,
      dirUrl: rawUrl,
      text: null,
      truncated: false,
      // There is no file, so nothing watches it, nothing opens it in another
      // app, and nothing types its path into a session. The page reloads
      // itself; that is what a dev server is for.
      virtual: true
    }
    const owner = opts.owner !== undefined ? opts.owner : activeSessionId()
    finishRequest(beginRequest(owner, rawUrl, false))
    st.setPreview({ doc, url: rawUrl, loading: false, error: null, auto: false, diff: null, owner })
    if (owner) {
      useStore
        .getState()
        .setSessionPreview(owner, { doc, url: rawUrl, diff: null, auto: false, seen: true })
    }
  },

  /**
   * Shows a git diff in the pane.
   *
   * A diff is a `PreviewKind` like any other, so it renders through the same
   * inert-document path as Markdown — but it has no file behind it, which is
   * what `virtual` marks. The query is kept alongside so "refresh" can mean
   * "ask git again"; there is nothing on disk to re-read.
   */
  async openDiff(query: DiffQuery, title: string): Promise<void> {
    const st = useStore.getState()
    const owner = activeSessionId()
    const request = beginRequest(owner, query.file ?? title, false)
    preview.show()
    st.setPreview({ loading: true, error: null })
    try {
      const result = await api.gitDiff(query)
      if (!current(request)) return
      const doc: PreviewDoc = {
        path: query.file ? `${result.root}/${query.file}` : result.root,
        name: title,
        kind: 'diff',
        mime: 'text/x-diff',
        size: result.patch.length,
        mtimeMs: Date.now(),
        url: '',
        dirUrl: previewDirUrlFor(result.root),
        text: result.patch,
        truncated: result.truncated,
        virtual: true
      }
      const url = await api.previewDocument({
        title,
        body: renderDiff(result.patch, {
          title: `${result.label}${query.file ? ` · ${query.file}` : ''}`,
          note: result.truncated
            ? 'This diff was too large to show in full — it is cut short at a line boundary.'
            : undefined
        }),
        baseHref: doc.dirUrl,
        bodyClass: 'diff'
      })
      deliver(request, doc, url, query)
    } catch (err) {
      if (!current(request) || !mayDisplay(request)) return
      useStore
        .getState()
        .setPreview({ loading: false, error: (err as Error).message, doc: null, url: null, diff: null })
    } finally {
      finishRequest(request)
    }
  },

  /**
   * Re-reads whatever is open. The refresh button and the ⌘R equivalent.
   *
   * A diff has no file to re-read, so it goes back to git with the query that
   * produced it — which is also what makes the button mean the right thing
   * after you stage something.
   */
  async refresh(): Promise<void> {
    const pv = useStore.getState().preview
    if (pv.doc?.kind === 'url') {
      // Same address, so re-rendering changes nothing: the frame has to be
      // remounted, which is what the nonce is for.
      useStore.getState().setPreview({ frameNonce: pv.frameNonce + 1 })
      return
    }
    if (pv.doc?.virtual && pv.diff) {
      await preview.openDiff(pv.diff, pv.doc.name)
      return
    }
    if (pv.doc) await preview.open(pv.doc.path)
  },

  async openDialog(): Promise<void> {
    const st = useStore.getState()
    const start = st.preview.doc?.path ?? previewHomeDir() ?? undefined
    const picked = await api.pickFile(start)
    if (picked) await preview.open(picked)
  },

  close(): void {
    const st = useStore.getState()
    pending.delete(st.preview.owner)
    st.setPreview({ doc: null, url: null, loading: false, error: null, auto: false, diff: null, owner: null })
    // Closing has to clear this chat's slot as well, or switching away and
    // back would resurrect the thing you just dismissed.
    const owner = activeSessionId()
    finishRequest(beginRequest(owner, '', false))
    if (owner) st.setSessionPreview(owner, null)
    void api.previewWatch(null)
  },

  /** Rebuilds the "what changed here recently" list for a folder. */
  async loadRecents(dir: string): Promise<void> {
    const st = useStore.getState()
    if (st.preview.recentsDir === dir && st.preview.recents.length) return
    try {
      const recents = await api.previewRecent(dir, 40)
      useStore.getState().setPreview({ recents, recentsDir: dir })
    } catch {
      useStore.getState().setPreview({ recents: [], recentsDir: dir })
    }
  },

  /** Types the open document's path into the focused session, quoted. */
  async attachToSession(): Promise<void> {
    const st = useStore.getState()
    const doc = st.preview.doc
    const id = activeSessionId()
    if (!doc) return
    if (!id) {
      st.setToast('Focus a session first, then attach the file to it.', 'error')
      return
    }
    api.ptyWrite(id, formatAttachmentText([doc.path]))
    st.setToast(`Path typed into the focused session.`, 'success')
  },

  /**
   * A link clicked inside a generated document.
   *
   * Local documents reopen in the pane so they arrive rendered; web links go to
   * the OS browser. Anything else — a `javascript:` href in a file someone was
   * handed, say — is simply dropped.
   */
  async followLink(href: string): Promise<void> {
    const st = useStore.getState()
    if (/^https?:/i.test(href) || href.startsWith('mailto:')) {
      try {
        await api.openExternal(href)
      } catch (err) {
        st.setToast((err as Error).message, 'error')
      }
      return
    }
    const local = pathFromUrl(href)
    if (local) await preview.open(local)
  }
}

/** Asks `previewRoute` what to do, then does it. */
async function route(sessionId: string, path: string, asked: boolean): Promise<void> {
  const st = useStore.getState()
  const held = st.preview.bySession[sessionId]
  const choice = pending.get(sessionId) ?? (held ? { path: held.doc.path, auto: held.auto } : null)
  const what = previewRoute({
    autoShow: st.prefs.previewAutoShow,
    focused: activeSessionId() === sessionId,
    held: choice,
    path,
    asked
  })
  if (what === 'ignore') return
  // A named file is a choice, not a guess. Refreshing that same path must
  // retain its protection; otherwise the next scan can replace it again.
  const auto = asked ? false : choice?.path === path ? choice.auto : true
  if (what === 'open') await preview.open(path, { auto, owner: sessionId })
  else await preview.stash(sessionId, path, auto)
}

/** The `<base href>` a virtual document resolves relative links against. */
function previewDirUrlFor(absDir: string): string {
  const posix = absDir.replace(/\\/g, '/')
  const rooted = posix.startsWith('/') ? posix : `/${posix}`
  const encoded = rooted.split('/').map(encodeURIComponent).join('/')
  return `wb-preview://f${encoded}/`
}

/** `wb-preview://f/Users/me/a%20b.md` → `/Users/me/a b.md`, or null. */
function pathFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'wb-preview:' || url.hostname !== 'f') return null
    const decoded = decodeURIComponent(url.pathname)
    return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded
  } catch {
    return null
  }
}

/**
 * A changed file needs a URL the frame has not already cached.
 *
 * The response says `no-store`, but an artifact that reloads itself and a frame
 * that never navigated are two different things — changing the URL is what
 * makes the reload actually happen.
 */
function cacheBust(url: string, mtimeMs: number): string {
  return `${url}?t=${Math.round(mtimeMs)}`
}

/** Turns a text document into HTML and returns the URL main serves it from. */
async function buildDocument(doc: PreviewDoc): Promise<string> {
  const text = doc.text ?? ''
  const note = doc.truncated
    ? `<p class="doc-note">Showing the first 2 MB of ${escapeHtml(doc.name)} — the file is larger than the preview reads.</p>`
    : ''

  let body: string
  let bodyClass = 'doc'

  if (doc.kind === 'diff') {
    // A `.patch` file opened from disk renders exactly like a generated one.
    return api.previewDocument({
      title: doc.name,
      body: renderDiff(text, {
        title: doc.name,
        note: doc.truncated
          ? `Showing the first 2 MB of ${doc.name} — the file is larger than the preview reads.`
          : undefined
      }),
      baseHref: doc.dirUrl,
      bodyClass: 'diff',
      initialScroll: useStore.getState().preview.scroll[doc.path] ?? 0
    })
  }

  if (doc.kind === 'markdown') {
    body = note + renderMarkdown(text, { resolveUrl: (href) => resolveAgainst(href, doc.dirUrl) })
  } else if (doc.kind === 'csv') {
    const delimiter = extensionOf(doc.path) === 'tsv' ? '\t' : ','
    body = delimitedTableHtml(parseDelimited(text, delimiter), doc.truncated)
    bodyClass = 'data'
  } else if (doc.kind === 'json') {
    body = note + `<pre><code>${escapeHtml(prettyJson(text))}</code></pre>`
    bodyClass = 'plain'
  } else {
    body = note + `<pre><code>${escapeHtml(text)}</code></pre>`
    bodyClass = 'plain'
  }

  return api.previewDocument({
    title: doc.name,
    body,
    baseHref: doc.dirUrl,
    bodyClass,
    initialScroll: useStore.getState().preview.scroll[doc.path] ?? 0
  })
}

/** Pretty-prints JSON, and leaves anything that is not JSON exactly as it was. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/**
 * Resolves a link from a document against the folder it lives in.
 *
 * Anchors stay anchors, and anything already absolute is left alone by `URL`
 * itself — which is also what keeps a `mailto:` from being mangled into a path.
 */
function resolveAgainst(href: string, dirUrl: string): string {
  if (href === '' || href.startsWith('#')) return href
  try {
    return new URL(href, dirUrl).toString()
  } catch {
    return href
  }
}
