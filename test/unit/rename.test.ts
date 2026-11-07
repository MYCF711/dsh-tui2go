import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent } from '../../src/types/agent/events.js'
import {
  createDshGoRename,
  dshGoTitleChange,
  dshGoTitleFromList,
  readDshGoTitle,
  runDshGoRename,
  type DshGoRenameTransport,
} from '../../src/rename.js'

interface Call {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>> | undefined
}

function titleHost(initial: Readonly<Record<string, string>>) {
  const titles = new Map(Object.entries(initial))
  const calls: Call[] = []
  const transport: DshGoRenameTransport = {
    async call<T = unknown>(method: string, params?: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      if (method === 'session.rename') {
        titles.set(params!.id as string, params!.title as string)
        return { title: params!.title } as T
      }
      if (method === 'session.list') {
        return {
          sessions: [...titles].map(([id, title]) => ({ id, title, titleExplicit: true, titleSource: 'user', cwd: '/work', updatedAt: '2026-11-06T00:00:00Z' })),
        } as T
      }
      throw new Error(`unexpected method ${method}`)
    },
  }
  return { transport, calls, titles }
}

test('title lookup uses the canonical session.list row', async () => {
  const host = titleHost({ a: 'title A', b: 'title B' })
  assert.equal(await readDshGoTitle(host.transport, 'a'), 'title A')
  assert.deepEqual(host.calls, [{ method: 'session.list', params: {} }])
  assert.equal(dshGoTitleFromList({ sessions: [{ id: 'a', title: '' }] }, 'a'), '')
  assert.throws(() => dshGoTitleFromList({}, 'a'), /no sessions array/)
  assert.throws(() => dshGoTitleFromList({ sessions: [] }, 'a'), /returned 0 rows/)
  assert.throws(() => dshGoTitleFromList({ sessions: [{ id: 'a' }] }, 'a'), /no string title/)
})

test('rename preserves a long exact title, survives controller reopen and isolates A/B', async () => {
  const host = titleHost({ a: 'old A', b: 'old B' })
  const events: AgentEvent[] = []
  const first = createDshGoRename(host.transport, 'a', { emit: batch => { events.push(...batch) } })
  assert.equal(await first.refresh(), 'old A')
  assert.deepEqual(first.seed(), { type: 'session.title', title: 'old A', source: 'user' })
  const longTitle = `  ${'长标题🐳-'.repeat(700)}  `
  await first.capability.rename(longTitle)
  assert.equal(first.current(), longTitle)
  assert.equal(host.titles.get('a'), longTitle)
  assert.equal(host.titles.get('b'), 'old B')
  assert.deepEqual(events, [{ type: 'session.title', title: longTitle, source: 'user' }])
  assert.deepEqual(host.calls.slice(0, 3).map(call => call.method), ['session.list', 'session.rename', 'session.list'])
  assert.deepEqual(host.calls[1]?.params, { id: 'a', title: longTitle })

  const reopened = createDshGoRename(host.transport, 'a')
  assert.equal(await reopened.refresh(), longTitle)
  assert.deepEqual(reopened.seed(), { type: 'session.title', title: longTitle, source: 'user' })
  const other = createDshGoRename(host.transport, 'b')
  assert.equal(await other.refresh(), 'old B')
  first.dispose()
  reopened.dispose()
  other.dispose()
})

test('empty or whitespace titles fail before any mutation', async () => {
  const host = titleHost({ a: 'kept' })
  const controller = createDshGoRename(host.transport, 'a')
  for (const title of ['', ' ', '\n\t']) {
    await assert.rejects(runDshGoRename(host.transport, 'a', title), /title must not be empty/)
    await assert.rejects(controller.capability.rename(title), /title must not be empty/)
  }
  await assert.rejects(runDshGoRename(host.transport, '', 'title'), /requires a session id/)
  assert.deepEqual(host.calls, [])
  assert.equal(host.titles.get('a'), 'kept')
  controller.dispose()
})

test('readback mismatch and malformed list never emit a successful title change', async () => {
  const transport: DshGoRenameTransport = {
    async call<T = unknown>(method: string): Promise<T> {
      if (method === 'session.rename') return {} as T
      return { sessions: [{ id: 'a', title: 'different' }] } as T
    },
  }
  const events: AgentEvent[] = []
  const controller = createDshGoRename(transport, 'a', { emit: batch => { events.push(...batch) } })
  await assert.rejects(controller.capability.rename('wanted'), /readback mismatch.*"wanted".*"different"/)
  assert.deepEqual(events, [])
  assert.equal(controller.current(), undefined)
  controller.dispose()
})

