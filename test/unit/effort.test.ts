import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionCapabilities } from '../../src/types/agent/capabilities.js'
import type { AgentEvent } from '../../src/types/agent/events.js'
import { createDshGoEffort, type DshGoEffortTransport } from '../../src/effort.js'

interface Call {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

function fixture(handler: (method: string, params: Readonly<Record<string, unknown>>) => unknown) {
  const calls: Call[] = []
  const transport: DshGoEffortTransport = {
    async call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      return handler(method, params) as T
    },
  }
  return { calls, transport }
}

const catalog = {
  revision: 3,
  models: [
    { id: 'model-a', reasoningEfforts: { off: null, low: 'low-wire', high: 'high-wire', max: 'max-wire' } },
    { id: 'model-empty', reasoningEfforts: false },
    { id: 'model-zero', reasoningEfforts: {} },
    { id: 'model-undeclared' },
  ],
}

test('effort reads the model catalog, current baseline and per-model preview', async () => {
  const { calls, transport } = fixture(() => catalog)
  const helper = createDshGoEffort(transport, 'session-a')
  const capability: NonNullable<SessionCapabilities['effort']> = helper.capability
  assert.equal(capability.levelsAvailable, false)
  assert.deepEqual(capability.levels(), [])
  await helper.refresh()
  helper.seed({ model: 'model-a', effort: 'low', effortSelection: 'high' })
  assert.equal(capability.levelsAvailable, true)
  assert.deepEqual(capability.levels(), [
    { id: 'off', label: 'off' }, { id: 'low', label: 'low' },
    { id: 'high', label: 'high' }, { id: 'max', label: 'max' },
  ])
  assert.equal(capability.current(), 'high')
  assert.deepEqual(capability.forModel?.({ model: 'model-a' }), {
    levels: capability.levels(), defaultEffort: undefined,
  })
  assert.deepEqual(capability.forModel?.({ model: 'missing' }), { levels: [], defaultEffort: undefined })
  assert.deepEqual(calls, [{ method: 'models.catalog.list', params: {} }])
})

test('a replacement baseline clears stale model and effort when fields are absent', async () => {
  const { transport } = fixture(() => catalog)
  const helper = createDshGoEffort(transport, 'session-a')
  await helper.refresh()
  helper.seed({ model: 'model-a', effort: 'high' })
  assert.notDeepEqual(helper.capability.levels(), [])
  helper.seed({})
  assert.deepEqual(helper.capability.levels(), [])
  assert.equal(helper.capability.current(), undefined)
})

test('explicit false, empty and undeclared effort ladders stay empty', async () => {
  const { transport } = fixture(() => catalog)
  const helper = createDshGoEffort(transport, 'session-a')
  await helper.refresh()
  for (const model of ['model-empty', 'model-zero', 'model-undeclared']) {
    helper.seed({ model, effort: 'high' })
    assert.deepEqual(helper.capability.levels(), [], model)
    assert.equal(helper.capability.levelsAvailable, true)
  }
  helper.seed({ model: 'model-empty' })
  await assert.rejects(helper.capability.set('low'), /invalid effort/)
})

test('invalid effort is rejected before persistence', async () => {
  const { calls, transport } = fixture(() => catalog)
  const helper = createDshGoEffort(transport, 'session-a')
  await helper.refresh()
  helper.seed({ model: 'model-a', effort: 'low' })
  await assert.rejects(helper.capability.set('medium'), /invalid effort/)
  assert.equal(helper.capability.current(), 'low')
  assert.deepEqual(calls.map(call => call.method), ['models.catalog.list'])
})

