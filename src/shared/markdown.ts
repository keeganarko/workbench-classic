/**
 * A small Markdown renderer, written here rather than installed.
 *
 * The preview pane needs Markdown badly enough to justify a parser, but not
 * badly enough to justify a dependency: this app runs other people's agents
 * with filesystem access, and the test harness note in `test/ts-resolve.mjs`
 * puts it plainly — every dependency it does not have is one fewer thing to
 * audit. This covers what agents actually write: headings, fenced code,
 * tables, lists, task lists, quotes, links, images and inline emphasis.
 *
 * It is deliberately *not* a sanitiser. Raw HTML in a document is passed
 * through, because a document that writes `<div align="center">` means it. The
 * safety property comes from where the output is rendered instead: a preview
 * document is served with `script-src` restricted to one nonce this file never
 * emits, inside an iframe with no access to the app's origin. Nothing in here
 * is load-bearing for security, so nothing in here has to be perfect.
 *
 * Keep this file free of runtime imports — both processes use it.
 */

import { escapeHtml } from './preview.js'

export interface MarkdownOptions {
  /**
   * Rewrites a link or image href. The preview passes one that resolves a
   * relative path against the document's directory, which is the difference
   * between `![](chart.png)` showing a chart and showing a broken image.
   */
  resolveUrl?: (href: string) => string
}

/** Renders Markdown to an HTML fragment. */
export function renderMarkdown(src: string, opts: MarkdownOptions = {}): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  return blocks(lines, opts)
}

// ── block level ─────────────────────────────────────────────────────────────

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/
const RE_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const RE_HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/
const RE_BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/
const RE_ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/
const RE_QUOTE = /^ {0,3}>[ \t]?(.*)$/
const RE_TABLE_DELIM = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/
/**
 * A raw HTML block. The lookahead is what keeps `<https://example.com>` on its
 * own line an autolink rather than a tag called `https`.
 */
const RE_HTML_BLOCK = /^ {0,3}<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/

/** Tags whose contents are not Markdown, so the block runs to its close tag. */
const RAW_BLOCK_TAGS = new Set(['pre', 'script', 'style', 'table', 'svg', 'math'])

function blocks(lines: string[], opts: MarkdownOptions): string {
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i++
      continue
    }

    const fence = RE_FENCE.exec(line)
    if (fence) {
      const marker = fence[1][0]
      const body: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^ {0,3}${marker}{${fence[1].length},}[ \t]*$`).test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // the closing fence, or the end of the file
      const lang = fence[2].trim().split(/\s+/)[0] ?? ''
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ''
      const label = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : ''
      out.push(`<div class="code-block">${label}<pre><code${cls}>${escapeHtml(body.join('\n'))}\n</code></pre></div>`)
      continue
    }

    if (RE_HR.test(line)) {
      out.push('<hr />')
      i++
      continue
    }

    const heading = RE_HEADING.exec(line)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2], opts)}</h${level}>`)
      i++
      continue
    }

    if (RE_QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length) {
        const q = RE_QUOTE.exec(lines[i])
        if (q) body.push(q[1])
        // A blank line ends the quote; a plain line is lazy continuation.
        else if (lines[i].trim() === '') break
        else body.push(lines[i])
        i++
      }
      out.push(`<blockquote>${blocks(body, opts)}</blockquote>`)
      continue
    }

    if (RE_BULLET.test(line) || RE_ORDERED.test(line)) {
      const [html, next] = list(lines, i, opts)
      out.push(html)
      i = next
      continue
    }

    // A table needs its delimiter row to exist before the header row means anything.
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_DELIM.test(lines[i + 1])) {
      const [html, next] = table(lines, i, opts)
      if (html) {
        out.push(html)
        i = next
        continue
      }
    }

    const html = RE_HTML_BLOCK.exec(line)
    if (html) {
      const tag = html[2].toLowerCase()
      const body: string[] = []
      if (RAW_BLOCK_TAGS.has(tag)) {
        const close = new RegExp(`</${tag}\\s*>`, 'i')
        while (i < lines.length) {
          body.push(lines[i])
          const done = close.test(lines[i])
          i++
          if (done) break
        }
      } else {
        while (i < lines.length && lines[i].trim() !== '') {
          body.push(lines[i])
          i++
        }
      }
      out.push(body.join('\n'))
      continue
    }

    // Paragraph: everything up to a blank line or the start of another block.
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines, i)) {
      // Leading indentation is noise; trailing spaces are not — two of them are
      // how Markdown spells a hard break, and trimming here would eat it.
      para.push(lines[i].replace(/^[ \t]+/, ''))
      i++
    }
    if (para.length) out.push(`<p>${inline(para.join('\n'), opts)}</p>`)
    else i++ // a block starter that fell through; do not spin on it
  }

  return out.join('\n')
}

