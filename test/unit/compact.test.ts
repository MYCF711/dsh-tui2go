import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionCapabilities } from '../../src/types/agent/capabilities.js'
import {
  createDshGoCompactCapability,
  runDshGoCompact,
  type DshGoCompactTransport,
} from '../../src/compact.js'

interface Call {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

function transportReturning(result: unknown, calls: Call[]): DshGoCompactTransport {
  return {
    async call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      return result as T
    },
  }
}

test('session.compact uses bare Go id/keep params and returns compacted=true intact', async () => {
  const response = { compacted: true, from: 12, to: 140, shadowed: 129, summaryChars: 880 }
  const calls: Call[] = []
  const result = await runDshGoCompact(transportReturning(response, calls), 'session-1', 4)
  assert.strictEqual(result, response)
  assert.deepEqual(calls, [{ method: 'session.compact', params: { id: 'session-1', keep: 4 } }])
})

test('compacted=false is a real result and the capability accepts it with default keep', async () => {
  const response = { compacted: false }
  const calls: Call[] = []
  const transport = transportReturning(response, calls)
  assert.strictEqual(await runDshGoCompact(transport, 'session-empty'), response)
  const capability: NonNullable<SessionCapabilities['compact']> = createDshGoCompactCapability(transport, 'session-empty')
  assert.equal(await capability.run(), undefined)
  assert.deepEqual(calls, [
    { method: 'session.compact', params: { id: 'session-empty', keep: 6 } },
    { method: 'session.compact', params: { id: 'session-empty', keep: 6 } },
  ])
})

test('compacted=true also completes through the capability adapter', async () => {
  const calls: Call[] = []
  const capability = createDshGoCompactCapability(
    transportReturning({ compacted: true, shadowed: 3 }, calls),
    'session-live',
    2,
  )
  await capability.run()
  assert.deepEqual(calls, [{ method: 'session.compact', params: { id: 'session-live', keep: 2 } }])
})

test('transport failures propagate unchanged through helper and capability', async () => {
  const failure = new Error('compaction write failed')
  let calls = 0
  const transport: DshGoCompactTransport = {
    async call<T = unknown>(): Promise<T> {
      calls++
      throw failure
    },
  }
  await assert.rejects(runDshGoCompact(transport, 'session-1'), error => error === failure)
  const capability = createDshGoCompactCapability(transport, 'session-1')
  await assert.rejects(capability.run(), error => error === failure)
  assert.equal(calls, 2)
})

test('malformed success envelopes are not reported as successful compaction', async () => {
  for (const response of [undefined, null, [], {}, { compacted: 'false' }]) {
    await assert.rejects(
      runDshGoCompact(transportReturning(response, []), 'session-1'),
      /dsh-go: session\.compact returned an invalid result/,
    )
  }
})
