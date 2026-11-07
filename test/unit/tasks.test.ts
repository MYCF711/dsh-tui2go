import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionCapabilities } from '../../src/types/agent/capabilities.js'
import type { AgentEvent } from '../../src/types/agent/events.js'
import {
  createDshGoTasks,
  readDshGoJobOutputTail,
  type DshGoTasksTransport,
} from '../../src/tasks.js'
import type { ServerFrame } from '../../src/transport.js'

interface Call {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

type Handler = (method: string, params: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>

function fixture(handler: Handler) {
  const calls: Call[] = []
  const transport: DshGoTasksTransport = {
    async call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      return await handler(method, params) as T
    },
  }
  return { calls, transport }
}

const jobRow = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'job-a', sessionId: 'session-a', command: 'sleep 9', done: false, exit_code: 0, bytes: 0,
  ...patch,
})

const outputRow = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'job-a', sessionId: 'session-a', output: '', done: false, exit_code: 0,
  cursor: 0, nextCursor: 0, hasMore: false, total: 0,
  ...patch,
})

const frame = (type: string): ServerFrame => ({ seq: 1, type, data: {}, time: 1 })

test('empty jobs.list is an authoritative empty snapshot, not an error or fabricated row', async () => {
  const { calls, transport } = fixture(() => ({ jobs: [] }))
  const helper = createDshGoTasks(transport, 'session-a', { now: () => 10 })
  const batches: AgentEvent[][] = []
  helper.subscribe(events => { batches.push([...events]) })
  assert.deepEqual(await helper.refresh(), [{ type: 'tasks.snapshot', taskIds: [] }])
  assert.deepEqual(batches, [[{ type: 'tasks.snapshot', taskIds: [] }]])
  assert.deepEqual(await helper.refresh(), [])
  assert.deepEqual(calls, [
    { method: 'jobs.list', params: {} },
    { method: 'jobs.list', params: {} },
  ])
})

test('running and terminal rows produce real start/end status and live-only snapshots', async () => {
  let rows = [
    jobRow(),
    jobRow({ id: 'job-done', command: 'false', done: true, exit_code: 9 }),
  ]
  const { transport } = fixture(() => ({ jobs: rows }))
  const helper = createDshGoTasks(transport, 'session-a', { now: () => 20 })
  const first = await helper.refresh()
  assert.deepEqual(first, [
    { type: 'task.start', taskId: 'job-a', kind: 'shell', description: 'sleep 9', command: 'sleep 9', background: true, time: 20 },
    { type: 'task.start', taskId: 'job-done', kind: 'shell', description: 'false', command: 'false', background: true, time: 20 },
    { type: 'task.end', taskId: 'job-done', status: 'failed', summary: 'exit code: 9', time: 20 },
    { type: 'tasks.snapshot', taskIds: ['job-a'] },
  ])
  rows = [jobRow({ done: true }), jobRow({ id: 'job-done', command: 'false', done: true, exit_code: 9 })]
  assert.deepEqual(await helper.refresh(), [
    { type: 'task.end', taskId: 'job-a', status: 'completed', summary: 'exit code: 0', time: 20 },
    { type: 'tasks.snapshot', taskIds: [] },
  ])
})

test('A/B inventories never borrow or settle another session\'s jobs', async () => {
  let rows: Record<string, unknown>[] = [jobRow(), jobRow({ id: 'job-b', sessionId: 'session-b' })]
  const { calls, transport } = fixture((method, params) => {
    if (method === 'jobs.stop') return { ...params, stopped: true, done: true, exit_code: -1 }
    return { jobs: rows }
  })
  const helper = createDshGoTasks(transport, 'session-a', { now: () => 30 })
  await helper.refresh()
  rows = [jobRow({ id: 'job-b', sessionId: 'session-b' })]
  assert.deepEqual(await helper.refresh(), [], 'another session\'s list is not an empty A list')
  assert.equal(await helper.capability.stop('job-b'), false)
  assert.equal(await helper.capability.stop('job-a'), true)
  assert.deepEqual(calls.at(-1), { method: 'jobs.stop', params: { sessionId: 'session-a', id: 'job-a' } })
  rows = []
  assert.deepEqual(await helper.refresh(), [])
})

test('output tail uses rune pagination and preserves the truncation fact', async () => {
  const { calls, transport } = fixture((_method, params) => params.cursor === 0 && params.limit === 1
    ? outputRow({ output: 'A', nextCursor: 1, hasMore: true, total: 5, truncated: true })
    : outputRow({ output: '乙B', done: true, cursor: 3, nextCursor: 5, total: 5, truncated: true }))
  const page = await readDshGoJobOutputTail(transport, 'session-a', 'job-a', 2)
  assert.equal(page.output, '乙B')
  assert.equal(page.truncated, true)
  assert.equal(page.total, 5)
  assert.deepEqual(calls, [
    { method: 'jobs.output', params: { sessionId: 'session-a', id: 'job-a', cursor: 0, limit: 1 } },
    { method: 'jobs.output', params: { sessionId: 'session-a', id: 'job-a', cursor: 3, limit: 2 } },
  ])
})

