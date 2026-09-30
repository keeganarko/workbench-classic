/**
 * The preview dock's shared vocabulary: what a file is, how it is addressed,
 * and what an inert preview document looks like.
 *
 * Both processes need these answers and they must agree. Main decides whether
 * a request is allowed to be served and with which content type; the renderer
 * decides which viewer to mount and builds the document body. A disagreement
 * about, say, whether `.svg` is an image would show up as a blank pane.
 *
 * Keep this file free of runtime imports — the renderer imports it directly.
 */

/**
 * How a file is shown.
 *
 * The split that matters is `html` versus everything else. An `html` artifact
 * is the one kind that runs its own script, so it is loaded as a real document
 * on its own origin; every other kind is turned into a document we generated
 * ourselves and served with scripting switched off. "Documents are inert,
 * artifacts are live" is the whole security model of this pane.
 */
export type PreviewKind =
  | 'markdown'
  | 'html'
  | 'image'
  | 'svg'
  | 'pdf'
  | 'csv'
  | 'json'
  | 'diff'
  | 'text'
  /**
   * A local dev server, loaded live in the frame.
   *
   * The odd one out: there is no file, and `classifyPreview` never returns it,
   * because it does not come from a path at all. It behaves like `html` —
   * a real page on its own origin, running its own script — and it is confined
   * to loopback addresses by `isLoopbackUrl`, checked both here and again in
   * main's frame-navigation guard.
   */
  | 'url'

/** The custom scheme the preview iframe loads from. Registered in main. */
export const PREVIEW_SCHEME = 'wb-preview'

/** Host segment for a file on disk: `wb-preview://f/<abs path>`. */
export const PREVIEW_FILE_HOST = 'f'

/** Host segment for a document the renderer generated: `wb-preview://doc/<id>`. */
export const PREVIEW_DOC_HOST = 'doc'

const KIND_BY_EXTENSION: Record<string, PreviewKind> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  svg: 'svg',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  pdf: 'pdf',
  csv: 'csv',
  tsv: 'csv',
  json: 'json',
  jsonl: 'text',
  txt: 'text',
  log: 'text',
  diff: 'diff',
  patch: 'diff',
  yml: 'text',
  yaml: 'text',
  toml: 'text',
  ini: 'text',
  env: 'text',
  sql: 'text',
  sh: 'text',
  bash: 'text',
  zsh: 'text',
  fish: 'text',
  ps1: 'text',
  py: 'text',
  rb: 'text',
  go: 'text',
  rs: 'text',
  java: 'text',
  kt: 'text',
  swift: 'text',
  c: 'text',
  h: 'text',
  cc: 'text',
  cpp: 'text',
  hpp: 'text',
  cs: 'text',
  php: 'text',
  js: 'text',
  jsx: 'text',
  mjs: 'text',
  cjs: 'text',
  ts: 'text',
  tsx: 'text',
  css: 'text',
  scss: 'text',
  less: 'text',
  xml: 'text',
  plist: 'text',
  gradle: 'text',
  make: 'text',
  mk: 'text',
  dockerfile: 'text'
}

/** Every extension the pane can render — the Open dialog's filter list. */
export const PREVIEW_EXTENSIONS: readonly string[] = Object.keys(KIND_BY_EXTENSION)

/** Files with no extension that are still worth previewing. */
const KIND_BY_NAME: Record<string, PreviewKind> = {
  dockerfile: 'text',
  makefile: 'text',
  license: 'text',
  readme: 'markdown',
  changelog: 'markdown',
  '.gitignore': 'text',
  '.env': 'text'
}

const MIME_BY_EXTENSION: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm'
}

