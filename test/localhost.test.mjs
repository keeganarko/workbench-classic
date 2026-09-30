import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { findServerUrl, isLoopbackUrl, serverLabel } from '../src/shared/localhost.js'

describe('what may be loaded in the preview frame', () => {
  test('loopback names and the whole 127 block', () => {
    for (const url of [
      'http://localhost:5173',
      'https://localhost',
      'http://127.0.0.1:3000/app',
      'http://127.1.2.3:8080',
      'http://app.localhost:4000'
    ]) {
      assert.equal(isLoopbackUrl(url), true, url)
    }
  })

  test('anything that could be somewhere else is refused', () => {
    for (const url of [
      'http://192.168.1.10:5173',
      'http://example.test',
      'http://127.0.0.1.example.test',
      'http://1270.0.0.1',
      'http://notlocalhost',
      'http://localhost.example.test',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url'
    ]) {
      assert.equal(isLoopbackUrl(url), false, url)
    }
  })

  test('credentials in the URL are refused outright', () => {
    assert.equal(isLoopbackUrl('http://user:pass@localhost:3000'), false)
    // The host is what decides, and here it is not this machine.
    assert.equal(isLoopbackUrl('http://localhost@example.test'), false)
  })

  test('`[::1]` is refused, because the frame policy cannot name it', () => {
    // Loopback in fact, but `frame-src` has to list the same set this does,
    // and `findServerUrl` rewrites it to localhost rather than widen both.
    assert.equal(isLoopbackUrl('http://[::1]:4000'), false)
  })
})

describe('finding a server in terminal output', () => {
  test('reads Vite and ignores the LAN address beside it', () => {
    const out = '  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.168.1.5:5173/'
    assert.equal(findServerUrl(out), 'http://localhost:5173/')
  })

  test('rewrites the hosts that mean "here" but are unusable as written', () => {
    assert.equal(
      findServerUrl('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...'),
      'http://localhost:8000/'
    )
    assert.equal(findServerUrl('ready - started server on http://[::1]:4000'), 'http://localhost:4000')
  })

  test('drops punctuation that belongs to the sentence', () => {
    assert.equal(findServerUrl('see (http://127.0.0.1:3000).'), 'http://127.0.0.1:3000')
    assert.equal(findServerUrl('open "http://localhost:8080/x",'), 'http://localhost:8080/x')
  })

  test('the last one wins — a restarted server advertises the new port', () => {
    const out = 'Local: http://localhost:3000\nrestarting…\nLocal: http://localhost:3001'
    assert.equal(findServerUrl(out), 'http://localhost:3001')
  })

  test('a remote address in agent output is never a server we offer', () => {
    assert.equal(findServerUrl('deployed to https://example.test/app'), null)
    assert.equal(findServerUrl('http://10.0.0.4:8000 is up'), null)
  })

  test('nothing in the output is not an error', () => {
    assert.equal(findServerUrl(''), null)
    assert.equal(findServerUrl('npm run build\ndone in 1.2s'), null)
  })
})

describe('naming a server', () => {
  test('the port is the part that tells two servers apart', () => {
    assert.equal(serverLabel('http://localhost:5173/'), ':5173')
    assert.equal(serverLabel('http://127.0.0.1:8000'), ':8000')
  })

  test('falls back to the host when there is no port', () => {
    assert.equal(serverLabel('http://localhost/'), 'localhost')
    assert.equal(serverLabel('nonsense'), 'nonsense')
  })
})