test('one-rune output needs only the probe and capability readOutput returns real text', async () => {
  const { calls, transport } = fixture(() => outputRow({ output: '🙂', nextCursor: 1, total: 1 }))
  const helper = createDshGoTasks(transport, 'session-a')
  const capability: NonNullable<SessionCapabilities['tasks']> = helper.capability
  assert.equal(await capability.readOutput?.('job-a'), '🙂')
  assert.equal(calls.length, 1)
})

test('a moving output page and malformed pagination reject instead of returning a false tail', async () => {
  const moving = createDshGoTasks(fixture((_method, params) => params.limit === 1
    ? outputRow({ output: 'a', nextCursor: 1, hasMore: true, total: 100 })
    : outputRow({ output: 'bc', cursor: 98, nextCursor: 100, hasMore: true, total: 101 })).transport, 'session-a', { tailRunes: 2 })
  await assert.rejects(moving.readOutputTail('job-a'), /advanced beyond the requested tail/)

  const malformed = fixture(() => outputRow({ output: 'ab', nextCursor: 1, hasMore: true, total: 2 }))
  await assert.rejects(readDshGoJobOutputTail(malformed.transport, 'session-a', 'job-a'), /inconsistent rune page/)
})

test('jobs.stop requires a confirmed receipt, emits stopped and is idempotent locally', async () => {
  const { calls, transport } = fixture(method => method === 'jobs.stop'
    ? { id: 'job-a', sessionId: 'session-a', stopped: true, done: true, exit_code: -1 }
    : { jobs: [jobRow()] })
  const helper = createDshGoTasks(transport, 'session-a', { now: () => 40 })
  await helper.refresh()
  const events: AgentEvent[] = []
  helper.subscribe(batch => events.push(...batch))
  assert.equal(await helper.capability.stop('job-a'), true)
  assert.deepEqual(events, [
    { type: 'task.end', taskId: 'job-a', status: 'stopped', summary: 'exit code: -1', time: 40 },
    { type: 'tasks.snapshot', taskIds: [] },
  ])
  assert.equal(await helper.capability.stop('job-a'), false)
  assert.equal(calls.filter(call => call.method === 'jobs.stop').length, 1)
})

test('stop and list failures propagate unchanged without success events', async () => {
  const failure = new Error('host write failed')
  let failStop = false
  const { transport } = fixture(method => {
    if (method === 'jobs.stop' && failStop) throw failure
    return method === 'jobs.stop'
      ? { id: 'job-a', sessionId: 'session-a', stopped: true, done: true, exit_code: -1 }
      : { jobs: [jobRow()] }
  })
  const helper = createDshGoTasks(transport, 'session-a')
  await helper.refresh()
  const events: AgentEvent[] = []
  helper.subscribe(batch => events.push(...batch))
  failStop = true
  await assert.rejects(helper.capability.stop('job-a'), error => error === failure)
  assert.deepEqual(events, [])

  const broken = createDshGoTasks(fixture(() => { throw failure }).transport, 'session-a')
  await assert.rejects(broken.refresh(), error => error === failure)
})

test('malformed list rows and stop receipts never become partial success', async () => {
  for (const result of [null, {}, { jobs: null }, { jobs: [jobRow({ bytes: -1 })] }, { jobs: [jobRow({ sessionId: 3 })] }]) {
    const helper = createDshGoTasks(fixture(() => result).transport, 'session-a')
    await assert.rejects(helper.refresh(), /jobs\.list/)
  }
  const helper = createDshGoTasks(fixture(method => method === 'jobs.stop'
    ? { id: 'job-a', sessionId: 'session-a', stopped: false, done: false, exit_code: 0 }
    : { jobs: [jobRow()] }).transport, 'session-a')
  await helper.refresh()
  await assert.rejects(helper.capability.stop('job-a'), /did not confirm stopped=true and done=true/)
})

test('journal tool/turn frames trigger refresh; unrelated frames do not', async () => {
  const { calls, transport } = fixture(() => ({ jobs: [] }))
  const helper = createDshGoTasks(transport, 'session-a')
  assert.equal(await helper.acceptFrame(frame('tool/call')), false)
  assert.equal(await helper.acceptFrame(frame('assistant/message')), false)
  for (const type of ['tool/result', 'turn/end', 'turn/done', 'turn/error']) {
    assert.equal(await helper.acceptFrame(frame(type)), true)
  }
  assert.equal(calls.filter(call => call.method === 'jobs.list').length, 4)
})