/** `/a/b/report.final.md` → `md`. Lowercased, no leading dot. */
export function extensionOf(filePath: string): string {
  const base = basename(filePath)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** Last path segment, for either separator — main and renderer both call this. */
export function basename(filePath: string): string {
  const cleaned = filePath.replace(/[/\\]+$/, '')
  const cut = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return cut < 0 ? cleaned : cleaned.slice(cut + 1)
}

/** Everything before the last separator, with no trailing slash. */
export function dirnameOf(filePath: string): string {
  const cleaned = filePath.replace(/[/\\]+$/, '')
  const cut = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  if (cut < 0) return '.'
  return cut === 0 ? '/' : cleaned.slice(0, cut)
}

/** The viewer a path gets, or null when nothing here can show it. */
export function classifyPreview(filePath: string): PreviewKind | null {
  const ext = extensionOf(filePath)
  if (ext && KIND_BY_EXTENSION[ext]) return KIND_BY_EXTENSION[ext]
  const name = basename(filePath).toLowerCase()
  return KIND_BY_NAME[name] ?? null
}

export function isPreviewable(filePath: string): boolean {
  return classifyPreview(filePath) !== null
}

/**
 * Content type for a served file.
 *
 * Falls back to `application/octet-stream` rather than guessing: a wrong text
 * type on a binary is how a page ends up rendering a JPEG as mojibake.
 */
export function mimeForPath(filePath: string): string {
  const ext = extensionOf(filePath)
  if (MIME_BY_EXTENSION[ext]) return MIME_BY_EXTENSION[ext]
  const kind = classifyPreview(filePath)
  return kind === 'text' || kind === 'diff'
    ? 'text/plain; charset=utf-8'
    : 'application/octet-stream'
}

// ── addressing ──────────────────────────────────────────────────────────────

/**
 * `/Users/me/a b.png` → `wb-preview://f/Users/me/a%20b.png`.
 *
 * The absolute path is kept as the URL path so relative references inside a
 * document resolve the way they do on disk: an artifact at `.../out/index.html`
 * asking for `./app.css` lands on `.../out/app.css` with no rewriting.
 */
export function previewUrlFor(absPath: string): string {
  const posix = absPath.replace(/\\/g, '/')
  const rooted = posix.startsWith('/') ? posix : `/${posix}`
  const encoded = rooted.split('/').map(encodeURIComponent).join('/')
  return `${PREVIEW_SCHEME}://${PREVIEW_FILE_HOST}${encoded}`
}

/** The same, with the trailing slash a `<base href>` needs. */
export function previewDirUrl(absDir: string): string {
  const url = previewUrlFor(absDir)
  return url.endsWith('/') ? url : `${url}/`
}

export function previewDocUrl(id: string): string {
  return `${PREVIEW_SCHEME}://${PREVIEW_DOC_HOST}/${encodeURIComponent(id)}`
}

/**
 * The path a `wb-preview://f/...` URL names, or null for anything else.
 *
 * Returns the decoded path only — the caller still has to prove it is inside a
 * root it is allowed to serve. Decoding is not authorisation.
 */
export function pathFromPreviewUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${PREVIEW_SCHEME}:`) return null
  if (url.hostname !== PREVIEW_FILE_HOST) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  // `/C:/Users/...` came from a Windows path and has to go back the way it came.
  return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded
}

/** The document id a `wb-preview://doc/<id>` URL names, or null. */
export function docIdFromPreviewUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${PREVIEW_SCHEME}:`) return null
  if (url.hostname !== PREVIEW_DOC_HOST) return null
  const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null
}

// ── html ────────────────────────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface PreviewDocumentInput {
  title: string
  /** Body HTML. Already rendered; this function does not sanitise it. */
  body: string
  /** Directory the document's relative links resolve against. */
  baseHref: string
  /** Random per-document value; the only script allowed to run. */
  nonce: string
  /** Class on `<body>`, so a viewer can style itself (`doc`, `plain`, `data`). */
  bodyClass?: string
  /** Restored after a live-reload so a watched file does not jump to the top. */
  initialScroll?: number
}

/**
 * Wraps rendered content in a complete, self-contained document.
 *
 * The `<meta>` CSP is belt to main's braces: the response carries the same
 * policy as a header, and a policy in both places survives either one being
 * changed by mistake. `script-src` names one nonce, which only the small
 * bridge below carries — a `<script>` that arrived from the file being
 * previewed has no nonce and does not run.
 */
export function previewDocument(input: PreviewDocumentInput): string {
  const { title, body, baseHref, nonce } = input
  const csp = previewDocumentCsp(nonce)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}" />
<base href="${escapeHtml(baseHref)}" />
<title>${escapeHtml(title)}</title>
<style>${DOCUMENT_CSS}</style>
</head>
<body class="${escapeHtml(input.bodyClass ?? 'doc')}">
${body}
<script nonce="${escapeHtml(nonce)}">${bridgeScript(input.initialScroll ?? 0)}</script>
</body>
</html>`
}

/**
 * What a generated preview document is allowed to do: show local images and
 * fonts, and run exactly one script. No network, no frames, no forms.
 */
