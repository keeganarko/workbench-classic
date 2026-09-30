/**
 * The page a guest sees.
 *
 * Served as one self-contained document with no external requests, because the
 * CSP on it is `default-src 'none'` and because a guest may be opening this
 * through a tunnel on a phone. Everything — styles, script, state — is inline.
 *
 * It is written as a template string rather than a bundled renderer entry on
 * purpose: this page must not share code, or a build step, with the Electron
 * renderer. The renderer trusts the app; this page is handed to strangers.
 */

/** Escapes text for insertion into HTML. The frame is terminal output. */
const ESCAPE_JS = String.raw`
function esc(s) {
  return s.replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  })
}
`

export function guestPage(token: string, title: string): string {
  const safeTitle = title.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }
    return map[c]
  })
  // The token is already in the URL the guest opened; embedding it lets the
  // page build its own endpoints without parsing its own location.
  const safeToken = token.replace(/[^a-f0-9]/g, '')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle} — Workbench</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0d1117; color: #d7dde5;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    height: 100vh; display: flex; flex-direction: column;
  }
  /*
    Mobile Safari reports 100vh as the height *without* its chrome, so the
    footer — the input, the only control a guest has — sits below the fold and
    the page looks broken. dvh tracks the visible area instead. Kept as a second
    declaration so browsers without dvh keep the vh value above.
  */
  @supports (height: 100dvh) { body { height: 100dvh; } }
  header {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 8px 12px; background: #161b22; border-bottom: 1px solid #232b36;
  }
  .title { font-weight: 600; color: #f0f4f8; margin-right: auto; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 2px 9px; border-radius: 999px;
    background: #232b36; font-size: 12px;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #4c9a5a; }
  .chip.watching .dot { background: #6b7684; }
  .role { color: #8b95a3; font-size: 11px; }
  pre {
    flex: 1; margin: 0; padding: 12px; overflow: auto;
    white-space: pre; tab-size: 8; color: #d7dde5;
    -webkit-text-size-adjust: 100%;
  }
  /*
    A terminal is a fixed 80-odd columns wide and a phone is not. At the body
    font size those columns need roughly 560px, so on a narrow screen the guest
    gets a sliver of the screen and has to pan to read a line — which is the
    same as it not working.

    Monospace glyphs run about 0.6em wide, so the size that fits N columns in
    the viewport is width / (N * 0.6). Sized off the viewport it fits by
    construction, capped at the desktop size so a wide window is unaffected.
    Horizontal scroll is still there for output wider than 80 columns.
  */
  @media (max-width: 640px) {
    pre { padding: 8px; font-size: min(13px, calc((100vw - 16px) / 48)); }
    header { padding: 6px 8px; gap: 6px; }
    .title { font-size: 12px; }
    footer { padding: 6px 8px; }
  }
  footer { padding: 8px 12px; background: #161b22; border-top: 1px solid #232b36; }
  input[type=text] {
    width: 100%; padding: 8px 10px; border-radius: 6px;
    border: 1px solid #2b3441; background: #0d1117; color: inherit; font: inherit;
  }
  input[disabled] { opacity: .55; }
  .hint { color: #8b95a3; font-size: 12px; margin-top: 6px; }
  .gate { margin: auto; padding: 24px; max-width: 340px; text-align: center; }
  .gate h1 { font-size: 16px; margin: 0 0 6px; }
  .gate p { color: #8b95a3; margin: 0 0 16px; }
  button {
    margin-top: 10px; width: 100%; padding: 9px; border: 0; border-radius: 6px;
    background: #2f6feb; color: #fff; font: inherit; font-weight: 600; cursor: pointer;
  }
  .error { color: #f08a8a; margin-top: 10px; }
</style>
</head>
<body>
<div class="gate" id="gate">
  <h1>${safeTitle}</h1>
  <p>What should we call you?</p>
  <input type="text" id="name" maxlength="24" placeholder="Your name" autofocus>
  <button id="go">Join</button>
  <div class="error" id="err"></div>
</div>

<header id="bar" hidden>
  <span class="title">${safeTitle}</span>
  <span id="people"></span>
</header>
<pre id="screen" hidden>Connecting…</pre>
<footer id="foot" hidden>
  <input type="text" id="input" placeholder="Watching — the host has not given you typing access" disabled>
  <div class="hint" id="hint"></div>
</footer>

<script>
${ESCAPE_JS}
var TOKEN = ${JSON.stringify(safeToken)}
var base = '/s/' + TOKEN
var guestId = null
var canType = false

var gate = document.getElementById('gate')
var bar = document.getElementById('bar')
var screenEl = document.getElementById('screen')
var foot = document.getElementById('foot')
var peopleEl = document.getElementById('people')
var inputEl = document.getElementById('input')
var hintEl = document.getElementById('hint')
var errEl = document.getElementById('err')

document.getElementById('go').addEventListener('click', join)
document.getElementById('name').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') join()
})

function join() {
  var name = document.getElementById('name').value.trim()
  if (!name) { errEl.textContent = 'A name, please.'; return }
  fetch(base + '/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: name })
  }).then(function (r) {
    return r.json().then(function (b) { return { ok: r.ok, body: b } })
  }).then(function (r) {
    if (!r.ok) { errEl.textContent = r.body.error || 'Could not join.'; return }
    guestId = r.body.guestId
    gate.hidden = true
    bar.hidden = false
    screenEl.hidden = false
    foot.hidden = false
    listen()
  }).catch(function () { errEl.textContent = 'Could not reach the session.' })
}

function listen() {
  var es = new EventSource(base + '/stream?g=' + encodeURIComponent(guestId))
  es.addEventListener('frame', function (e) {
    var atBottom = screenEl.scrollTop + screenEl.clientHeight >= screenEl.scrollHeight - 24
    screenEl.innerHTML = esc(JSON.parse(e.data).text)
    if (atBottom) screenEl.scrollTop = screenEl.scrollHeight
  })
  es.addEventListener('presence', function (e) {
    var p = JSON.parse(e.data)
    canType = !!(p.you && p.you.canType)
    inputEl.disabled = !canType
    inputEl.placeholder = canType
      ? 'Type here — this goes into the session'
      : 'Watching — the host has not given you typing access'
    peopleEl.innerHTML = p.people.map(function (person) {
      return '<span class="chip' + (person.canType ? '' : ' watching') + '">' +
        '<span class="dot"></span>' + esc(person.name) +
        '<span class="role">' + (person.canType ? 'typing' : 'watching') + '</span></span>'
    }).join(' ')
    hintEl.textContent = p.people.length + ' of ' + p.max + ' people here'
  })
  es.addEventListener('ended', function (e) {
    screenEl.textContent = JSON.parse(e.data).reason
    inputEl.disabled = true
    es.close()
  })
  es.onerror = function () { hintEl.textContent = 'Reconnecting…' }
}

inputEl.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' || !canType) return
  var text = inputEl.value
  inputEl.value = ''
  send(text + '\\r')
})

function send(data) {
  fetch(base + '/input', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guestId: guestId, data: data })
  }).then(function (r) {
    if (r.status === 403) { canType = false; inputEl.disabled = true }
  })
}

window.addEventListener('beforeunload', function () {
  if (!guestId) return
  navigator.sendBeacon(base + '/leave', new Blob(
    [JSON.stringify({ guestId: guestId })], { type: 'application/json' }
  ))
})
</script>
</body>
</html>`
}
