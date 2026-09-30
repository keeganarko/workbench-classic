/**
 * The Markdown renderer behind the preview dock.
 *
 * It is a few hundred lines rather than a dependency, so the tests carry the
 * weight the library's own test suite would have. Two things are being pinned:
 * that the common shapes an agent actually writes come out right (headings,
 * fenced code, tables, task lists, nested lists), and that the output is
 * *predictable* — every span of user text that is not a construct arrives
 * escaped, so the document's policy is defending against a smaller surface than
 * "whatever the file said".
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { renderMarkdown } from '../src/shared/markdown.js'

/** The renderer with link resolution wired the way the dock wires it. */
const inFolder = { resolveUrl: (href) => `wb-preview://f/docs/${href}` }

describe('blocks', () => {
  test('headings, one level per hash', () => {
    assert.equal(renderMarkdown('# One'), '<h1>One</h1>')
    assert.equal(renderMarkdown('### Three'), '<h3>Three</h3>')
    // Six is the floor; seven hashes is just a paragraph starting with hashes.
    assert.equal(renderMarkdown('###### Six'), '<h6>Six</h6>')
    assert.ok(renderMarkdown('####### Seven').startsWith('<p>'))
  })

  test('paragraphs split on blank lines and keep soft wraps', () => {
    const html = renderMarkdown('one\ntwo\n\nthree')
    assert.equal(html, '<p>one\ntwo</p>\n<p>three</p>')
  })

  test('fenced code keeps its language and escapes its body', () => {
    const html = renderMarkdown('```js\nconst a = 1 < 2 && "x"\n```')
    assert.ok(html.includes('<div class="code-lang">js</div>'))
    assert.ok(html.includes('<code class="language-js">'))
    assert.ok(html.includes('const a = 1 &lt; 2 &amp;&amp; &quot;x&quot;'))
  })

  test('an unclosed fence runs to the end of the file rather than eating the parse', () => {
    const html = renderMarkdown('```\nnever closed\n')
    assert.ok(html.includes('never closed'))
    assert.ok(html.includes('</code></pre>'))
  })

  test('markdown inside a fence is code, not markup', () => {
    const html = renderMarkdown('```\n# not a heading\n**not bold**\n```')
    assert.ok(!html.includes('<h1>'))
    assert.ok(!html.includes('<strong>'))
  })

  test('blockquotes nest their contents as blocks', () => {
    const html = renderMarkdown('> ## Note\n> body')
    assert.ok(html.startsWith('<blockquote>'))
    assert.ok(html.includes('<h2>Note</h2>'))
  })

  test('a horizontal rule is a rule, not a heading underline', () => {
    assert.equal(renderMarkdown('---'), '<hr />')
    assert.equal(renderMarkdown('***'), '<hr />')
  })
})

describe('lists', () => {
  test('bullets and numbers pick the right container', () => {
    assert.equal(renderMarkdown('- a\n- b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>')
    assert.ok(renderMarkdown('1. a\n2. b').startsWith('<ol>'))
  })

  test('a numbered list starts where it says it does', () => {
    assert.ok(renderMarkdown('3. c\n4. d').includes('start="3"'))
  })

  test('indentation nests, and dedenting closes', () => {
    const html = renderMarkdown('- a\n  - a1\n- b')
    assert.equal(html, '<ul>\n<li>a\n<ul>\n<li>a1</li>\n</ul></li>\n<li>b</li>\n</ul>')
  })

  test('a tight item with a sublist does not grow a paragraph', () => {
    // `<p>` inside a tight bullet is a visible margin, and a list of one-liners
    // with one nested child should not suddenly space itself out.
    assert.ok(!renderMarkdown('- a\n  - a1').includes('<p>'))
  })

  test('task lists render as disabled checkboxes', () => {
    const html = renderMarkdown('- [x] done\n- [ ] todo')
    assert.ok(html.includes('<input type="checkbox" disabled checked />'))
    assert.ok(html.includes('<input type="checkbox" disabled />'))
    // Disabled, because a preview is a view of a file, not an editor of one.
    assert.ok(!html.includes('<input type="checkbox" />'))
  })

  test('a blank line between items makes the list loose', () => {
    const html = renderMarkdown('- a\n\n- b')
    assert.ok(html.includes('<p>a</p>'))
  })
})

describe('tables', () => {
  test('a delimiter row is what makes a table a table', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
    assert.ok(html.includes('<th>a</th>'))
    assert.ok(html.includes('<td>1</td>'))
    // Without the delimiter row those pipes are just text.
    assert.ok(!renderMarkdown('| a | b |\n| 1 | 2 |').includes('<table'))
  })

  test('colons in the delimiter row set column alignment', () => {
    const html = renderMarkdown('| l | c | r |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |')
    assert.ok(html.includes('text-align:left'))
    assert.ok(html.includes('text-align:center'))
    assert.ok(html.includes('text-align:right'))
  })

  test('a short row is padded rather than dropped', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 |')
    assert.equal((html.match(/<td/g) ?? []).length, 2)
  })
})

