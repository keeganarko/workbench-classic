import { test } from 'node:test'
import assert from 'node:assert/strict'
import { performUpdateAction } from '../src/renderer/src/lib/updateActions.js'

const version = '1.0.3-beta.1'
const workspace = () => ({ composerDraft: 'Keep this unsent', composerSending: false, composerScope: 'pane', composerTargets: { codex: true }, experienceProjectId: 'atlas', tabs: [], activeTabId: null })
function harness() {
  const calls = [], state = workspace()
  let update = { version, status: 'available', installMode: 'restart' }
  const api = {
    checkForUpdates: async () => { calls.push('check') },
    downloadUpdate: async () => { calls.push('download'); update = { ...update, status: 'ready' } },
    getState: async () => ({ updates: update }),
    setTabs: async () => { calls.push('layout'); return true },
    installUpdate: async () => { calls.push('install') }
  }
  return { api, calls, state, update: () => update, setUpdate: value => { update = { version, ...value } }, checkpoint: () => calls.push('draft') }
}

test('one click saves layout and the latest draft before installing', async () => {
  const h = harness()
  h.api.downloadUpdate = async () => {
    h.calls.push('download'); h.state.composerDraft = 'Edited during download'
    h.setUpdate({ status: 'ready', installMode: 'restart' })
  }
  h.api.setTabs = async () => {
    h.calls.push('layout'); h.state.composerDraft = 'Edited while layout was saving'; return true
  }
  await performUpdateAction('download', h.api, () => h.state, state => {
    assert.equal(state.composerDraft, 'Edited while layout was saving'); h.calls.push('draft')
  })
  assert.deepEqual(h.calls, ['download', 'layout', 'draft', 'install'])
})

test('failed or corrupt download never starts installation or closes the app', async () => {
  const h = harness()
  h.api.downloadUpdate = async () => { h.setUpdate({ status: 'error', error: 'Verification failed' }) }
  await assert.rejects(() => performUpdateAction('download', h.api, () => h.state, h.checkpoint), /Verification failed/)
  assert.deepEqual(h.calls, [])
})

test('sending a prompt blocks restart before starting a download', async () => {
  const h = harness(); h.state.composerSending = true
  await assert.rejects(() => performUpdateAction('download', h.api, () => h.state, h.checkpoint), /prompt finishes sending/)
  assert.deepEqual(h.calls, [])
})

test('sending during download leaves the verified update ready for a later restart', async () => {
  const h = harness(), download = h.api.downloadUpdate
  h.api.downloadUpdate = async () => { await download(); h.state.composerSending = true }
  await assert.rejects(() => performUpdateAction('download', h.api, () => h.state, h.checkpoint), /prompt finishes sending/)
  assert.deepEqual(h.calls, ['download'])
  h.state.composerSending = false
  await performUpdateAction('install', h.api, () => h.state, h.checkpoint)
  assert.deepEqual(h.calls, ['download', 'layout', 'draft', 'install'])
})

test('sending during layout save postpones restart without checkpointing a sending draft', async () => {
  const h = harness(), saveLayout = h.api.setTabs
  h.api.setTabs = async () => { await saveLayout(); h.state.composerSending = true; return true }
  await assert.rejects(() => performUpdateAction('download', h.api, () => h.state, h.checkpoint), /prompt finishes sending/)
  assert.deepEqual(h.calls, ['download', 'layout'])
  h.state.composerSending = false; h.api.setTabs = saveLayout
  await performUpdateAction('install', h.api, () => h.state, h.checkpoint)
  assert.deepEqual(h.calls, ['download', 'layout', 'layout', 'draft', 'install'])
})

test('a changed version or installation mode cannot consume the original restart action', async () => {
  for (const change of [{ version: '1.0.3-beta.2' }, { installMode: 'manual' }]) {
    const h = harness()
    h.api.downloadUpdate = async () => {
      h.calls.push('download')
      // Mutating the same IPC object also must not change the captured target.
      Object.assign(h.update(), { status: 'ready', ...change })
    }
    await assert.rejects(() => performUpdateAction('download', h.api, () => h.state, h.checkpoint), /selected update changed/)
    assert.deepEqual(h.calls, ['download'])
  }
})

test('a manual download cannot silently become an automatic restart', async () => {
  const h = harness(); h.setUpdate({ status: 'available', installMode: 'manual' })
  h.api.downloadUpdate = async () => { h.setUpdate({ status: 'ready', installMode: 'restart' }) }
  await assert.rejects(() => performUpdateAction('download', h.api, () => h.state, h.checkpoint), /selected update changed/)
  assert.deepEqual(h.calls, [])
})

test('no selected release cannot start a download', async () => {
  const h = harness(); h.setUpdate({ version: null, status: 'current', installMode: 'restart' })
  await assert.rejects(() => performUpdateAction('download', h.api, () => h.state, h.checkpoint), /Check for updates/)
  assert.deepEqual(h.calls, [])
})

test('storage and layout errors abort installation before any app shutdown', async () => {
  for (const kind of ['draft', 'layout']) {
    const h = harness()
    const checkpoint = () => { if (kind === 'draft') throw new Error('disk full') }
    if (kind === 'layout') h.api.setTabs = async () => { throw new Error('disk full') }
    await assert.rejects(() => performUpdateAction('download', h.api, () => h.state, checkpoint), /disk full/)
    assert.ok(!h.calls.includes('install'))
  }
})

test('checks never download and manual installers keep their explicit handoff without restarting', async () => {
  const h = harness()
  await performUpdateAction('check', h.api, () => h.state, h.checkpoint)
  assert.deepEqual(h.calls, ['check'])
  h.state.composerSending = true
  h.setUpdate({ status: 'available', installMode: 'manual' })
  await performUpdateAction('download', h.api, () => h.state, h.checkpoint)
  assert.deepEqual(h.calls, ['check', 'download'])
  await performUpdateAction('install', h.api, () => h.state, h.checkpoint)
  assert.deepEqual(h.calls, ['check', 'download', 'install'])
})

test('a rejected layout save is not mistaken for a successful checkpoint', async () => {
  const h = harness(); h.api.setTabs = async () => false
  await assert.rejects(() => performUpdateAction('download', h.api, () => h.state, h.checkpoint), /could not save your layout/)
  assert.deepEqual(h.calls, ['download'])
})