test('set persists first, then updates current and emits; null clears selection', async () => {
  const { calls, transport } = fixture(method => method === 'models.catalog.list' ? catalog : { ok: true })
  const events: AgentEvent[] = []
  const helper = createDshGoEffort(transport, 'session-a', { emit: batch => events.push(...batch) })
  await helper.refresh()
  helper.seed({ model: 'model-a', effort: 'low' })
  await helper.capability.set('max')
  assert.equal(helper.capability.current(), 'max')
  await helper.capability.set(null)
  assert.equal(helper.capability.current(), undefined)
  assert.deepEqual(calls.slice(1), [
    { method: 'session.setEffort', params: { id: 'session-a', effort: 'max' } },
    { method: 'session.setEffort', params: { id: 'session-a', effort: '' } },
  ])
  assert.deepEqual(events, [
    { type: 'effort.changed', effort: 'max' },
    { type: 'effort.changed', effort: null },
  ])
})

test('effort persistence errors propagate without state changes or events', async () => {
  const failure = new Error('effort store read-only')
  const { transport } = fixture(method => {
    if (method === 'session.setEffort') throw failure
    return catalog
  })
  const events: AgentEvent[] = []
  const helper = createDshGoEffort(transport, 'session-a', { emit: batch => events.push(...batch) })
  await helper.refresh()
  helper.seed({ model: 'model-a', effort: 'low' })
  await assert.rejects(helper.capability.set('high'), error => error === failure)
  assert.equal(helper.capability.current(), 'low')
  assert.deepEqual(events, [])
})

test('catalog failures never become a reliable empty ladder', async () => {
  const failure = new Error('catalog unavailable')
  const { transport } = fixture(() => { throw failure })
  const helper = createDshGoEffort(transport, 'session-a')
  await assert.rejects(helper.refresh(), error => error === failure)
  assert.equal(helper.capability.levelsAvailable, false)
  await assert.rejects(helper.capability.set('low'), /catalog is not loaded/)
})

// ── T5C hardening (not in the 0.18 port) ────────────────────────────────────
// The default effort tier: the model row's own declaration must reach
// forModel().defaultEffort, a missing declaration must stay undefined (never
// fabricated), and an illegal declaration must fail loudly instead of being
// silently dropped.

const defaultTierCatalog = {
  revision: 5,
  models: [
    { id: 'model-default', reasoningEfforts: { off: null, low: 'low-wire', high: 'high-wire' }, defaultReasoningEffort: 'high' },
    { id: 'model-nodefault', reasoningEfforts: { low: 'low-wire' } },
  ],
}

test('the declared default effort tier is surfaced, a missing one is never fabricated', async () => {
  const { calls, transport } = fixture(() => defaultTierCatalog)
  const helper = createDshGoEffort(transport, 'session-a')
  await helper.refresh()
  assert.deepEqual(helper.capability.forModel?.({ model: 'model-default' }), {
    levels: [{ id: 'off', label: 'off' }, { id: 'low', label: 'low' }, { id: 'high', label: 'high' }],
    defaultEffort: 'high',
  })
  assert.deepEqual(helper.capability.forModel?.({ model: 'model-nodefault' }), {
    levels: [{ id: 'low', label: 'low' }],
    defaultEffort: undefined,
  })
  // A real selection still wins over the declared default; the default is only
  // what the picker offers when nothing is selected.
  helper.seed({ model: 'model-default', effortSelection: 'low' })
  assert.equal(helper.capability.current(), 'low')
  assert.deepEqual(calls, [{ method: 'models.catalog.list', params: {} }])
})

test('an illegal default effort tier fails loudly and leaves the catalog unloaded', async () => {
  for (const defaultReasoningEffort of ['ultra', '', 42, null]) {
    const catalog = {
      models: [{ id: 'model-bad-default', reasoningEfforts: { low: 'low-wire' }, defaultReasoningEffort }],
    }
    const { calls, transport } = fixture(() => catalog)
    const helper = createDshGoEffort(transport, 'session-a')
    await assert.rejects(helper.refresh(), /default effort/, JSON.stringify(defaultReasoningEffort))
    assert.equal(helper.capability.levelsAvailable, false)
    assert.deepEqual(helper.capability.levels(), [])
    await assert.rejects(helper.capability.set('low'), /catalog is not loaded/)
    assert.deepEqual(calls, [{ method: 'models.catalog.list', params: {} }])
  }
})
