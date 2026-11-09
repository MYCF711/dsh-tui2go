import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshGoWorkspacePort, DSH_GO_WORKSPACE_BRIDGE, installDshGoWorkspacePort, type DshGoWorkspaceTransport } from '../../src/workspace.js'

type Call = { method: string; params: Readonly<Record<string, unknown>> }

function fixture(result: unknown = {}) {
  const calls: Call[] = []
  const transport: DshGoWorkspaceTransport = {
    async call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      return result as T
    },
  }
  return { calls, transport }
}

test('workspace port maps every action to a real transport call', async () => {
  const { calls, transport } = fixture()
  const port = createDshGoWorkspacePort(transport, 'session-a')
  await port.list('/work')
  await port.listRegistry()
  await port.resolve('file:///work/a')
  await port.switch({ uri: 'file:///work/a', cwd: 'C:/work/a', label: 'a', kind: 'local', badge: 'local' })
  await port.renameAt('C:/work/a', 'A')
  await port.rename('A2')
  await port.remove('C:/work/a')
  await port.runCommand('remove', 'C:/work/a', 'C:/work')
  assert.deepEqual(calls.map(call => call.method), [
    'workspace.registry', 'workspace.registry', 'workspace.resolve', 'workspace.switch',
    'workspace.resolve', 'workspace.resolve', 'workspace.remove', 'workspace.remove',
  ])
  assert.deepEqual(calls[0].params, {})
  assert.deepEqual(calls[3].params, { path: 'C:/work/a' })
})

test('workspace port normalizes real target/registry/command results', async () => {
  const response: unknown = { workspaces: [
    { workspaceId: 'w', path: 'C:/w', title: 'W' },
    { workspaceId: '' },
  ] }
  const { transport } = fixture()
  const original = transport.call.bind(transport)
  transport.call = async <T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> => {
    if (method === 'workspace.registry') return { entries: [{ id: '1', path: 'C:/w', title: 'W', present: true, sessionCount: 2 }] } as T
    if (method === 'workspace.create') return { workspace: { workspaceId: 'w2', path: 'C:/w2', title: 'W2' } } as T
    return original(method, params)
  }
  // original closure still uses fixture's `response`? replace transport call entirely for list
  transport.call = async <T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> => {
    if (method === 'workspace.registry') return response as T
    if (method === 'workspace.registry') return { entries: [{ id: '1', path: 'C:/w', title: 'W', present: true, sessionCount: 2 }] } as T
    if (method === 'workspace.create') return { workspace: { workspaceId: 'w2', path: 'C:/w2', title: 'W2' } } as T
    return {} as T
  }
  const port = createDshGoWorkspacePort(transport, 's')
  const list = await port.list('C:/w')
  assert.deepEqual(list, [{ uri: 'workspace://w', cwd: 'C:/w', label: 'W', kind: 'local', badge: 'workspace' }])
  assert.deepEqual(await port.listRegistry(), [{ id: 'w', path: 'C:/w', title: 'W', present: true, sessionCount: 0 }])
  assert.equal((await port.runCommand('create', 'C:/w2', 'C:/w'))?.kind, 'target')
})

test('bridge install/clear is explicit and failure propagates', async () => {
  const port = createDshGoWorkspacePort(fixture().transport, 's')
  installDshGoWorkspacePort(port)
  assert.equal((globalThis as Record<string, unknown>)[DSH_GO_WORKSPACE_BRIDGE], port)
  installDshGoWorkspacePort(undefined)
  assert.equal((globalThis as Record<string, unknown>)[DSH_GO_WORKSPACE_BRIDGE], undefined)

  const failure = new Error('workspace registry unavailable')
  const failing: DshGoWorkspaceTransport = { call: async () => { throw failure } }
  await assert.rejects(createDshGoWorkspacePort(failing, 's').list(''), error => error === failure)
})

test('workspace commands parse host availability and never invent commands', async () => {
  const { transport } = fixture()
  const original = transport.call.bind(transport)
  transport.call = async <T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> => {
    if (method === 'workspace.commands') return { commands: [{ id: 'registry', title: '列出工作区', available: true }, { id: 'open-in-editor', title: '编辑器', available: false, reason: '无集成' }] } as T
    return original(method, params)
  }
  const port = createDshGoWorkspacePort(transport, 's')
  await port.refreshCommands()
  assert.deepEqual(port.commands().map(command => command.name), ['registry', 'open-in-editor'])
  assert.match(port.commands()[1].description, /不可用/)
  assert.deepEqual(createDshGoWorkspacePort(fixture().transport, 's').commands(), [])
})
