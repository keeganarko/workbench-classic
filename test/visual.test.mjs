import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  hasVisualPane,
  isVisualPath,
  isVisualPreviewKind,
  VISUAL_AGENT,
  VISUAL_EFFORT,
  VISUAL_MODEL,
  visualPrompt
} from '../src/shared/visual.js'

describe('visual output', () => {
  test('pins new visual sessions to the speed-first Codex profile', () => {
    assert.equal(VISUAL_AGENT, 'codex')
    assert.equal(VISUAL_MODEL, 'gpt-5.6-luna')
    assert.equal(VISUAL_EFFORT, 'low')
  })

  test('accepts artifacts and images, never reading documents as artwork', () => {
    for (const kind of ['html', 'image', 'svg', 'pdf', 'url']) {
      assert.equal(isVisualPreviewKind(kind), true, kind)
    }
    for (const kind of ['markdown', 'csv', 'json', 'diff', 'text']) {
      assert.equal(isVisualPreviewKind(kind), false, kind)
    }
    assert.equal(isVisualPath('/work/evolving-art.html'), true)
    assert.equal(isVisualPath('/work/answer.md'), false)
  })

  test('finds a visual mirror without mistaking an ordinary pane for one', () => {
    const layout = {
      type: 'split',
      id: 'root',
      dir: 'h',
      sizes: [0.5, 0.5],
      children: [
        { type: 'leaf', id: 'terminal', sessionId: 'same' },
        { type: 'leaf', id: 'canvas', sessionId: 'same', view: 'visual' }
      ]
    }
    assert.equal(hasVisualPane(layout, 'same'), true)
    assert.equal(hasVisualPane(layout, 'other'), false)
  })

  test('makes the artifact the answer and preserves the exact user direction', () => {
    const prompt = visualPrompt('  make the moon warmer, but keep the grain  ')
    assert.match(prompt, /Make the visual itself the response/)
    assert.match(prompt, /animation is mandatory/)
    assert.match(prompt, /Do not use image generation/)
    assert.match(prompt, /Do not simulate animation/)
    assert.match(prompt, /articulated pose/)
    assert.match(prompt, /three independently moving details/)
    assert.match(prompt, /workbench show <path>/)
    assert.match(prompt, /Direction:\nmake the moon warmer, but keep the grain$/)
  })

  test('names the current artifact so a follow-up edits instead of searching', () => {
    const prompt = visualPrompt('make the chase faster', '/work/chase.html')
    assert.match(prompt, /current artifact is "\/work\/chase\.html"/)
    assert.match(prompt, /Update or replace it directly/)
    assert.match(prompt, /Direction:\nmake the chase faster$/)
  })
})
