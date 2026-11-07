import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshGoContextCapability, dshGoContextSummary, dshGoContextUsageView, type DshGoContextTransport } from '../../src/context.js'

interface Call { readonly method: string; readonly params: Readonly<Record<string, unknown>> }

function fixture(handler: (method: string, params: Readonly<Record<string, unknown>>) => unknown) {
  const calls: Call[] = []
  const transport: DshGoContextTransport = {
    async call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      return handler(method, params) as T
    },
  }
  return { calls, transport }
}

test('summary uses real session.load counters and one aggregate used category', async () => {
  const { calls, transport } = fixture(() => ({ contextTokens: 1234, contextWindow: 64000 }))
  const capability = createDshGoContextCapability(transport, 'session-a')
  assert.deepEqual(await capability.usage('summary'), {
    used: 1234,
    max: 64000,
    categories: [{ name: 'context', tokens: 1234, kind: 'used' }],
  })
  assert.deepEqual(calls, [{ method: 'session.load', params: { id: 'session-a', tailMessages: 1 } }])
})

test('summary keeps zero used and treats zero window as unknown', () => {
  assert.deepEqual(dshGoContextSummary({ contextTokens: 0, contextWindow: 0 }), {
    used: 0,
    categories: [{ name: 'context', tokens: 0, kind: 'used' }],
  })
  assert.equal(dshGoContextSummary({ contextTokens: 8 }).max, undefined)
})

test('missing or malformed context measurements fail instead of becoming zero', async () => {
  for (const value of [undefined, null, {}, { contextTokens: '4' }, { contextTokens: -1 }, { contextTokens: 1.5 }, { contextTokens: 1, contextWindow: -1 }]) {
    assert.throws(() => dshGoContextSummary(value), /session\.load/)
  }
  const { transport } = fixture(() => ({}))
  await assert.rejects(createDshGoContextCapability(transport, 'session-a').usage('summary'), /no valid contextTokens/)
})

test('full usage preserves only host-provided categories and details', async () => {
  const response = {
    used: 50,
    max: 100,
    categories: [{ name: 'messages', tokens: 30, kind: 'used' }, { name: 'free', tokens: 50, kind: 'free' }],
    sections: [{ name: 'system', tokens: 5 }],
    files: [{ path: 'D:/work/AGENTS.md', tokens: 6 }],
    skills: [{ name: 'review', tokens: 4 }],
    tools: [{ name: 'read', tokens: 2 }, { name: 'remote', server: 'docs', tokens: 3 }],
  }
  const { calls, transport } = fixture(() => response)
  const usage = await createDshGoContextCapability(transport, 'session-a').usage('full')
  assert.deepEqual(usage, response)
  assert.notStrictEqual(usage.categories, response.categories)
  assert.deepEqual(calls, [{ method: 'context.usage', params: { id: 'session-a', detail: 'full' } }])
})

test('malformed full reports and absent detail arrays fail loudly', () => {
  for (const value of [null, {}, { used: 1 }, { used: -1, categories: [] }, { used: 1, max: 0, categories: [] },
    { used: 1, categories: [{}] }, { used: 1, categories: [], sections: {} },
    { used: 1, categories: [], files: [{ path: 'x', tokens: '1' }] },
    { used: 1, categories: [], tools: [{ name: 'x', tokens: 1, server: '' }] }]) {
    assert.throws(() => dshGoContextUsageView(value), /context\.usage/)
  }
})

test('context transport errors propagate unchanged', async () => {
  const failure = new Error('load failed')
  const { transport } = fixture(() => { throw failure })
  await assert.rejects(createDshGoContextCapability(transport, 'session-a').usage('summary'), error => error === failure)
})
