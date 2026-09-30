import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectIdentity } from '../src/shared/projectIdentity.js'

test('recognizable project names get matching symbols across naming styles', () => {
  for (const [name, symbol] of Object.entries({
    Workbench: 'tools', MBA: 'education', Voyager: 'compass', Website: 'globe',
    Finances: 'finance', 'Mission Control': 'radar', 'Mission-Control': 'radar',
    MissionControl: 'radar', 'Wispr Flow': 'voice', 'Research Lab': 'research',
    'Open Datasets': 'data', 'Code Tools': 'code'
  })) assert.equal(projectIdentity(name).symbol, symbol, name)
  assert.equal(projectIdentity('Metadata').symbol, null)
})

test('name-based identity is deterministic, normalized, and responds to renaming', () => {
  assert.deepEqual(projectIdentity(' Mission   Control '), projectIdentity('MISSION CONTROL'))
  assert.deepEqual(projectIdentity('cafe\u0301'), projectIdentity('café'))
  assert.deepEqual(projectIdentity('Ｆｉｎａｎｃｅｓ'), projectIdentity('Finances'))
  assert.notEqual(projectIdentity('Website').symbol, projectIdentity('Voyager').symbol)
  const before = projectIdentity('North Star')
  projectIdentity('Another project')
  assert.deepEqual(projectIdentity('North Star'), before)
})

test('unfamiliar, empty, and Unicode names produce bounded readable monograms', () => {
  for (const [name, initials] of Object.entries({
    'North Star': 'NS', 'Acme': 'AC', '東京': '東京', 'École': 'ÉC', '': 'P', '   ': 'P',
    '𐐨𐐩': '𐐀𐐁', '<>': 'P'
  })) {
    const mark = projectIdentity(name)
    assert.equal(mark.initials, initials, name)
    assert.ok(mark.frame >= 0 && mark.frame < 4)
    assert.ok(Array.from(mark.initials).length <= 2)
  }
})
