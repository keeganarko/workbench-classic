import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store, migrate, STORE_VERSION } from '../src/main/store.js'
import {
  MAX_PROJECT_STROKES, MAX_STROKE_POINTS, PROJECT_THEMES,
  defaultProjectAppearance, readProjectAppearance, validateProjectAppearance
} from '../src/shared/projectAppearance.js'
import { tempDir } from './helpers.mjs'

const sketch = () => ({ color: 'rose', artwork: 'sketch', strokes: [[[10, 20], [80.5, 90], [160, 160]], [[0, 0]]] })

test('every theme uses a supported color and illustration', () => {
  for (const theme of PROJECT_THEMES) {
    assert.deepEqual(validateProjectAppearance({ ...theme, strokes: [] }), {
      color: theme.color, artwork: theme.artwork, strokes: []
    })
  }
})

test('project designs and drawings survive restart, rename, and folder changes', () => {
  const dir = tempDir(), first = new Store(dir), drawing = sketch()
  const project = first.createSessionProject('Field notes', '/notes', drawing)
  const other = first.createSessionProject('Other work', '/other', { color: 'blue', artwork: 'waves', strokes: [] })
  first.renameSessionProject(project.id, 'Studio', '/studio')
  // Mutating a renderer-owned draft after saving must not alter the saved art.
  drawing.strokes[0][0][0] = 100
  first.saveNow()
  const second = new Store(dir)
  assert.deepEqual(second.sessionProjects.find((p) => p.id === project.id), {
    id: project.id, name: 'Studio', defaultCwd: '/studio', createdAt: project.createdAt, appearance: sketch()
  })
  assert.deepEqual(second.sessionProjects.find((p) => p.id === other.id).appearance, { color: 'blue', artwork: 'waves', strokes: [] })
  second.renameSessionProject(project.id, 'Studio', undefined, defaultProjectAppearance())
  second.saveNow()
  assert.deepEqual(new Store(dir).sessionProjects[0].appearance, defaultProjectAppearance())
})

test('invalid appearance cannot partially rename a project or create an extra project', () => {
  const store = new Store(tempDir()), project = store.createSessionProject('Original', '/original', sketch())
  assert.throws(() => store.renameSessionProject(project.id, 'Changed', '/changed', { ...sketch(), color: 'url(file:///private)' }))
  assert.equal(project.name, 'Original')
  assert.equal(project.defaultCwd, '/original')
  assert.deepEqual(project.appearance, sketch())
  assert.throws(() => store.createSessionProject('Invalid', '/invalid', { ...sketch(), strokes: 'svg markup' }))
  assert.equal(store.sessionProjects.length, 1)
  store.saveNow()
})

test('old and damaged designs keep their project identity and folder on migration', () => {
  const base = { name: 'Project', defaultCwd: '/work', createdAt: 123 }
  const { data } = migrate({ version: STORE_VERSION, sessionProjects: [
    { ...base, id: 'old' }, { ...base, id: 'damaged', appearance: { color: 'bad' } },
    { ...base, id: 'valid', appearance: sketch() }
  ] })
  assert.equal(data.sessionProjects.length, 3)
  assert.equal(data.sessionProjects[0].appearance, undefined)
  assert.deepEqual(data.sessionProjects[1], { ...base, id: 'damaged', appearance: defaultProjectAppearance() })
  assert.deepEqual(data.sessionProjects[2].appearance, sketch())
  assert.deepEqual(readProjectAppearance(undefined), defaultProjectAppearance())
})

test('drawings accept taps and bounded points but reject invalid or excessive payloads', () => {
  assert.deepEqual(validateProjectAppearance(sketch()), sketch())
  for (const strokes of [null, [[]], [[[NaN, 0]]], [[[Infinity, 0]]], [[[-1, 2]]], [[[161, 0]]],
    [[['2', 3]]], [[[0, 1, 2]]], Array.from({ length: MAX_PROJECT_STROKES + 1 }, () => [[0, 0]]),
    [Array.from({ length: MAX_STROKE_POINTS + 1 }, () => [0, 0])]]) {
    assert.throws(() => validateProjectAppearance({ ...sketch(), strokes }))
  }
  assert.throws(() => validateProjectAppearance({ ...sketch(), artwork: '<svg onload="alert(1)">' }))
})

test('switching artwork can retain a doodle for later and deleting a project removes its design', () => {
  const dir = tempDir(), store = new Store(dir), project = store.createSessionProject('Drawn', '/work', sketch())
  store.renameSessionProject(project.id, project.name, undefined, { ...sketch(), artwork: 'orbit' })
  store.saveNow()
  const restored = new Store(dir)
  assert.deepEqual(restored.sessionProjects[0].appearance.strokes, sketch().strokes)
  restored.removeSessionProject(project.id)
  restored.saveNow()
  assert.deepEqual(new Store(dir).sessionProjects, [])
})