export function previewDocumentCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${PREVIEW_SCHEME}: data: blob:`,
    `media-src ${PREVIEW_SCHEME}: data:`,
    `font-src ${PREVIEW_SCHEME}: data:`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "form-action 'none'",
    "frame-src 'none'",
    // The document carries a `<base>` so relative images resolve against the
    // file's own directory; `'none'` here would quietly disable it.
    `base-uri ${PREVIEW_SCHEME}:`
  ].join('; ')
}

/**
 * The document's half of the conversation with the dock.
 *
 * Two jobs, both of which need to run inside the frame: remember the scroll
 * position so a file that is rewritten while you read it comes back where you
 * were, and hand link clicks to the dock instead of navigating — a link to
 * another Markdown file should open *rendered*, not as raw source.
 */
function bridgeScript(initialScroll: number): string {
  return `
(function () {
  var send = function (msg) { try { parent.postMessage(msg, '*') } catch (e) {} };
  if (${Number(initialScroll) || 0} > 0) window.scrollTo(0, ${Number(initialScroll) || 0});
  var pending = null;
  window.addEventListener('scroll', function () {
    if (pending) return;
    pending = setTimeout(function () { pending = null; send({ wb: 'scroll', y: window.scrollY }) }, 120);
  }, { passive: true });
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#') return;
    e.preventDefault();
    send({ wb: 'open', href: a.href });
  });
  send({ wb: 'ready' });
})();
`.trim()
}

/** The reading style. Deliberately close to the app's own dark chrome. */
const DOCUMENT_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: #1f1f1f;
  color: #cccccc;
  font: 14px/1.65 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  padding: 26px 30px 60px;
  max-width: 900px;
  margin: 0 auto;
  overflow-wrap: break-word;
}
body.plain, body.data { max-width: none; padding: 0; }
h1, h2, h3, h4, h5, h6 { color: #e7e7e7; line-height: 1.3; margin: 1.6em 0 0.6em; font-weight: 600; }
h1 { font-size: 1.9em; margin-top: 0.2em; border-bottom: 1px solid #2b2b2b; padding-bottom: 0.3em; }
h2 { font-size: 1.45em; border-bottom: 1px solid #2b2b2b; padding-bottom: 0.25em; }
h3 { font-size: 1.2em; }
h4, h5, h6 { font-size: 1em; color: #cccccc; }
p { margin: 0 0 1em; }
a { color: #4daafc; text-decoration: none; }
a:hover { text-decoration: underline; }
hr { border: none; border-top: 1px solid #2b2b2b; margin: 2em 0; }
ul, ol { padding-left: 1.5em; margin: 0 0 1em; }
li { margin: 0.25em 0; }
li.task { list-style: none; margin-left: -1.2em; }
li.task input { margin-right: 0.5em; accent-color: #0078d4; }
blockquote {
  margin: 0 0 1em;
  padding: 0.2em 0 0.2em 1em;
  border-left: 3px solid #3c3c3c;
  color: #9d9d9d;
}
code {
  font: 0.9em/1.5 'SF Mono', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace;
  background: #2a2a2a;
  border-radius: 4px;
  padding: 0.15em 0.4em;
}
.code-block { position: relative; margin: 0 0 1.2em; }
.code-lang {
  position: absolute; top: 0; right: 0;
  font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase;
  color: #6e7681; padding: 6px 10px; pointer-events: none;
}
pre {
  margin: 0;
  background: #181818;
  border: 1px solid #2b2b2b;
  border-radius: 6px;
  padding: 12px 14px;
  overflow-x: auto;
}
pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.5; }
.table-wrap { overflow-x: auto; margin: 0 0 1.2em; }
table { border-collapse: collapse; width: 100%; font-size: 0.95em; }
th, td { border: 1px solid #2b2b2b; padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: #202020; color: #e7e7e7; font-weight: 600; position: sticky; top: 0; }
tbody tr:nth-child(even) { background: #1c1c1c; }
img { max-width: 100%; height: auto; border-radius: 4px; }
figure { margin: 0 0 1.2em; }
kbd {
  font: 0.85em 'SF Mono', Menlo, monospace;
  border: 1px solid #3c3c3c; border-bottom-width: 2px;
  border-radius: 4px; padding: 0.1em 0.4em; background: #2a2a2a;
}
body.plain pre {
  border: none; border-radius: 0; background: #1f1f1f;
  padding: 14px 18px 40px; min-height: 100vh;
}
body.data { padding: 0; }
body.data table { font-size: 12.5px; }
body.data th { white-space: nowrap; }
body.data td { font-family: 'SF Mono', Menlo, monospace; font-size: 12px; white-space: pre; }
.row-num { color: #6e7681; text-align: right; user-select: none; }
.doc-note {
  margin: 0 0 1.2em; padding: 10px 12px;
  border: 1px solid #3c3c3c; border-left: 3px solid #e2b93d;
  border-radius: 4px; color: #9d9d9d; font-size: 12.5px;
}

/* ── diff ── */
body.diff { max-width: none; padding: 0 0 60px; }
.diff-head {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: center; gap: 10px;
  padding: 9px 14px; background: #202020; border-bottom: 1px solid #2b2b2b;
  color: #e7e7e7; font-size: 12px; font-weight: 600;
}
.diff-sum { margin-left: auto; display: flex; gap: 8px; font-weight: 500; color: #9d9d9d; }
.diff-add-count { color: #6bbf6b; }
.diff-del-count { color: #e06c75; }
body.diff .doc-note { margin: 12px 14px; }
.diff-file { margin: 14px 0 0; border-top: 1px solid #2b2b2b; }
.diff-file:first-of-type { border-top: none; }
.diff-file-head {
  position: sticky; top: 34px; z-index: 1;
  display: flex; align-items: baseline; gap: 8px;
  padding: 8px 14px; background: #1c1c1c; border-bottom: 1px solid #2b2b2b;
}
.diff-file-path {
  font: 12px/1.4 'SF Mono', 'JetBrains Mono', Menlo, Monaco, monospace;
  color: #e7e7e7; overflow-wrap: anywhere;
}
.diff-file-tag {
  font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 1px 5px; border-radius: 3px; background: #2a2a2a; color: #9d9d9d;
}
.diff-file-tag--new { background: #1e3a24; color: #7ec98a; }
.diff-file-tag--deleted { background: #3a1e21; color: #e58c95; }
.diff-file-tag--renamed { background: #23314a; color: #8ab4f8; }
.diff-file-from { font-size: 11px; color: #6e7681; }
.diff-file-stat { margin-left: auto; display: flex; gap: 8px; font-size: 11px; }
.diff-note { padding: 8px 14px; color: #9d9d9d; font-size: 12px; }
.diff-table {
  width: 100%; border-collapse: collapse;
  font: 12px/1.5 'SF Mono', 'JetBrains Mono', Menlo, Monaco, monospace;
}
.diff-table td { border: none; padding: 0; vertical-align: top; }
.diff-no {
  width: 1%; min-width: 42px; padding: 0 8px 0 0 !important;
  text-align: right; color: #5a6069; user-select: none; white-space: nowrap;
}
.diff-sign { width: 1%; padding: 0 6px !important; user-select: none; color: #6e7681; }
.diff-code { white-space: pre-wrap; overflow-wrap: anywhere; padding-right: 14px !important; }
.diff-row--add { background: #16301b; }
.diff-row--add .diff-sign { color: #6bbf6b; }
.diff-row--del { background: #35191c; }
.diff-row--del .diff-sign { color: #e06c75; }
.diff-row--hunk { background: #23283a; color: #8d9bbf; }
.diff-row--hunk .diff-code { padding: 3px 14px 3px 0 !important; }
.diff-row--meta .diff-code { color: #6e7681; font-style: italic; }
`.trim()

// ── delimited data ──────────────────────────────────────────────────────────

/**
 * RFC 4180-ish parse: quoted fields, doubled quotes inside them, embedded
 * newlines, and either separator. Enough to show a table an agent just wrote.
 */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  while (i < src.length) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
      i++
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }
    field += ch
    i++
  }

  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  // A trailing newline leaves one empty row behind; it is not a record.
  if (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop()
  return rows
}

/** Renders parsed rows as a table, first row as the header. */
export function delimitedTableHtml(rows: string[][], truncated: boolean): string {
  if (rows.length === 0) return '<p class="doc-note">This file is empty.</p>'
  const [header, ...body] = rows
  const th = header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')
  const trs = body
    .map((r, n) => {
      const tds = header.map((_, c) => `<td>${escapeHtml(r[c] ?? '')}</td>`).join('')
      return `<tr><td class="row-num">${n + 1}</td>${tds}</tr>`
    })
    .join('\n')
  const note = truncated
    ? '<p class="doc-note">Showing the first part of this file — it is too large to render in full.</p>'
    : ''
  return `${note}<div class="table-wrap"><table><thead><tr><th class="row-num"></th>${th}</tr></thead><tbody>${trs}</tbody></table></div>`
}