describe('inline', () => {
  test('emphasis, strong and strikethrough', () => {
    assert.ok(renderMarkdown('*a*').includes('<em>a</em>'))
    assert.ok(renderMarkdown('_a_').includes('<em>a</em>'))
    assert.ok(renderMarkdown('**a**').includes('<strong>a</strong>'))
    assert.ok(renderMarkdown('~~a~~').includes('<del>a</del>'))
  })

  test('an underscore inside a word is an underscore', () => {
    // `snake_case_name` is a variable, not two emphasis runs.
    const html = renderMarkdown('snake_case_name')
    assert.ok(!html.includes('<em>'))
    assert.ok(html.includes('snake_case_name'))
  })

  test('code spans escape their contents and win over emphasis', () => {
    const html = renderMarkdown('`a < *b*`')
    assert.equal(html, '<p><code>a &lt; *b*</code></p>')
  })

  test('a backslash escape produces the literal character', () => {
    assert.equal(renderMarkdown('\\*not emphasis\\*'), '<p>*not emphasis*</p>')
  })

  test('two trailing spaces and a trailing backslash are both hard breaks', () => {
    assert.ok(renderMarkdown('a  \nb').includes('<br />'))
    assert.ok(renderMarkdown('a\\\nb').includes('<br />'))
    assert.ok(!renderMarkdown('a\nb').includes('<br />'))
  })

  test('a bare URL becomes a link, and an autolink keeps its text', () => {
    assert.ok(renderMarkdown('see https://example.com now').includes('href="https://example.com"'))
    assert.ok(renderMarkdown('<https://example.com>').includes('>https://example.com</a>'))
  })
})

describe('links and images', () => {
  test('relative targets go through the resolver, absolute ones do not', () => {
    const html = renderMarkdown('![shot](img/a.png) and [doc](b.md)', inFolder)
    assert.ok(html.includes('src="wb-preview://f/docs/img/a.png"'))
    assert.ok(html.includes('href="wb-preview://f/docs/b.md"'))
  })

  test('a title becomes a title attribute', () => {
    const html = renderMarkdown('[x](a.md "why it matters")')
    assert.ok(html.includes('title="why it matters"'))
  })

  test('quotes in a URL cannot break out of the attribute', () => {
    // The one place a link could stop being a link and start being markup.
    const html = renderMarkdown('[x](a" onclick="alert(1))')
    assert.ok(!html.includes('onclick="alert'))
    assert.ok(html.includes('&quot;'))
  })
})

describe('escaping', () => {
  test('plain text is escaped, so the document policy is not the only defence', () => {
    const html = renderMarkdown('a < b & c > d')
    assert.equal(html, '<p>a &lt; b &amp; c &gt; d</p>')
  })

  test('raw HTML is passed through — this is not a sanitiser', () => {
    // Pinned deliberately, and the opposite of what it looks like. Raw HTML in
    // Markdown is a feature, and the safety property lives somewhere else: the
    // document is served with `script-src` bound to a nonce this renderer never
    // emits, so a passed-through `<script>` is inert markup. If that policy ever
    // changes, this test is the reminder that it was load-bearing.
    const html = renderMarkdown('here is <script>alert(1)</script> inline')
    assert.ok(html.includes('<script>alert(1)</script>'))
    assert.ok(renderMarkdown('<div class="x">\nraw\n</div>').includes('<div class="x">'))
  })
})

describe('robustness', () => {
  test('empty input renders to nothing', () => {
    assert.equal(renderMarkdown(''), '')
    assert.equal(renderMarkdown('\n\n\n'), '')
  })

  test('CRLF input parses the same as LF', () => {
    assert.equal(renderMarkdown('# a\r\n\r\nb\r\n'), renderMarkdown('# a\n\nb\n'))
  })

  test('a long realistic document terminates and covers every construct', () => {
    const src = [
      '# Report',
      '',
      'Summary with **bold**, `code`, and a [link](./other.md).',
      '',
      '## Findings',
      '',
      '1. First',
      '   - nested',
      '2. Second',
      '',
      '| metric | value |',
      '| --- | ---: |',
      '| latency | 12ms |',
      '',
      '> A caveat.',
      '',
      '```python',
      'print("hi")',
      '```',
      '',
      '- [x] shipped',
      '- [ ] not yet',
      '',
      '---',
      ''
    ].join('\n')

    const html = renderMarkdown(src, inFolder)
    for (const fragment of [
      '<h1>Report</h1>',
      '<strong>bold</strong>',
      '<code>code</code>',
      '<ol',
      '<table',
      '<blockquote>',
      'language-python',
      'type="checkbox"',
      '<hr />'
    ]) {
      assert.ok(html.includes(fragment), `missing ${fragment}`)
    }
  })
})
