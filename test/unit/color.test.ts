import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent } from '../../src/types/agent/events.js'
import {
  createDshGoColor,
  dshGoColorChange,
  readDshGoColor,
  runDshGoColor,
  type DshGoColorTransport,
} from '../../src/color.js'

interface Call {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>> | undefined
}

function colorHost(initial: Readonly<Record<string, string>>) {
  const colors = new Map(Object.entries(initial))
  const calls: Call[] = []
  const transport: DshGoColorTransport = {
    async call<T = unknown>(method: string, params?: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      if (method === 'session.color.set') {
        colors.set(params!.id as string, params!.color as string)
        return { color: params!.color } as T
      }
      if (method === 'session.color.get') {
        const id = params!.id as string
        if (!colors.has(id)) throw new Error(`unknown session ${id}`)
        return { color: colors.get(id)! } as T
      }
      throw new Error(`unexpected method ${method}`)
    },
  }
  return { transport, calls, colors }
}

test('accent set/clear uses host readback, survives reopen and isolates A/B', async () => {
  const host = colorHost({ a: '', b: 'blue' })
  const events: AgentEvent[] = []
  const first = createDshGoColor(host.transport, 'a', { emit: batch => { events.push(...batch) } })
  assert.equal(await first.refresh(), '')
  assert.equal(first.seed(), undefined)
  first.capability.set('red')
  await first.idle()
  assert.equal(first.capability.current(), 'red')
  assert.deepEqual(first.seed(), { type: 'session.color', color: 'red' })
  assert.equal(host.colors.get('a'), 'red')
  assert.equal(host.colors.get('b'), 'blue')
  assert.deepEqual(events, [{ type: 'session.color', color: 'red' }])
  assert.deepEqual(first.capability.current(), 'red')
  assert.deepEqual(host.calls.slice(0, 3).map(call => call.method), ['session.color.get', 'session.color.set', 'session.color.get'])
  assert.deepEqual(host.calls[1]?.params, { id: 'a', color: 'red' })

  const reopened = createDshGoColor(host.transport, 'a')
  assert.equal(await reopened.refresh(), 'red')
  assert.deepEqual(reopened.seed(), { type: 'session.color', color: 'red' })
  const other = createDshGoColor(host.transport, 'b')
  assert.equal(await other.refresh(), 'blue')

  first.capability.set('')
  await first.idle()
  assert.equal(first.capability.current(), '')
  assert.equal(host.colors.get('a'), '')
  assert.deepEqual(events.at(-1), { type: 'session.color', color: '' })
  assert.equal(await reopened.refresh(), '')
  assert.equal(await other.refresh(), 'blue')
  first.dispose()
  reopened.dispose()
  other.dispose()
})

test('accent helper validates host reads and exact persistence', async () => {
  const host = colorHost({ a: 'green' })
  assert.equal(await readDshGoColor(host.transport, 'a'), 'green')
  assert.equal(await runDshGoColor(host.transport, 'a', 'purple'), 'purple')
  await assert.rejects(runDshGoColor(host.transport, '', 'red'), /requires a session id/)

  const mismatch: DshGoColorTransport = {
    async call<T = unknown>(method: string): Promise<T> {
      return (method === 'session.color.set' ? {} : { color: 'other' }) as T
    },
  }
  await assert.rejects(runDshGoColor(mismatch, 'a', 'wanted'), /readback mismatch.*"wanted".*"other"/)
  const malformed: DshGoColorTransport = { async call<T = unknown>(): Promise<T> { return {} as T } }
  await assert.rejects(readDshGoColor(malformed, 'a'), /returned no string color/)
})

test('asynchronous accent failure emits an error notice, never a local success', async () => {
  const failure = new Error('accent store is read-only')
  const transport: DshGoColorTransport = {
    async call<T = unknown>(): Promise<T> { throw failure },
  }
  const events: AgentEvent[] = []
  const controller = createDshGoColor(transport, 'a', { emit: batch => { events.push(...batch) } })
  controller.capability.set('red')
  await controller.idle()
  assert.equal(controller.capability.current(), '')
  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, 'notice')
  assert.match(events[0]?.type === 'notice' ? events[0].text : '', /accent store is read-only/)
  await assert.rejects(controller.refresh(), error => error === failure)
  controller.dispose()
})

