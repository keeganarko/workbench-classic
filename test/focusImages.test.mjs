import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Experience } from '../src/main/experience.js'
import { MAX_FOCUS_IMAGE_BYTES } from '../src/main/focusImages.js'
import { validateFocusUpdateInput, parseFocusUpdates } from '../src/shared/focusUpdate.js'
import { persistedSession, tempDir } from './helpers.mjs'

const first = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><text x="5" y="30">55 checks passed</text></svg>'
const second = first.replace('55 checks passed', 'Next verified result')
function harness() {
  const cwd = tempDir('focus-image-project-'), directory = tempDir('focus-image-store-')
  const session = persistedSession({ id: 'author', cwd, alive: true, sessionProjectId: 'project' })
  let updates = 0
  const deps = { directory, session: id => id === session.id ? session : undefined,
    project: id => id === 'project' ? { id, name: 'Workbench', defaultCwd: cwd } : undefined,
    changed: () => { updates++ }, launch: async () => { throw new Error('must not launch') } }
  const service = new Experience(deps)
  const file = path.join(cwd, 'preview-selection.svg')
  fs.writeFileSync(file, first)
  const publish = (image = file) => service.publishFocusUpdate('author', {
    kind: 'milestone', summary: 'Explicit document selection passed its regression checks.',
    visual: { kind: 'image', path: image, alt: 'The organization concept stays selected when a later handoff finishes.' }
  })
  return { cwd, directory, deps, service, file, publish, changes: () => updates }
}

test('each Focus image belongs to its report and survives source rewrites and app reload', () => {
  const h = harness()
  const a = h.publish('preview-selection.svg')
  fs.writeFileSync(h.file, second)
  const b = h.publish()
  assert.notEqual(a.visual.path, h.file)
  assert.notEqual(a.visual.path, b.visual.path)
  assert.equal(fs.readFileSync(a.visual.path, 'utf8'), first)
  assert.equal(fs.readFileSync(b.visual.path, 'utf8'), second)
  assert.equal(h.changes(), 2, 'distinct updates in one turn are pushed immediately, without a timer')
  assert.deepEqual(new Experience(h.deps).snapshot().focusUpdates, [b, a])
  assert.deepEqual(parseFocusUpdates([a]), [a])
})

test('image reports cannot read another project or escape through a sibling path', () => {
  const h = harness(), outside = path.join(h.directory, 'private.svg')
  fs.writeFileSync(outside, first)
  assert.throws(() => h.publish(outside), /reporting session/)
  assert.throws(() => h.publish(path.relative(h.cwd, outside)), /reporting session/)
  assert.deepEqual(h.service.snapshot().focusUpdates, [])
})

test('an image symlink cannot bring an outside file into the reporting project', t => {
  const h = harness(), outside = path.join(h.directory, 'private.svg'), link = path.join(h.cwd, 'linked.svg')
  fs.writeFileSync(outside, first)
  try { fs.symlinkSync(outside, link) } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows requires symlink privileges')
    throw error
  }
  assert.throws(() => h.publish(link), /reporting session/)
})

test('image paths and content reject remote embeds, false file types, missing descriptions and oversized files', () => {
  const h = harness()
  for (const visual of [
    { kind: 'image', path: 'https://example.com/chart.png', alt: 'Chart' },
    { kind: 'image', path: 'chart.html', alt: 'Chart' },
    { kind: 'image', path: 'chart.png' },
    { kind: 'image', path: 'chart.png', alt: '<img onerror="x">' },
    { kind: 'image', path: 'chart.png', alt: 'Chart', html: '<svg/>' },
    { kind: 'steps', path: 'chart.png', items: [{ label: 'Done', state: 'done' }] }
  ]) assert.throws(() => validateFocusUpdateInput({ kind: 'update', summary: 'Result', visual }))
  const fake = path.join(h.cwd, 'fake.png')
  fs.writeFileSync(fake, '<html>Not an image</html>')
  assert.throws(() => h.publish(fake), /content does not match/)
  const large = path.join(h.cwd, 'large.svg')
  fs.writeFileSync(large, first)
  fs.truncateSync(large, MAX_FOCUS_IMAGE_BYTES + 1)
  assert.throws(() => h.publish(large), /up to 4 MB/)
  assert.deepEqual(h.service.snapshot().focusUpdates, [])
})

test('failed report persistence leaves no image orphan and preserves the source', () => {
  const h = harness()
  fs.mkdirSync(path.join(h.directory, 'experience.json.tmp'))
  assert.throws(() => h.publish(), /not saved/)
  assert.equal(fs.readFileSync(h.file, 'utf8'), first)
  assert.deepEqual(fs.readdirSync(path.join(h.directory, 'focus-images')), [])
  assert.deepEqual(h.service.snapshot().focusUpdates, [])
})

test('retention removes only expired image copies, keeping project originals and unrelated files', () => {
  const h = harness()
  const oldest = h.publish()
  const unrelated = path.join(h.directory, 'focus-images', 'keep.svg')
  fs.writeFileSync(unrelated, first)
  for (let i = 0; i < 6; i++) h.publish()
  assert.equal(h.service.snapshot().focusUpdates.length, 6)
  assert.equal(fs.existsSync(oldest.visual.path), false)
  assert.equal(fs.readFileSync(h.file, 'utf8'), first)
  assert.equal(fs.readFileSync(unrelated, 'utf8'), first)
  assert.equal(fs.readdirSync(path.join(h.directory, 'focus-images')).length, 7)
})