/** Whether a line inside a paragraph interrupts it. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]
  if (RE_FENCE.test(line) || RE_HEADING.test(line) || RE_HR.test(line)) return true
  if (RE_QUOTE.test(line) || RE_BULLET.test(line) || RE_ORDERED.test(line)) return true
  if (RE_HTML_BLOCK.test(line)) return true
  return line.includes('|') && i + 1 < lines.length && RE_TABLE_DELIM.test(lines[i + 1])
}

/**
 * One list, and every list nested inside it.
 *
 * Items are gathered by indentation: a following line indented past the item's
 * marker belongs to that item, which is what makes a nested list, a second
 * paragraph or a fenced code block inside a bullet come out right.
 */
function list(lines: string[], start: number, opts: MarkdownOptions): [string, number] {
  const first = RE_BULLET.exec(lines[start]) ?? RE_ORDERED.exec(lines[start])!
  const ordered = !RE_BULLET.test(lines[start])
  const baseIndent = width(first[1])
  const items: string[][] = []
  let i = start
  let loose = false
  let trailingBlank = false

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      trailingBlank = true
      i++
      continue
    }

    const bullet = RE_BULLET.exec(line)
    const numbered = RE_ORDERED.exec(line)
    const match = bullet ?? numbered
    const indent = match ? width(match[1]) : width(/^[ \t]*/.exec(line)![0])

    if (match && indent <= baseIndent + 1) {
      // A different marker type at this level starts a new list, not an item.
      if (!!numbered !== ordered) break
      if (trailingBlank && items.length) loose = true
      items.push([match[3]])
      trailingBlank = false
      i++
      continue
    }

    if (indent > baseIndent && items.length) {
      if (trailingBlank) loose = true
      // Strip the item's own indentation so nested blocks parse at column zero.
      items[items.length - 1].push(dedent(line, baseIndent + 2))
      trailingBlank = false
      i++
      continue
    }

    break
  }

  const rendered = items.map((body) => {
    const task = /^\[([ xX])\][ \t]+([\s\S]*)$/.exec(body[0])
    if (task) {
      const checked = task[1].toLowerCase() === 'x' ? ' checked' : ''
      body = [task[2], ...body.slice(1)]
      const inner = renderItem(body, loose, opts)
      return `<li class="task"><input type="checkbox" disabled${checked} />${inner}</li>`
    }
    return `<li>${renderItem(body, loose, opts)}</li>`
  })

  const tag = ordered ? 'ol' : 'ul'
  const startAttr = ordered && first[2] !== '1' ? ` start="${Number(first[2])}"` : ''
  return [`<${tag}${startAttr}>\n${rendered.join('\n')}\n</${tag}>`, i]
}

/** A tight item is inline text; a loose one, or one with sub-blocks, is blocks. */
function renderItem(body: string[], loose: boolean, opts: MarkdownOptions): string {
  const multiline = body.length > 1 && body.slice(1).some((l) => l.trim() !== '')
  if (!loose && !multiline) return inline(body[0], opts)
  const html = blocks(body, opts)
  // The item's own text keeps its `<p>` only when the list is loose — otherwise
  // every bullet grows a paragraph's worth of margin. Only the *leading*
  // paragraph is unwrapped, so `- a` with a nested list under it stays tight
  // while a genuine second paragraph inside the item keeps its own.
  if (!loose) return html.replace(/^<p>([\s\S]*?)<\/p>(\n|$)/, '$1$2')
  return html
}

function table(lines: string[], start: number, opts: MarkdownOptions): [string | null, number] {
  const header = splitRow(lines[start])
  const align = splitRow(lines[start + 1]).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return ''
  })
  if (header.length === 0 || align.length !== header.length) return [null, start]

  const rows: string[][] = []
  let i = start + 2
  while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
    rows.push(splitRow(lines[i]))
    i++
  }

  const th = header
    .map((cell, c) => `<th${styleFor(align[c])}>${inline(cell, opts)}</th>`)
    .join('')
  const body = rows
    .map((row) => {
      const cells = header.map(
        (_, c) => `<td${styleFor(align[c])}>${inline(row[c] ?? '', opts)}</td>`
      )
      return `<tr>${cells.join('')}</tr>`
    })
    .join('\n')

  return [
    `<div class="table-wrap"><table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`,
    i
  ]
}

function styleFor(align: string): string {
  return align ? ` style="text-align:${align}"` : ''
}

/** Splits a table row, honouring `\|` inside a cell. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (trimmed[i] === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += trimmed[i]
  }
  cells.push(cur.trim())
  return cells
}

/** Tab-aware indentation width, so a tab-indented list nests like a space one. */
function width(prefix: string): number {
  let n = 0
  for (const ch of prefix) n += ch === '\t' ? 4 - (n % 4) : 1
  return n
}

