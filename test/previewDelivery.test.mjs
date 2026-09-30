import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { newTab } from '../src/renderer/src/lib/layout.js'

// Exercise the real renderer funnel and store without a browser. Deferred IPC
// replies reproduce the races that a synchronous routing-only test cannot see.
let read
let build
const requests = []
globalThis.window = { term: {
  setPrefs: async () => {},
  previewWatch: async () => {},
  previewOpen: (path) => { requests.push(path); return read(path) },
  previewDocument: (input) => build(input),
  setTabs: async () => {}
} }
const { useStore } = await import('../src/renderer/src/state/store.js')
const { preview } = await import('../src/renderer/src/lib/preview.js')
const state = () => useStore.getState()
const concept = '/project/outputs-organization-concept.html'
const handoff = '/project/file-controls.md'
const doc = (path) => ({ path, name: path.split('/').pop(), kind: path.endsWith('.html') ? 'html' : 'markdown',
  mime: 'text/html', size: 10, mtimeMs: 1, url: 'wb-preview://f' + path, dirUrl: 'wb-preview://f/project/',
  text: '# Example', truncated: false })
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function focus(id) {
  const tab = newTab(id, id)
  useStore.setState({ tabs: [tab], activeTabId: tab.id })
  preview.followFocus(id)
}
beforeEach(() => {
  useStore.setState(useStore.getInitialState(), true)
  useStore.setState({ sessions: [{ id: 'a' }, { id: 'b' }], ready: true,
    prefs: { ...state().prefs, previewAutoShow: true, previewVisible: true } })
  focus('a')
  requests.length = 0
  read = async path => doc(path)
  build = async () => 'wb-preview://doc/rendered'
})

test('a named concept survives later automatic delivery and same-file refresh', async () => {
  await preview.showFor('a', concept)
  assert.equal(state().preview.auto, false)
  await preview.surface('a', doc(concept))
  await preview.surface('a', doc(handoff))
  assert.equal(state().preview.doc.path, concept)
  assert.equal(state().preview.auto, false)
  assert.ok(!requests.includes(handoff), 'the unrelated document should not even be read')
})

test('a pending explicit show protects the choice before the first read finishes', async () => {
  const slow = deferred()
  read = path => path === concept ? slow.promise : Promise.resolve(doc(path))
  const showing = preview.showFor('a', concept)
  await preview.surface('a', doc(handoff))
  assert.deepEqual(requests, [concept])
  slow.resolve(doc(concept))
  await showing
  assert.equal(state().preview.doc.path, concept)
})

test('a slow automatic Markdown render cannot overwrite a later explicit HTML show', async () => {
  const slow = deferred()
  build = () => slow.promise
  const automatic = preview.surface('a', doc(handoff))
  await Promise.resolve()
  await preview.showFor('a', concept)
  slow.resolve('wb-preview://doc/late-handoff')
  await automatic
  assert.equal(state().preview.doc.path, concept)
  assert.equal(state().preview.bySession.a.doc.path, concept)
})

test('the latest explicit choice wins even if the earlier read finishes last', async () => {
  const slow = deferred()
  read = path => path === handoff ? slow.promise : Promise.resolve(doc(path))
  const earlier = preview.showFor('a', handoff)
  await preview.showFor('a', concept)
  slow.resolve(doc(handoff))
  await earlier
  assert.equal(state().preview.doc.path, concept)
})

test('moving to another chat while a document loads keeps its ownership', async () => {
  const slow = deferred()
  read = () => slow.promise
  const showing = preview.showFor('a', concept)
  focus('b')
  slow.resolve(doc(concept))
  await showing
  assert.equal(state().preview.doc, null)
  assert.equal(state().preview.bySession.a.doc.path, concept)
  assert.equal(state().preview.bySession.a.seen, false)
  assert.equal(state().preview.bySession.b, undefined)
  focus('a')
  assert.equal(state().preview.doc.path, concept)
})

test('a background named document stays protected in its own slot', async () => {
  await preview.showFor('b', concept)
  await preview.surface('b', doc(handoff))
  assert.equal(state().preview.doc, null)
  assert.equal(state().preview.bySession.b.doc.path, concept)
  assert.equal(state().preview.bySession.b.auto, false)
})

test('closing a pending preview prevents it reopening when the read finishes', async () => {
  const slow = deferred()
  read = () => slow.promise
  const showing = preview.showFor('a', concept)
  preview.close()
  slow.resolve(doc(concept))
  await showing
  assert.equal(state().preview.doc, null)
  assert.equal(state().preview.loading, false)
  assert.equal(state().preview.bySession.a, undefined)
})

test('a direct user file choice wins over an in-flight automatic preview', async () => {
  const slow = deferred()
  read = path => path === handoff ? slow.promise : Promise.resolve(doc(path))
  const automatic = preview.surface('a', doc(handoff))
  await preview.open(concept)
  slow.resolve(doc(handoff))
  await automatic
  assert.equal(state().preview.doc.path, concept)
  assert.equal(state().preview.auto, false)
})

test('a user can open another project’s output from Focus without changing terminal focus', async () => {
  await preview.open(concept, { owner: 'b' })
  assert.equal(state().preview.doc.path, concept)
  assert.equal(state().preview.owner, 'b')
  assert.equal(state().preview.bySession.b.seen, true)
})

test('a newer user choice wins over a slow output opened from another project', async () => {
  const slow = deferred()
  read = path => path === handoff ? slow.promise : Promise.resolve(doc(path))
  const earlier = preview.open(handoff, { owner: 'b' })
  await preview.open(concept)
  slow.resolve(doc(handoff))
  await earlier
  assert.equal(state().preview.doc.path, concept)
  assert.equal(state().preview.bySession.b.doc.path, handoff)
  assert.equal(state().preview.bySession.b.seen, false)
})
