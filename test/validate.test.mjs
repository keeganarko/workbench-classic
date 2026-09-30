/**
 * The IPC boundary. The renderer displays text written by an agent, so every
 * payload arriving from it is treated as hostile until checked.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  ValidationError,
  isSafeExternalUrl,
  asSafeExternalUrl,
  asSessionId,
  asSessionIdList,
  asVisiblePanes,
  asPrefsPatch,
  asCreateSessionOptions,
  asPermissionMode,
  asBusAccess,
  asWorkspaceRequest,
  asDiffQuery,
  asPathBatch
} from '../src/main/validate.js'

test('bus grants explicitly recognize App Manager without accepting invented levels', () => {
  for (const grant of ['off', 'read', 'full', 'manager', 'app-manager']) assert.equal(asBusAccess(grant), grant)
  for (const invalid of ['global-manager', 'admin', null, {}, true, 4]) assert.throws(() => asBusAccess(invalid), ValidationError)
})

describe('external links', () => {
  test('opens only the three schemes a link in a transcript may use', () => {
    for (const url of [
      'https://example.com/docs',
      'http://127.0.0.1:5173/',
      'mailto:someone@example.com',
      'HTTPS://EXAMPLE.COM'
    ]) {
      assert.equal(isSafeExternalUrl(url), true, url)
    }
  })

  test('refuses every scheme that could execute or read local state', () => {
    const hostile = [
      'file:///Users/me/.ssh/id_rsa',
      'file://localhost/etc/passwd',
      'javascript:alert(document.cookie)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'about:blank',
      'ftp://example.com/x',
      'ssh://root@example.com',
      'smb://server/share',
      'x-apple-shortcut://run?name=wipe',
      'vscode://file/etc/passwd'
    ]
    for (const url of hostile) {
      assert.equal(isSafeExternalUrl(url), false, url)
    }
  })

  test('refuses anything that is not a parseable absolute URL', () => {
    for (const value of [
      '',
      'not a url',
      '/etc/passwd',
      './relative',
      '//example.com',
      null,
      undefined,
      42,
      {},
      ['https://example.com'],
      `https://example.com/${'a'.repeat(9000)}`
    ]) {
      assert.equal(isSafeExternalUrl(value), false, String(value).slice(0, 40))
    }
  })

  test('asSafeExternalUrl throws with a message worth showing', () => {
    assert.equal(asSafeExternalUrl('https://example.com'), 'https://example.com')
    assert.throws(() => asSafeExternalUrl('file:///etc/passwd'), ValidationError)
    assert.throws(() => asSafeExternalUrl('javascript:alert(1)'), /only http, https and mailto/)
  })
})

describe('ipc payloads', () => {
  test('session ids must look like session ids', () => {
    assert.equal(asSessionId('a1B2-_'), 'a1B2-_')
    for (const bad of ['', '../../etc/passwd', 'a b', 'a;rm -rf /', 'x'.repeat(65), 42, null]) {
      assert.throws(() => asSessionId(bad), ValidationError, String(bad))
    }
  })

  test('a session id list is bounded and element-checked', () => {
    assert.deepEqual(asSessionIdList(['a', 'b']), ['a', 'b'])
    assert.throws(() => asSessionIdList('a'), ValidationError)
    assert.throws(() => asSessionIdList(['ok', 'not ok']), ValidationError)
    assert.throws(() => asSessionIdList(new Array(201).fill('a')), ValidationError)
  })

  test('visible panes are validated before they can suppress a notification', () => {
    assert.deepEqual(asVisiblePanes({ sessionIds: ['a'], focusedSessionId: 'a' }), {
      sessionIds: ['a'],
      focusedSessionId: 'a'
    })
    assert.deepEqual(asVisiblePanes({ sessionIds: [], focusedSessionId: null }), {
      sessionIds: [],
      focusedSessionId: null
    })
    assert.throws(() => asVisiblePanes({ sessionIds: ['bad id'] }), ValidationError)
    assert.throws(() => asVisiblePanes(null), ValidationError)
  })

  test('unknown preference keys are dropped instead of persisted', () => {
    const patch = asPrefsPatch({ fontSize: 14, __proto__: 'x', evilKey: true, theme: 'cursor-dark' })
    // `theme` is in there on purpose: it was a real preference once, and a key
    // that stopped existing has to be dropped as firmly as one that never did.
    assert.deepEqual(patch, { fontSize: 14 })
  })

  test('numeric preferences are clamped to a usable range', () => {
    assert.equal(asPrefsPatch({ fontSize: 9999 }).fontSize, 48)
    assert.equal(asPrefsPatch({ fontSize: -5 }).fontSize, 6)
    assert.equal(asPrefsPatch({ scrollback: 1 }).scrollback, 1000)
    assert.equal(asPrefsPatch({ lineHeight: 99 }).lineHeight, 3)
  })

  test('a trigger whose regex does not compile is rejected at the boundary', () => {
    assert.throws(
      () => asPrefsPatch({ triggers: [{ id: 't', pattern: '([', flags: '', action: 'waiting' }] }),
      /Invalid trigger pattern/
    )
    assert.throws(
      () => asPrefsPatch({ triggers: [{ id: 't', pattern: 'ok', action: 'explode' }] }),
      ValidationError
    )
    const ok = asPrefsPatch({ triggers: [{ id: 't', pattern: 'ok', flags: 'i', action: 'failed' }] })
    assert.equal(ok.triggers[0].action, 'failed')
  })

  test('permission mode accepts exactly the three modes the UI offers', () => {
    assert.equal(asPermissionMode('default'), 'default')
    assert.equal(asPermissionMode('auto'), 'auto')
    assert.equal(asPermissionMode('full-access'), 'full-access')
    assert.equal(asPermissionMode(undefined), undefined)
    assert.throws(() => asPermissionMode('yolo'), ValidationError)
  })

  test('launch options bound the argv a caller can inject', () => {
    const opts = asCreateSessionOptions({
      agent: 'codex',
      cwd: '/tmp',
      permissionMode: 'full-access',
      extraArgs: new Array(100).fill('--flag')
    })
    assert.equal(opts.agent, 'codex')
    assert.equal(opts.permissionMode, 'full-access')
    assert.equal(opts.extraArgs.length, 32)
    assert.throws(() => asCreateSessionOptions({ agent: 'rm -rf' }), ValidationError)
    assert.throws(() => asCreateSessionOptions(null), ValidationError)
  })
})

describe('workspace requests', () => {
  test('only the three real modes are accepted', () => {
    assert.equal(asWorkspaceRequest({ cwd: '/tmp', mode: 'isolated', count: 2 }).req.mode, 'isolated')
    for (const mode of ['detached', '', null, undefined, 'CURRENT']) {
      assert.throws(() => asWorkspaceRequest({ cwd: '/tmp', mode }), ValidationError, String(mode))
    }
  })

  test('the agent count is clamped, not trusted', () => {
    // Each one above the first is a full checkout on disk.
    assert.equal(asWorkspaceRequest({ cwd: '/tmp', mode: 'shared', count: 9999 }).count, 8)
    assert.equal(asWorkspaceRequest({ cwd: '/tmp', mode: 'shared', count: 0 }).count, 1)
    assert.equal(asWorkspaceRequest({ cwd: '/tmp', mode: 'shared' }).count, 1)
    assert.throws(
      () => asWorkspaceRequest({ cwd: '/tmp', mode: 'shared', count: 'lots' }),
      ValidationError
    )
  })

  test('a folder is required and bounded', () => {
    assert.throws(() => asWorkspaceRequest({ mode: 'shared' }), ValidationError)
    assert.throws(
      () => asWorkspaceRequest({ cwd: 'x'.repeat(5000), mode: 'shared' }),
      ValidationError
    )
  })
})

describe('git review payloads', () => {
  test('the side is one of three words, and nothing else', () => {
    for (const side of ['worktree', 'staged', 'branch']) {
      assert.equal(asDiffQuery({ sessionId: 'abc', side }).side, side)
    }
    for (const side of ['index', '', null, undefined, 'HEAD~1', { toString: () => 'staged' }]) {
      assert.throws(() => asDiffQuery({ sessionId: 'abc', side }), ValidationError, String(side))
    }
  })

  test('no request carries a directory — only a session that main can resolve', () => {
    const q = asDiffQuery({
      sessionId: 'abc',
      side: 'branch',
      file: 'src/app.ts',
      base: 'main',
      cwd: '/etc',
      dir: '/etc'
    })
    // Whatever else the renderer sent, the working directory is not its call.
    assert.deepEqual(Object.keys(q).sort(), ['base', 'file', 'sessionId', 'side', 'untracked'])
  })

  test('optional fields normalise to null rather than arriving as anything', () => {
    const q = asDiffQuery({ sessionId: 'abc', side: 'worktree' })
    assert.equal(q.file, null)
    assert.equal(q.base, null)
    assert.equal(q.untracked, false)
    // `untracked` is a flag, so only the literal true sets it.
    assert.equal(asDiffQuery({ sessionId: 'abc', side: 'worktree', untracked: 1 }).untracked, false)
    assert.throws(
      () => asDiffQuery({ sessionId: 'abc', side: 'worktree', file: 'x'.repeat(5000) }),
      ValidationError
    )
    assert.throws(() => asDiffQuery(null), ValidationError)
  })

  test('a stage batch is bounded, and every entry is a string', () => {
    const batch = asPathBatch({ sessionId: 'abc', paths: ['a.ts', 'b/c.ts'] })
    assert.deepEqual(batch.paths, ['a.ts', 'b/c.ts'])
    assert.deepEqual(asPathBatch({ sessionId: 'abc', paths: [] }).paths, [])

    assert.throws(
      () => asPathBatch({ sessionId: 'abc', paths: Array(501).fill('a.ts') }),
      /Too many files/
    )
    assert.throws(() => asPathBatch({ sessionId: 'abc', paths: 'a.ts' }), ValidationError)
    assert.throws(() => asPathBatch({ sessionId: 'abc', paths: [1] }), ValidationError)
    assert.throws(() => asPathBatch({ sessionId: 'abc' }), ValidationError)
  })
})
