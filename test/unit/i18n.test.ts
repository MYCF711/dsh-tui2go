import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PERMISSION_MODE_IDS,
  dshGoLocale,
  effortLabel,
  labelProvenance,
  permissionModeCopy,
  type DshGoLocale,
} from '../../src/i18n.js'
import { permissionModes } from '../../src/modes.js'

test('locale accessor defaults to Chinese and only "en" switches language', () => {
  assert.equal(dshGoLocale(), 'zh')
  assert.equal(dshGoLocale(() => 'zh'), 'zh')
  assert.equal(dshGoLocale(() => 'en'), 'en')
  // A host that reports something unexpected must not silently half-translate.
  assert.equal(dshGoLocale(() => 'fr'), 'zh')
})

test('every permission mode has copy in both languages', () => {
  for (const id of PERMISSION_MODE_IDS) {
    for (const locale of ['zh', 'en'] as const) {
      const copy = permissionModeCopy(id, locale)
      assert.equal(typeof copy?.label, 'string', `${id}/${locale} label`)
      assert.equal(typeof copy?.description, 'string', `${id}/${locale} description`)
      assert.notEqual(copy?.label, '', `${id}/${locale} label is empty`)
    }
  }
  assert.equal(permissionModeCopy('nope', 'zh'), undefined)
})

test('mode copy mirrors the official 0.19 permission-preset keys', () => {
  assert.deepEqual(labelProvenance('mode', 'deny'), { key: 'permission-preset-readonly' })
  assert.deepEqual(labelProvenance('mode', 'ask'), { key: 'permission-preset-workspace-write' })
  assert.deepEqual(labelProvenance('mode', 'allow'), { key: 'permission-preset-full-access' })
  assert.deepEqual(labelProvenance('mode', 'auto'), { key: 'permission-preset-auto' })
})

test('the ask mode carries the official workspace-write wording in both languages', () => {
  assert.deepEqual(permissionModeCopy('ask', 'zh'), {
    label: '工作区读写',
    description: '工作区内读写；写入需先读该文件',
  })
  assert.deepEqual(permissionModeCopy('ask', 'en'), {
    label: 'Workspace read/write',
    description: 'Read/write inside the workspace; writes need a prior read',
  })
})

test('effort tiers mirror the official keys and `off` is marked derived', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const provenance = labelProvenance('effort', level)
    assert.equal(provenance.key, `effort-tier-${level}`)
    assert.equal(provenance.derived, undefined)
  }
  // 0.19 has no `effort-tier-off`: the text is DSH-GO's own and says so.
  assert.deepEqual(labelProvenance('effort', 'off'), { derived: true })
  assert.deepEqual(labelProvenance('effort', 'ultra'), {})
})

test('effort labels are localized and unknown levels stay their id', () => {
  assert.equal(effortLabel('off', 'zh'), '关闭')
  assert.equal(effortLabel('off', 'en'), 'Off')
  assert.equal(effortLabel('xhigh', 'zh'), '超高')
  assert.equal(effortLabel('xhigh', 'en'), 'Extra high')
  assert.equal(effortLabel('ultra', 'zh'), 'ultra')
})

test('mode options are rebuilt per call so a mid-session language switch lands', () => {
  let locale: DshGoLocale = 'zh'
  const read = (): DshGoLocale => locale
  // permissionModes is the pure seam the capability calls on every list().
  assert.deepEqual(permissionModes(dshGoLocale(read)).map(option => option.label),
    ['只读', '工作区读写', '完全访问', '自动授权审查'])
  locale = 'en'
  assert.deepEqual(permissionModes(dshGoLocale(read)).map(option => option.label),
    ['Read-only', 'Workspace read/write', 'Full access', 'Auto review'])
})