test('title transport errors propagate unchanged without a readback or event', async () => {
  const failure = new Error('title disk write failed')
  let calls = 0
  const transport: DshGoRenameTransport = {
    async call<T = unknown>(): Promise<T> { calls++; throw failure },
  }
  const events: AgentEvent[] = []
  const controller = createDshGoRename(transport, 'a', { emit: batch => { events.push(...batch) } })
  await assert.rejects(controller.capability.rename('next'), error => error === failure)
  assert.equal(calls, 1)
  assert.deepEqual(events, [])
  controller.dispose()
})

test('title change subscription handles host source shapes, dedupes echoes and cleans up', async () => {
  const host = titleHost({ a: 'old' })
  const events: AgentEvent[] = []
  const controller = createDshGoRename(host.transport, 'a', { emit: batch => { events.push(...batch) } })
  await controller.refresh()
  const received: unknown[] = []
  const unsubscribe = controller.subscribe(event => { received.push(event) })
  await controller.capability.rename('local')
  assert.equal(received.length, 1)
  assert.equal(events.length, 1)

  const echo = { seq: 1, type: 'session/title', data: { title: 'local', source: { kind: 'user' } } }
  assert.equal(controller.acceptFrame(echo), undefined)
  assert.equal(received.length, 1)
  const external = controller.acceptFrame({ seq: 2, type: 'session/title', data: { title: 'external', source: { kind: 'auto' } } })
  assert.deepEqual(external, { type: 'session.title', title: 'external', source: 'auto' })
  assert.equal(received.length, 2)
  assert.equal(events.length, 1, 'host frame is returned to the backend, not emitted twice')

  unsubscribe()
  assert.equal(controller.acceptFrame({ seq: 3, type: 'session/title', data: { title: 'after-unsubscribe', source: 'user' } })?.title, 'after-unsubscribe')
  assert.equal(received.length, 2)
  controller.dispose()
  assert.equal(controller.acceptFrame({ seq: 4, type: 'session/title', data: { title: 'disposed', source: 'user' } }), undefined)
  assert.equal(controller.current(), 'after-unsubscribe')
  await assert.rejects(controller.capability.rename('no'), /disposed/)
})

test('an early local WS echo stays pending and is dropped when readback fails', async () => {
  let controller!: ReturnType<typeof createDshGoRename>
  const transport: DshGoRenameTransport = {
    async call<T = unknown>(method: string): Promise<T> {
      if (method === 'session.rename') {
        const early = controller.acceptFrame({ seq: 1, type: 'session/title', data: { title: 'wanted', source: { kind: 'user' } } })
        assert.equal(early, undefined)
        return {} as T
      }
      return { sessions: [{ id: 'a', title: 'different', titleExplicit: true, titleSource: 'user' }] } as T
    },
  }
  const events: AgentEvent[] = []
  const received: unknown[] = []
  controller = createDshGoRename(transport, 'a', { emit: batch => { events.push(...batch) } })
  controller.subscribe(event => { received.push(event) })
  await assert.rejects(controller.capability.rename('wanted'), /readback mismatch/)
  assert.deepEqual(events, [])
  assert.deepEqual(received, [])
  assert.equal(controller.current(), undefined)
  controller.dispose()
})

test('refresh is serialized with rename and a host change supersedes stale refresh I/O', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let listCalls = 0
  const transport: DshGoRenameTransport = {
    async call<T = unknown>(method: string): Promise<T> {
      if (method === 'session.rename') return {} as T
      listCalls++
      if (listCalls === 1) await gate
      const title = listCalls === 1 ? 'old' : 'renamed'
      return { sessions: [{ id: 'a', title, titleExplicit: true, titleSource: 'user' }] } as T
    },
  }
  const controller = createDshGoRename(transport, 'a')
  const refreshing = controller.refresh()
  const renaming = controller.capability.rename('renamed')
  await Promise.resolve()
  assert.equal(listCalls, 1)
  const external = controller.acceptFrame({ seq: 1, type: 'session/title', data: { title: 'external', source: 'auto' } })
  assert.equal(external?.title, 'external')
  release()
  assert.equal(await refreshing, 'old')
  assert.equal(controller.current(), 'external', 'stale refresh must not overwrite the host frame')
  await renaming
  assert.equal(controller.current(), 'renamed')
  assert.deepEqual(listCalls, 2)
  controller.dispose()
})

