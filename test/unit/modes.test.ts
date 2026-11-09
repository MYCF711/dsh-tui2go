import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionCapabilities } from '../../src/types/agent/capabilities.js'
import type { AgentEvent } from '../../src/types/agent/events.js'
import { createDshGoModes, permissionModes, type DshGoModesTransport } from '../../src/modes.js'

interface Call {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

function fixture(failure?: Error) {
  const calls: Call[] = []
  let current = 'ask'
  const transport: DshGoModesTransport = {
    async call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      if (method === 'session.load') return { permission: current } as T
      if (failure !== undefined) throw failure
      if (method === 'session.setPermission') current = params.permission as string
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
  assert.deepEqual(capability.list(), permissionModes('zh'))
  assert.equal(capability.cycle, undefined)
  assert.deepEqual(capability.list().map(option => option.id), ['deny', 'ask', 'allow', 'auto'])
  assert.deepEqual(capability.list().map(option => option.label), ['只读', '工作区读写', '完全访问', '自动授权审查'])
  assert.equal(capability.list().every(option => option.description !== undefined), true)
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
  assert.deepEqual(calls, [{ method: 'session.setPermission', params: { id: 'session-a', permission: 'auto' } }, { method: 'session.load', params: { id: 'session-a' } }])
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

test('mode copy is read from the host locale on every list(), not frozen at construction', () => {
  const { transport } = fixture()
  let locale = 'zh'
  const helper = createDshGoModes(transport, 'session-a', { locale: () => locale })
  assert.deepEqual(helper.capability.list().map(option => option.description), [
    '会话只读：不写文件、不执行命令',
    '工作区内读写；写入需先读该文件',
    '不受限读写，无需审批',
    '模型在每次工具调用前审查授权；无文件沙箱，仅当前会话',
  ])
  locale = 'en'
  assert.deepEqual(helper.capability.list().map(option => option.label),
    ['Read-only', 'Workspace read/write', 'Full access', 'Auto review'])
  // Switching text never touches the wire ids.
  assert.deepEqual(helper.capability.list().map(option => option.id), ['deny', 'ask', 'allow', 'auto'])
})
