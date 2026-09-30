/**
 * Copy mode eats prompts.
 *
 * The generated tmux.conf sets `mouse on`, which is what makes the scroll wheel
 * work over a pane — and a scroll wheel over a pane is exactly what puts tmux
 * into copy mode. Copy mode then treats arriving keys as its own commands
 * rather than passing them to the agent underneath, so a prompt sent to a
 * scrolled-up pane is consumed and never runs.
 *
 * What makes it worth a test rather than a comment is that nothing reports it:
 * `send-keys` exits 0 either way, so the composer clears and the session flips
 * to `working` for a turn that will never happen. The user's only clue is
 * tmux's copy-mode indicator in the corner of the pane.
 *
 * These tests pin the fix: every path that types into a pane cancels copy mode
 * first, and does so without disturbing a pane that was never in a mode.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { Tmux, TmuxError, serverIsGone } from '../src/main/tmux.ts'

const NAME = 'term_abc1234567'

/** A Tmux whose every server call is recorded instead of executed. */
function recorder() {
  const calls = []
  const tmux = new Tmux('tmux', '/tmp/workbench-test/tmux.conf')
  tmux.run = async (args) => {
    calls.push(args)
    return ''
  }
  return { tmux, calls }
}

const isCancel = (a) => a[0] === 'if-shell'
const isSend = (a) => a[0] === 'send-keys'

describe('cancelling copy mode before typing into a pane', () => {
  test('sendText cancels copy mode before it types', async () => {
    const { tmux, calls } = recorder()
    await tmux.sendText(NAME, 'hello')

    assert.equal(calls.length, 2)
    assert.ok(isCancel(calls[0]), 'the cancel must come first, or the text is eaten')
    assert.ok(isSend(calls[1]))
    assert.deepEqual(calls[1], ['send-keys', '-t', `${NAME}.0`, '-l', '--', 'hello'])
  })

  test('the cancel is conditional, targeted, and leaves a normal pane alone', async () => {
    const { tmux, calls } = recorder()
    await tmux.sendText(NAME, 'hello')

    // `if-shell -F` is evaluated by the server: on a pane that is not in a mode
    // the guard is false and nothing is sent, so this costs a round trip and
    // changes nothing. That is what makes it safe on every single send.
    assert.deepEqual(calls[0], [
      'if-shell',
      '-F',
      '-t',
      `${NAME}.0`,
      '#{pane_in_mode}',
      `send-keys -t ${NAME}.0 -X cancel`
    ])
  })

  test('sendKeys cancels copy mode before named keys', async () => {
    const { tmux, calls } = recorder()
    await tmux.sendKeys(NAME, ['C-c'])

    assert.equal(calls.length, 2)
    assert.ok(isCancel(calls[0]), 'an interrupt is worthless if copy mode swallows it')
    assert.deepEqual(calls[1], ['send-keys', '-t', `${NAME}.0`, 'C-c'])
  })

  test('submitPrompt guards both the text and its Enter', async () => {
    const { tmux, calls } = recorder()
    await tmux.submitPrompt(NAME, 'run the tests', 1)

    // The wheel is faster than the beat between the text and the Enter, so a
    // scroll landing in that gap would otherwise strand a fully typed prompt.
    assert.deepEqual(calls.map(isCancel), [true, false, true, false])
    assert.equal(calls[1][4], '--')
    assert.equal(calls[1][5], 'run the tests')
    assert.deepEqual(calls[3], ['send-keys', '-t', `${NAME}.0`, 'Enter'])
  })

  test('an empty send stays empty — no cancel, no keys, no round trip', async () => {
    const { tmux, calls } = recorder()
    await tmux.sendText(NAME, '')
    await tmux.sendKeys(NAME, [])
    assert.deepEqual(calls, [])
  })

  test('a failing cancel never blocks the send it was guarding', async () => {
    // `leaveCopyMode` goes through `tryRun`, so a pane that has died between
    // the guard and the send still reaches `send-keys` — and reports the real
    // error from there rather than a misleading one from the guard.
    const calls = []
    const tmux = new Tmux('tmux', '/tmp/workbench-test/tmux.conf')
    tmux.run = async (args) => {
      calls.push(args)
      if (isCancel(args)) throw new Error('no such pane')
      return ''
    }

    await tmux.sendText(NAME, 'still delivered')
    assert.equal(calls.length, 2)
    assert.ok(isSend(calls[1]))
  })
})

/**
 * A dead tmux server is an answer, not an outage.
 *
 * `poll` deliberately refuses to conclude anything from a failed pane snapshot,
 * because one bad tmux call would otherwise mark every running session exited.
 * That guard is right for a timeout or an unreadable socket and wrong for the
 * one error that is genuinely conclusive: a tmux server owns every pane it ever
 * started, so if the server is gone, they all are.
 *
 * Left unhandled, that case never resolves — the sessions keep advertising a
 * liveness they cannot have, and the poll writes the same stack trace to the
 * log once a second for as long as the app stays open.
 */
describe('recognising a tmux server that is gone', () => {
  test('recognises both ways tmux words it', () => {
    // Unattended socket file, versus no socket file at all.
    assert.equal(serverIsGone(new TmuxError('failed', 'no server running on /tmp/tmux-1000/terminal\n')), true)
    assert.equal(
      serverIsGone(new TmuxError('failed', 'error connecting to /tmp/tmux-1000/terminal (No such file or directory)\n')),
      true
    )
  })

  test('every other tmux failure stays inconclusive', () => {
    // These say nothing about what is still alive, so liveness must be left be.
    assert.equal(serverIsGone(new TmuxError('failed', "can't find pane: term_abc.0\n")), false)
    assert.equal(serverIsGone(new TmuxError('tmux list-panes timed out')), false)
  })

  test('is not fooled by something that merely failed near tmux', () => {
    assert.equal(serverIsGone(new Error('no server running')), false)
    assert.equal(serverIsGone(undefined), false)
    assert.equal(serverIsGone(null), false)
  })
})