test('accent subscriptions dedupe host echoes, forward changes and clean up', async () => {
  const host = colorHost({ a: '' })
  const events: AgentEvent[] = []
  const controller = createDshGoColor(host.transport, 'a', { emit: batch => { events.push(...batch) } })
  const received: unknown[] = []
  const unsubscribe = controller.subscribe(event => { received.push(event) })
  controller.capability.set('cyan')
  await controller.idle()
  assert.equal(received.length, 1)
  assert.equal(events.length, 1)
  assert.equal(controller.acceptFrame({ seq: 1, type: 'session/color', data: { color: 'cyan' } }), undefined)

  const external = controller.acceptFrame({ seq: 2, type: 'session/color', data: { color: 'pink' } })
  assert.deepEqual(external, { type: 'session.color', color: 'pink' })
  assert.equal(controller.capability.current(), 'pink')
  assert.equal(received.length, 2)
  assert.equal(events.length, 1, 'host frame is returned to the backend, not emitted twice')

  unsubscribe()
  assert.equal(controller.acceptFrame({ seq: 3, type: 'session/color', data: { color: 'blue' } })?.color, 'blue')
  assert.equal(received.length, 2)
  controller.dispose()
  assert.equal(controller.acceptFrame({ seq: 4, type: 'session/color', data: { color: 'red' } }), undefined)
  assert.throws(() => controller.capability.set('red'), /disposed/)
})

test('an early accent echo stays pending and readback mismatch emits only an error', async () => {
  let controller!: ReturnType<typeof createDshGoColor>
  const transport: DshGoColorTransport = {
    async call<T = unknown>(method: string): Promise<T> {
      if (method === 'session.color.set') {
        assert.equal(controller.acceptFrame({ seq: 1, type: 'session/color', data: { color: 'wanted' } }), undefined)
        return {} as T
      }
      return { color: 'different' } as T
    },
  }
  const events: AgentEvent[] = []
  const received: unknown[] = []
  controller = createDshGoColor(transport, 'a', { emit: batch => { events.push(...batch) } })
  controller.subscribe(event => { received.push(event) })
  controller.capability.set('wanted')
  await controller.idle()
  assert.deepEqual(received, [])
  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, 'notice')
  assert.match(events[0]?.type === 'notice' ? events[0].text : '', /readback mismatch/)
  assert.equal(controller.capability.current(), '')
  controller.dispose()
})

test('accent refresh is serialized with set and a host frame supersedes stale read I/O', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let getCalls = 0
  const transport: DshGoColorTransport = {
    async call<T = unknown>(method: string): Promise<T> {
      if (method === 'session.color.set') return {} as T
      getCalls++
      if (getCalls === 1) await gate
      return { color: getCalls === 1 ? 'old' : 'red' } as T
    },
  }
  const controller = createDshGoColor(transport, 'a', { emit: () => undefined })
  const refreshing = controller.refresh()
  controller.capability.set('red')
  await Promise.resolve()
  assert.equal(getCalls, 1)
  assert.deepEqual(controller.acceptFrame({ seq: 1, type: 'session/color', data: { color: 'external' } }), { type: 'session.color', color: 'external' })
  release()
  assert.equal(await refreshing, 'old')
  assert.equal(controller.capability.current(), 'external')
  await controller.idle()
  assert.equal(controller.capability.current(), 'red')
  assert.equal(getCalls, 2)
  controller.dispose()
})

test('accent set requires an error outlet and observer failures cannot poison the queue', async () => {
  const host = colorHost({ a: '' })
  const withoutEmitter = createDshGoColor(host.transport, 'a')
  assert.throws(() => withoutEmitter.capability.set('red'), /requires an event\/error emitter/)
  assert.deepEqual(host.calls, [])
  withoutEmitter.dispose()

  const events: AgentEvent[] = []
  const controller = createDshGoColor(host.transport, 'a', { emit: batch => { events.push(...batch); throw new Error('observer failed') } })
  controller.subscribe(() => { throw new Error('subscriber failed') })
  controller.capability.set('red')
  await controller.idle()
  controller.capability.set('blue')
  await controller.idle()
  assert.equal(host.colors.get('a'), 'blue')
  assert.equal(controller.capability.current(), 'blue')
  assert.deepEqual(events.map(event => event.type), ['session.color', 'session.color'])
  controller.dispose()
})