test('changed output emits only proven appended task.output, including a sliding Unicode tail', async () => {
  let text = 'A甲🙂'
  let bytes = 3
  const { transport } = fixture((method, params) => {
    if (method === 'jobs.list') return { jobs: [jobRow({ bytes })] }
    const runes = Array.from(text)
    const cursor = params.cursor as number
    const limit = params.limit as number
    const output = runes.slice(cursor, cursor + limit).join('')
    const nextCursor = cursor + Array.from(output).length
    return outputRow({ output, cursor, nextCursor, hasMore: nextCursor < runes.length, total: runes.length })
  })
  const helper = createDshGoTasks(transport, 'session-a', { tailRunes: 4, now: () => 50 })
  const first = await helper.refresh()
  assert.deepEqual(first.filter(event => event.type === 'task.output'), [
    { type: 'task.output', taskId: 'job-a', text: 'A甲🙂', time: 50 },
  ])
  text = '甲🙂乙B'
  bytes = 4
  const second = await helper.refresh()
  assert.deepEqual(second.filter(event => event.type === 'task.output'), [
    { type: 'task.output', taskId: 'job-a', text: '乙B', time: 50 },
  ])
})

test('unsubscribe, reset and dispose suppress delivery and late in-flight results', async () => {
  let rows = [jobRow()]
  const { transport } = fixture(() => ({ jobs: rows }))
  const helper = createDshGoTasks(transport, 'session-a')
  const events: AgentEvent[] = []
  const unsubscribe = helper.subscribe(batch => events.push(...batch))
  unsubscribe()
  await helper.refresh()
  assert.equal(events.length, 0)
  helper.subscribe(batch => events.push(...batch))
  helper.reset()
  rows = []
  await helper.refresh()
  assert.deepEqual(events, [{ type: 'tasks.snapshot', taskIds: [] }])
  helper.dispose()
  assert.equal(await helper.acceptFrame(frame('tool/result')), false)
  assert.equal(await helper.capability.stop('job-a'), false)
  await assert.rejects(async () => { await helper.capability.readOutput?.('job-a') }, /disposed/)
  assert.deepEqual(await helper.refresh(), [])

  let resolveList!: (value: unknown) => void
  const pending = new Promise(resolve => { resolveList = resolve })
  const late = createDshGoTasks(fixture(() => pending).transport, 'session-a')
  const lateEvents: AgentEvent[] = []
  late.subscribe(batch => lateEvents.push(...batch))
  const refresh = late.refresh()
  late.dispose()
  resolveList({ jobs: [jobRow()] })
  assert.deepEqual(await refresh, [])
  assert.deepEqual(lateEvents, [])
})

test('invalid ids and tail bounds fail before RPC', async () => {
  const { calls, transport } = fixture(() => outputRow())
  await assert.rejects(readDshGoJobOutputTail(transport, '', 'job-a'), /requires sessionId and id/)
  await assert.rejects(readDshGoJobOutputTail(transport, 'session-a', 'job-a', 0), /tailRunes/)
  assert.throws(() => createDshGoTasks(transport, ''), /require a session id/)
  assert.throws(() => createDshGoTasks(transport, 'session-a', { tailRunes: 65_537 }), /tailRunes/)
  assert.deepEqual(calls, [])
})

test('a refresh batch publishes roster/lifecycle events before the output they describe', async () => {
  const text = 'A甲🙂'
  const { transport } = fixture((method, params) => {
    if (method === 'jobs.list') {
      return { jobs: [jobRow({ bytes: 3 }), jobRow({ id: 'job-done', command: 'false', done: true, exit_code: 9, bytes: 3 })] }
    }
    const id = params.id as string
    const runes = Array.from(text)
    const cursor = params.cursor as number
    const limit = params.limit as number
    const output = runes.slice(cursor, cursor + limit).join('')
    const nextCursor = cursor + Array.from(output).length
    return outputRow({
      id,
      output,
      cursor,
      nextCursor,
      hasMore: nextCursor < runes.length,
      total: runes.length,
      ...(id === 'job-done' ? { done: true, exit_code: 9 } : {}),
    })
  })
  const helper = createDshGoTasks(transport, 'session-a', { now: () => 60 })
  const events = await helper.refresh()
  assert.deepEqual(events.map(event => event.type), [
    'task.start', 'task.start', 'task.end', 'tasks.snapshot', 'task.output', 'task.output',
  ])
  // A consumer applying the batch in order must already know a task before its output arrives.
  const firstOutput = events.findIndex(event => event.type === 'task.output')
  assert.ok(firstOutput > 0)
  assert.deepEqual(events.slice(firstOutput).map(event => event.type), ['task.output', 'task.output'])
  assert.deepEqual(events.slice(0, firstOutput).map(event => (event as { taskId?: string }).taskId), [
    'job-a', 'job-done', 'job-done', undefined,
  ])
})