function dedent(line: string, columns: number): string {
  let i = 0
  let n = 0
  while (i < line.length && n < columns) {
    if (line[i] === ' ') n += 1
    else if (line[i] === '\t') n += 4 - (n % 4)
    else break
    i++
  }
  return line.slice(i)
}

// ── inline level ────────────────────────────────────────────────────────────

const RE_ESCAPE = /^\\([\\`*_{}[\]()#+\-.!>~|])/
const RE_CODE = /^(`+)([\s\S]*?[^`])\1(?!`)/
const RE_IMAGE = /^!\[([^\]]*)\]\(<?([^)<>\s]*)>?(?:[ \t]+"([^"]*)")?\)/
const RE_LINK = /^\[((?:[^[\]]|\[[^\]]*\])*)\]\(<?([^)<>\s]*)>?(?:[ \t]+"([^"]*)")?\)/
const RE_AUTOLINK = /^<((?:https?|mailto):[^>\s]+)>/
const RE_RAW_TAG = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*?)?\/?>/
const RE_COMMENT = /^<!--[\s\S]*?-->/
const RE_STRONG = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/
const RE_EM_STAR = /^\*(?=\S)([\s\S]*?\S)\*(?!\*)/
const RE_EM_UNDER = /^_(?=\S)([\s\S]*?\S)_(?!\w)/
const RE_DEL = /^~~(?=\S)([\s\S]*?\S)~~/
const RE_BARE_URL = /^https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,:;!?]/

function inline(text: string, opts: MarkdownOptions): string {
  const link = (href: string): string => {
    const resolved = opts.resolveUrl ? opts.resolveUrl(href) : href
    return escapeHtml(resolved)
  }

  let out = ''
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    let m: RegExpExecArray | null

    if ((m = RE_ESCAPE.exec(rest))) {
      out += escapeHtml(m[1])
      i += m[0].length
      continue
    }
    if ((m = RE_CODE.exec(rest))) {
      out += `<code>${escapeHtml(m[2].replace(/^ (.*) $/, '$1'))}</code>`
      i += m[0].length
      continue
    }
    if ((m = RE_COMMENT.exec(rest))) {
      i += m[0].length
      continue
    }
    if ((m = RE_IMAGE.exec(rest))) {
      const title = m[3] ? ` title="${escapeHtml(m[3])}"` : ''
      out += `<img src="${link(m[2])}" alt="${escapeHtml(m[1])}"${title} />`
      i += m[0].length
      continue
    }
    if ((m = RE_LINK.exec(rest))) {
      const title = m[3] ? ` title="${escapeHtml(m[3])}"` : ''
      out += `<a href="${link(m[2])}"${title}>${inline(m[1], opts)}</a>`
      i += m[0].length
      continue
    }
    if ((m = RE_AUTOLINK.exec(rest))) {
      out += `<a href="${escapeHtml(m[1])}">${escapeHtml(m[1])}</a>`
      i += m[0].length
      continue
    }
    if ((m = RE_RAW_TAG.exec(rest))) {
      out += m[0]
      i += m[0].length
      continue
    }
    if ((m = RE_STRONG.exec(rest))) {
      out += `<strong>${inline(m[2], opts)}</strong>`
      i += m[0].length
      continue
    }
    if ((m = RE_DEL.exec(rest))) {
      out += `<del>${inline(m[1], opts)}</del>`
      i += m[0].length
      continue
    }
    if ((m = RE_EM_STAR.exec(rest))) {
      out += `<em>${inline(m[1], opts)}</em>`
      i += m[0].length
      continue
    }
    // `_` only opens emphasis at a word boundary, or snake_case would italicise.
    if (rest[0] === '_' && (i === 0 || /[\s([{<"']/.test(text[i - 1]))) {
      if ((m = RE_EM_UNDER.exec(rest))) {
        out += `<em>${inline(m[1], opts)}</em>`
        i += m[0].length
        continue
      }
    }
    if ((m = RE_BARE_URL.exec(rest))) {
      out += `<a href="${escapeHtml(m[0])}">${escapeHtml(m[0])}</a>`
      i += m[0].length
      continue
    }
    // Two trailing spaces, or a trailing backslash, is a hard break.
    if (rest.startsWith('\n')) {
      if (/ {2}$/.test(out)) out = out.replace(/ +$/, '<br />\n')
      else if (out.endsWith('\\')) out = `${out.slice(0, -1)}<br />\n`
      else out += '\n'
      i += 1
      continue
    }

    out += escapeHtml(text[i])
    i++
  }
  return out
}
