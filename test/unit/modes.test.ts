import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionCapabilities } from '../../src/types/agent/capabilities.js'
import type { AgentEvent } from '../../src/types/agent/events.js'
import { createDshGoModes, DSH_GO_PERMISSION_MODES, type DshGoModesTransport } from '../../src/modes.js'

interface Call {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

function fixture(failure?: Error) {
  const calls: Call[] = []
  const transport: DshGoModesTransport = {
    async call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      if (failure !== undefined) throw failure
      return { ok: true } as T
    },
  }
  return { calls, transport }
}

test('permission modes expose list/current/cycle from session state', () => {
  const { transport } = fixture()
  const helper = createDshGoModes(transport, 'session-a')
  const capability: NonNullable<SessionCapabilities['modes']> = helper.capability
  assert.equal(capability.current(), '')
  helper.seed({ permission: 'ask' })
  assert.equal(capability.current(), 'ask')
  assert.deepEqual(capability.list(), DSH_GO_PERMISSION_MODES)
  assert.deepEqual(capability.cycle?.(), DSH_GO_PERMISSION_MODES)
  assert.deepEqual(capability.list().map(option => option.id), ['deny', 'ask', 'allow', 'auto'])
  assert.equal('respond' in capability, false)
  assert.equal('pending' in capability, false)
})

test('invalid mode is rejected before a Transport write', async () => {
  const { calls, transport } = fixture()
  const helper = createDshGoModes(transport, 'session-a')
  helper.seed({ permission: 'ask' })
  await assert.rejects(helper.capability.set('block'), /invalid permission mode/)
  assert.equal(helper.capability.current(), 'ask')
  assert.deepEqual(calls, [])
})

test('mode set uses session.setPermission, never session.approve', async () => {
  const { calls, transport } = fixture()
  const events: AgentEvent[] = []
  const helper = createDshGoModes(transport, 'session-a', { emit: batch => events.push(...batch) })
  await helper.capability.set('auto')
  assert.equal(helper.capability.current(), 'auto')
  assert.deepEqual(calls, [{ method: 'session.setPermission', params: { id: 'session-a', permission: 'auto' } }])
  assert.deepEqual(events, [{ type: 'mode.changed', modeId: 'auto' }])
})

test('mode persistence errors preserve current and emit nothing', async () => {
  const failure = new Error('permission store write failed')
  const { calls, transport } = fixture(failure)
  const events: AgentEvent[] = []
  const helper = createDshGoModes(transport, 'session-a', { emit: batch => events.push(...batch) })
  helper.seed({ permission: 'deny' })
  await assert.rejects(helper.capability.set('allow'), error => error === failure)
  assert.equal(helper.capability.current(), 'deny')
  assert.deepEqual(events, [])
  assert.deepEqual(calls, [{ method: 'session.setPermission', params: { id: 'session-a', permission: 'allow' } }])
})