test('fallback titles never become a user/auto seed', async () => {
  const transport: DshGoRenameTransport = {
    async call<T = unknown>(): Promise<T> {
      return { sessions: [{ id: 'a', title: '(无标题)' }] } as T
    },
  }
  const controller = createDshGoRename(transport, 'a')
  assert.equal(await controller.refresh(), '(无标题)')
  assert.equal(controller.seed(), undefined)
  controller.dispose()
})

test('dispose waits through idle but suppresses a late rename event and cancels queued writes', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const transport: DshGoRenameTransport = {
    async call<T = unknown>(method: string): Promise<T> {
      if (method === 'session.rename') await gate
      return { sessions: [{ id: 'a', title: 'persisted', titleExplicit: true, titleSource: 'user' }] } as T
    },
  }
  const events: AgentEvent[] = []
  let renameCalls = 0
  const countingTransport: DshGoRenameTransport = {
    async call<T = unknown>(method: string): Promise<T> {
      if (method === 'session.rename') renameCalls++
      return transport.call(method, {})
    },
  }
  const queuedController = createDshGoRename(countingTransport, 'a', { emit: batch => { events.push(...batch) } })
  const pending = queuedController.capability.rename('persisted')
  await Promise.resolve()
  const queued = queuedController.capability.rename('must-not-write')
  const rejected = assert.rejects(queued, /disposed/)
  queuedController.dispose()
  release()
  await pending
  await rejected
  await queuedController.idle()
  assert.equal(renameCalls, 1)
  assert.deepEqual(events, [])
  assert.equal(queuedController.current(), undefined)
})

test('title frame parser rejects unrelated and malformed changes', () => {
  assert.equal(dshGoTitleChange({ type: 'session/color', data: { title: 'x', source: 'user' } }), undefined)
  assert.equal(dshGoTitleChange({ type: 'session/title', data: { title: 1, source: 'user' } }), undefined)
  assert.equal(dshGoTitleChange({ type: 'session/title', data: { title: 'x' } }), undefined)
  assert.deepEqual(
    dshGoTitleChange({ type: 'session/title', data: { title: '', source: 'auto' } }),
    { type: 'session.title', title: '', source: 'auto' },
  )
})

/**
 * T5B red ③ (taskbook §5.3 T5「先红」③) — a title change must be expressed
 * ONLY through the AgentEvent vocabulary. The backend's only outbound channel
 * for a host title frame is the returned `session.title` event (exact fields);
 * returning the `ServerFrame` itself, or emitting a frame-shaped carrier, is a
 * side channel the projector cannot read.
 */
const onlyTitleVocabulary = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object') return false
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return (value as { type?: unknown }).type === 'session.title' && keys.join(',') === 'source,title,type'
}

test('title changes reach the channel only as AgentEvent, never as a raw frame', async () => {
  const host = titleHost({ a: 'old' })
  const events: AgentEvent[] = []
  const controller = createDshGoRename(host.transport, 'a', { emit: batch => { events.push(...batch) } })
  await controller.refresh()

  // A real host frame comes back as the event itself, with no frame carrier.
  const external = controller.acceptFrame({ seq: 2, type: 'session/title', data: { title: 'external', source: { kind: 'auto' } } })
  assert.ok(external !== undefined, 'a real host title frame must be returned as an event')
  for (const carrier of ['seq', 'time', 'data']) {
    assert.equal(Object.hasOwn(external, carrier), false, `the raw frame field ${carrier} must not ride along`)
  }
  assert.ok(onlyTitleVocabulary(external), `not an AgentEvent vocabulary value: ${JSON.stringify(external)}`)
  assert.deepEqual(events, [], 'an accepted host frame is returned to the backend, never emitted as a side channel')

  // A deduped echo is expressed by returning nothing — no side-channel notice.
  assert.equal(controller.acceptFrame({ seq: 3, type: 'session/title', data: { title: 'external', source: 'auto' } }), undefined)
  assert.deepEqual(events, [])

  // A verified local rename emits exactly one event, in the same vocabulary.
  await controller.capability.rename('local')
  assert.equal(events.length, 1, `expected exactly one emitted title event, got ${JSON.stringify(events)}`)
  assert.ok(onlyTitleVocabulary(events[0]), `emitted value is not the event vocabulary: ${JSON.stringify(events[0])}`)
  assert.deepEqual(Object.keys(events[0] as object).sort(), ['source', 'title', 'type'])
  assert.deepEqual(events[0], { type: 'session.title', title: 'local', source: 'user' })
  controller.dispose()
})
