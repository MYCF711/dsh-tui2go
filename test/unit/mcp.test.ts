import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshGoMcpCapability, listDshGoMcpServers, type DshGoMcpTransport } from '../../src/mcp.js'

interface Call { readonly method: string; readonly params: Readonly<Record<string, unknown>> }

function fixture(handler: (method: string, params: Readonly<Record<string, unknown>>) => unknown) {
  const calls: Call[] = []
  const transport: DshGoMcpTransport = {
    async call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      return handler(method, params) as T
    },
  }
  return { calls, transport }
}

test('mcp.list returns only real host rows and preserves empty', async () => {
  const { calls, transport } = fixture(() => ({ servers: [
    { name: 'docs', status: 'connected', toolCount: 4 },
    { name: 'local', status: 'needs-auth' },
  ] }))
  const capability = createDshGoMcpCapability(transport, 'session-a')
  assert.deepEqual(await capability.status(), [
    { name: 'docs', status: 'connected', toolCount: 4 },
    { name: 'local', status: 'needs-auth' },
  ])
  assert.deepEqual(calls, [{ method: 'mcp.list', params: { id: 'session-a' } }])
  const empty = fixture(() => ({ servers: [] }))
  assert.deepEqual(await listDshGoMcpServers(empty.transport, 'session-b'), [])
})

test('malformed mcp.list data is not replaced by an empty roster', async () => {
  for (const value of [null, {}, { servers: {} }, { servers: [{}] }, { servers: [{ name: 'x', status: 'connected', toolCount: -1 }] }]) {
    const { transport } = fixture(() => value)
    await assert.rejects(listDshGoMcpServers(transport, 'session-a'), /mcp\.list returned an invalid result/)
  }
})

test('reconnect and toggle use bare session/name params and require confirmation', async () => {
  const { calls, transport } = fixture(() => ({ ok: true }))
  const capability = createDshGoMcpCapability(transport, 'session-a')
  await capability.reconnect!('docs')
  await capability.toggle!('docs', false)
  await capability.toggle!('docs', true)
  assert.deepEqual(calls, [
    { method: 'mcp.reconnect', params: { id: 'session-a', name: 'docs' } },
    { method: 'mcp.toggle', params: { id: 'session-a', name: 'docs', enabled: false } },
    { method: 'mcp.toggle', params: { id: 'session-a', name: 'docs', enabled: true } },
  ])
})

test('MCP list and action errors propagate unchanged', async () => {
  const listFailure = new Error('list failed')
  const reconnectFailure = new Error('reconnect failed')
  const toggleFailure = new Error('toggle failed')
  const failures = [listFailure, reconnectFailure, toggleFailure]
  const { transport } = fixture(() => { throw failures.shift() })
  const capability = createDshGoMcpCapability(transport, 'session-a')
  await assert.rejects(capability.status(), error => error === listFailure)
  await assert.rejects(capability.reconnect!('docs'), error => error === reconnectFailure)
  await assert.rejects(capability.toggle!('docs', true), error => error === toggleFailure)
})

test('false or malformed mutation acknowledgements fail loudly', async () => {
  for (const response of [undefined, null, {}, { ok: false }, { ok: 'true' }]) {
    const { transport } = fixture(() => response)
    const capability = createDshGoMcpCapability(transport, 'session-a')
    await assert.rejects(capability.reconnect!('docs'), /mcp\.reconnect returned an invalid result/)
    await assert.rejects(capability.toggle!('docs', true), /mcp\.toggle returned an invalid result/)
  }
})

test('empty server names are rejected before transport', async () => {
  const { calls, transport } = fixture(() => ({ ok: true }))
  const capability = createDshGoMcpCapability(transport, 'session-a')
  await assert.rejects(capability.reconnect!(''), /requires a server name/)
  await assert.rejects(capability.toggle!('', true), /requires a server name/)
  assert.deepEqual(calls, [])
})

// ── T5C hardening (not in the 0.18 port) ────────────────────────────────────
// A server whose tools never got registered: the host sets ToolCount exactly
// when a live client exists (modules/tools/mcp.go Statuses), so a row claiming
// 'connected' without a tool count is the shape "connected but nothing
// registered". Reporting it as a healthy server is a silent success; it must
// fail loudly instead.

test('a connected row without a tool count never passes as registered tools', async () => {
  const { transport } = fixture(() => ({ servers: [{ name: 'docs', status: 'connected' }] }))
  await assert.rejects(
    listDshGoMcpServers(transport, 'session-a'),
    /mcp\.list returned an invalid result/,
  )
  const capability = createDshGoMcpCapability(transport, 'session-a')
  await assert.rejects(capability.status(), /mcp\.list returned an invalid result/)
})

test('a connected row with zero tools is still reported truthfully', async () => {
  const { transport } = fixture(() => ({ servers: [{ name: 'docs', status: 'connected', toolCount: 0 }] }))
  assert.deepEqual(await listDshGoMcpServers(transport, 'session-a'), [
    { name: 'docs', status: 'connected', toolCount: 0 },
  ])
})
