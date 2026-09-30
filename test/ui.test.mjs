import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  accel,
  attentionQueue,
  hasPrimaryModifier,
  clipboardAccel,
  hasSecondaryModifier,
  isTerminalCopyShortcut,
  isTerminalPasteShortcut,
  nextNeedingAttention,
  shortPath
} from '../src/renderer/src/lib/ui.js'
import { isRecentStatus } from '../src/shared/sessionOrder.js'

/** Only the fields the attention queue reads; the rest of a Session is noise here. */
function session(id, status, lastStatusChangeAt, alive = true) {
  return { id, status, lastStatusChangeAt, alive }
}

describe('desktop presentation helpers', () => {
  test('shortens macOS, Linux, WSL-mounted Windows, and native Windows homes', () => {
    assert.equal(shortPath('/Users/keegan/Dev/workbench'), '~/Dev/workbench')
    assert.equal(shortPath('/home/keegan/Dev/workbench'), '~/Dev/workbench')
    assert.equal(shortPath('/mnt/c/Users/keegan/Dev/workbench'), '~/Dev/workbench')
    assert.equal(shortPath('C:\\Users\\keegan\\Dev\\workbench'), '~\\Dev\\workbench')
    assert.equal(shortPath('/opt/workbench'), '/opt/workbench')
  })

  test('renders accelerators for macOS and WSLg/Linux', () => {
    assert.equal(accel('CmdOrCtrl+Shift+N', 'darwin'), '⌘⇧N')
    assert.equal(accel('CmdOrCtrl+Shift+N', 'linux'), 'Ctrl+Shift+N')
    assert.equal(accel('CmdOrCtrl+Alt+I', 'Win32'), 'Ctrl+Alt+I')
  })

  test('uses Command on macOS and Control elsewhere', () => {
    assert.equal(hasPrimaryModifier({ metaKey: true, ctrlKey: false }, 'darwin'), true)
    assert.equal(hasPrimaryModifier({ metaKey: false, ctrlKey: true }, 'linux'), true)
    assert.equal(hasPrimaryModifier({ metaKey: true, ctrlKey: false }, 'linux'), false)
  })

  test('the secondary modifier is whichever one the primary is not', () => {
    // macOS: ⌘ jumps to a session, ⌃ jumps to a pane, and neither answers for
    // the other — a chord that satisfied both would fire two jumps.
    const ctrl = { metaKey: false, ctrlKey: true, altKey: false }
    const cmd = { metaKey: true, ctrlKey: false, altKey: false }
    const both = { metaKey: true, ctrlKey: true, altKey: false }
    assert.equal(hasSecondaryModifier(ctrl, 'darwin'), true)
    assert.equal(hasSecondaryModifier(cmd, 'darwin'), false)
    assert.equal(hasSecondaryModifier(both, 'darwin'), false)

    // Elsewhere Ctrl is the primary, so the pane jump falls to Alt.
    const alt = { metaKey: false, ctrlKey: false, altKey: true }
    assert.equal(hasSecondaryModifier(alt, 'linux'), true)
    assert.equal(hasSecondaryModifier(ctrl, 'linux'), false)
  })

  const chord = (letter, over = {}) => ({
    type: 'keydown',
    key: letter,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over
  })

  test('Ctrl-V and Ctrl-Shift-V paste inside a terminal, off macOS only', () => {
    assert.equal(isTerminalPasteShortcut(chord('v'), 'linux'), true)
    assert.equal(isTerminalPasteShortcut(chord('v'), 'Win32'), true)
    // Both chords work: Ctrl-V is what people reach for, Ctrl-Shift-V is what
    // Linux terminals taught them, and neither is spoken for elsewhere.
    assert.equal(isTerminalPasteShortcut(chord('v', { shiftKey: true }), 'linux'), true)
    // macOS is handled by the Edit menu's paste role, so this must stay out of it.
    assert.equal(isTerminalPasteShortcut(chord('v', { ctrlKey: false, metaKey: true }), 'darwin'), false)
    assert.equal(isTerminalPasteShortcut(chord('v'), 'darwin'), false)
    assert.equal(isTerminalPasteShortcut(chord('v', { altKey: true }), 'linux'), false)
    assert.equal(isTerminalPasteShortcut(chord('c'), 'linux'), false)
    assert.equal(isTerminalPasteShortcut(chord('v', { type: 'keyup' }), 'linux'), false)
  })

  test('copy needs the Shift, so that bare Ctrl-C stays SIGINT', () => {
    assert.equal(isTerminalCopyShortcut(chord('c', { shiftKey: true }), 'linux'), true)
    assert.equal(isTerminalCopyShortcut(chord('c', { shiftKey: true }), 'Win32'), true)
    assert.equal(isTerminalCopyShortcut(chord('c'), 'linux'), false)
    assert.equal(isTerminalCopyShortcut(chord('c', { shiftKey: true }), 'darwin'), false)
    assert.equal(isTerminalCopyShortcut(chord('v', { shiftKey: true }), 'linux'), false)
    assert.equal(isTerminalCopyShortcut(chord('c', { shiftKey: true, type: 'keyup' }), 'linux'), false)
  })

  test('Flow-style Shift-Insert pastes once without taking modified Insert or keyup', () => {
    const paste = chord('Insert', { ctrlKey: false, shiftKey: true })
    for (const platform of ['Win32', 'linux']) {
      assert.equal(isTerminalPasteShortcut(paste, platform), true)
      for (const change of [{ shiftKey: false }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { type: 'keyup' }]) {
        assert.equal(isTerminalPasteShortcut({ ...paste, ...change }, platform), false)
      }
    }
    assert.equal(isTerminalPasteShortcut(paste, 'darwin'), false)
  })

  test('the clipboard menu hints name the keys that platform really uses', () => {
    assert.equal(clipboardAccel('copy', 'darwin'), '⌘C')
    assert.equal(clipboardAccel('paste', 'darwin'), '⌘V')
    // Never "Ctrl+C" on Windows: there that chord interrupts the program.
    assert.equal(clipboardAccel('copy', 'Win32'), 'Ctrl+Shift+C')
    assert.equal(clipboardAccel('paste', 'Win32'), 'Ctrl+V')
  })

  test('Recent is mutually exclusive with every actionable category', () => {
    assert.equal(isRecentStatus('idle'), true)
    assert.equal(isRecentStatus('exited'), true)
    for (const status of ['working', 'waiting', 'review', 'failed']) {
      assert.equal(isRecentStatus(status), false, status)
    }
  })
})