test('dispose during an asynchronous accent write suppresses late local events and cancels queued writes', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const transport: DshGoColorTransport = {
    async call<T = unknown>(method: string): Promise<T> {
      if (method === 'session.color.set') await gate
      return { color: 'red' } as T
    },
  }
  let setCalls = 0
  const countingTransport: DshGoColorTransport = {
    async call<T = unknown>(method: string): Promise<T> {
      if (method === 'session.color.set') setCalls++
      return transport.call(method, {})
    },
  }
  const events: AgentEvent[] = []
  const controller = createDshGoColor(countingTransport, 'a', { emit: batch => { events.push(...batch) } })
  controller.capability.set('red')
  await Promise.resolve()
  controller.capability.set('blue')
  controller.dispose()
  release()
  await controller.idle()
  assert.equal(setCalls, 1)
  assert.equal(controller.capability.current(), '')
  assert.deepEqual(events, [])
})

test('accent frame parser accepts only actual string color changes', () => {
  assert.equal(dshGoColorChange({ type: 'session/title', data: { color: 'red' } }), undefined)
  assert.equal(dshGoColorChange({ type: 'session/color', data: { color: 1 } }), undefined)
  assert.deepEqual(dshGoColorChange({ type: 'session/color', data: { color: '' } }), { type: 'session.color', color: '' })
})

/**
 * T5B red ③ (taskbook §5.3 T5「先红」③) — an accent change must be expressed
 * ONLY through the AgentEvent vocabulary: the returned/emitted value is the
 * `session.color` event itself, carrying exactly its own two fields. A raw
 * `ServerFrame` (seq/time/data riding along) or any extra carrier field is a
 * side channel the shared projector cannot read, and is a defect.
 */
const onlyAccentVocabulary = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object') return false
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const type = (value as { type?: unknown }).type
  if (type === 'session.color') return keys.join(',') === 'color,type'
  if (type === 'notice') return keys.join(',') === 'level,text,type'
  return false
}

test('accent changes reach the channel only as AgentEvent, never as a raw frame', async () => {
  const host = colorHost({ a: '' })
  const events: AgentEvent[] = []
  const controller = createDshGoColor(host.transport, 'a', { emit: batch => { events.push(...batch) } })
  const frames = [
    { seq: 1, type: 'session/color', data: { color: 'cyan' }, time: 11 },
    { seq: 2, type: 'session/color', data: { color: 'pink' }, time: 12 },
  ] as const

  // A host frame is delivered by the return value, and that value is the event.
  for (const frame of frames) {
    const returned = controller.acceptFrame(frame)
    assert.ok(returned !== undefined, 'a real host frame must be returned as an event')
    for (const carrier of ['seq', 'time', 'data']) {
      assert.equal(Object.hasOwn(returned, carrier), false, `the raw frame field ${carrier} must not ride along`)
    }
    assert.ok(onlyAccentVocabulary(returned), `not an AgentEvent vocabulary value: ${JSON.stringify(returned)}`)
  }
  assert.deepEqual(events, [], 'an accepted host frame is returned to the backend, never emitted as a side channel')

  // A deduped frame is expressed by returning nothing — no side-channel notice.
  assert.equal(controller.acceptFrame(frames[1]), undefined)
  assert.deepEqual(events, [])

  // A verified local write is the one thing that emits, and it emits the event.
  controller.capability.set('red')
  await controller.idle()
  assert.equal(events.length, 1)
  assert.ok(onlyAccentVocabulary(events[0]), `emitted value is not the event vocabulary: ${JSON.stringify(events[0])}`)
  assert.deepEqual(Object.keys(events[0] as object).sort(), ['color', 'type'])
  assert.equal((events[0] as { readonly color?: unknown }).color, 'red')
  assert.equal(controller.capability.current(), 'red')
  controller.dispose()
})