describe('the attention queue', () => {
  test('orders by urgency first, then by who has been stuck longest', () => {
    const queue = attentionQueue([
      session('review-new', 'review', 500),
      session('waiting-new', 'waiting', 400),
      session('failed', 'failed', 100),
      session('waiting-old', 'waiting', 200),
      session('review-old', 'review', 50)
    ])
    assert.deepEqual(
      queue.map((s) => s.id),
      ['waiting-old', 'waiting-new', 'failed', 'review-old', 'review-new']
    )
  })

  test('a working or idle session is not in the queue, and neither is a dead one', () => {
    const queue = attentionQueue([
      session('working', 'working', 1),
      session('idle', 'idle', 1),
      session('exited', 'exited', 1),
      // Status outlives the process: a session that died while waiting must not
      // keep sending you to a pane where nothing can be answered.
      session('dead-but-waiting', 'waiting', 1, false),
      session('waiting', 'waiting', 1)
    ])
    assert.deepEqual(
      queue.map((s) => s.id),
      ['waiting']
    )
  })

  test('repeated presses walk the whole queue and then wrap', () => {
    const sessions = [
      session('a', 'waiting', 100),
      session('b', 'waiting', 200),
      session('c', 'review', 50)
    ]
    assert.equal(nextNeedingAttention(sessions, 'a').id, 'b')
    assert.equal(nextNeedingAttention(sessions, 'b').id, 'c')
    assert.equal(nextNeedingAttention(sessions, 'c').id, 'a')
  })

  test('from a session that wants nothing, it goes to the most urgent', () => {
    const sessions = [session('busy', 'working', 1), session('blocked', 'waiting', 2)]
    assert.equal(nextNeedingAttention(sessions, 'busy').id, 'blocked')
    assert.equal(nextNeedingAttention(sessions, null).id, 'blocked')
  })

  test('nothing to answer is null, not a jump to somewhere arbitrary', () => {
    assert.equal(nextNeedingAttention([session('busy', 'working', 1)], 'busy'), null)
    assert.equal(nextNeedingAttention([], null), null)
  })
})
