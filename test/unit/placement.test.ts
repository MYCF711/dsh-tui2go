import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent } from '../../src/types/agent/events.js'
import { createDshGoPlacement } from '../../src/placement.js'
import { DshGoTransportError, type ServerFrame } from '../../src/transport.js'

interface Call {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

function accepted(turnId: string): unknown {
  return { accepted: true, turnId }
}

function httpError(status: number, message: string): DshGoTransportError {
  return new DshGoTransportError(status, {}, { code: 'fixture', message, hint: '', retryable: false })
}

function harness(replies: readonly unknown[]) {
  const calls: Call[] = []
  const emitted: AgentEvent[][] = []
  const pending = [...replies]
  const placement = createDshGoPlacement({
    sessionId: 'A',
    call: async (method, params) => {
      calls.push({ method, params })
      const next = pending.shift()
      if (next === undefined) throw new Error(`unexpected ${method}`)
      if (next instanceof Error) throw next
      return next
    },
    emit: events => { emitted.push([...events]) },
  })
  return { calls, emitted, placement }
}

function frame(seq: number, type: string, data: unknown): ServerFrame {
  return { seq, type, data, time: seq }
}

function flat(batches: readonly (readonly AgentEvent[])[]): AgentEvent[] {
  return batches.flatMap(batch => [...batch])
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail('timed out waiting for async placement receipt')
}

test('submits real placements, keeps busy followups pending and claims them FIFO', async () => {
  const { calls, emitted, placement } = harness([accepted('turn-1'), accepted('turn-2'), accepted('turn-3')])
  assert.deepEqual(await placement.submit({ text: 'first', clientMessageId: 'client-1' }, 'turn'), { accepted: true })
  assert.deepEqual(await placement.submit({ text: 'second', clientMessageId: 'client-2' }, 'followup'), { accepted: true })
  assert.deepEqual(await placement.submit({
    text: '<bash-stdout>\nofficial !! output\n</bash-stdout>',
    clientMessageId: 'client-3',
    blocks: [{ type: 'text', text: '<bash-stdout>\nofficial !! output\n</bash-stdout>' }],
  }, 'followup'), { accepted: true })
  assert.deepEqual(calls.map(call => call.params), [
    { sessionId: 'A', text: 'first', placement: 'turn' },
    { sessionId: 'A', text: 'second', placement: 'followup' },
    { sessionId: 'A', content: [{ type: 'text', text: '<bash-stdout>\nofficial !! output\n</bash-stdout>' }], placement: 'followup' },
  ])
  assert.equal(flat(emitted).some(event => event.type === 'pending.changed' && event.items.some(item => item.id === 'client-2' && item.placement === 'followup')), true)

  assert.deepEqual(placement.observe(frame(1, 'turn/start', { turn: 1 })), [
    { type: 'pending.changed', items: [
      { id: 'client-2', text: 'second', placement: 'followup' },
      { id: 'client-3', text: '<bash-stdout>\nofficial !! output\n</bash-stdout>', placement: 'followup' },
    ], claimed: ['client-1'] },
  ])
  placement.observe(frame(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.deepEqual(placement.observe(frame(3, 'turn/start', { turn: 2 })).map(event => event.type === 'pending.changed' ? event.claimed : undefined), [['client-2']])
  assert.equal(flat(emitted).some(event => event.type === 'pending.changed' && event.claimed?.includes('client-3') === true), false)
  placement.observe(frame(4, 'turn/end', { turn: 2, reason: { kind: 'completed' } }))
  assert.deepEqual(placement.observe(frame(5, 'turn/start', { turn: 3 })).map(event => event.type === 'pending.changed' ? event.claimed : undefined), [['client-3']])
})

test('steer and now HTTP errors stay exact, unaccepted and out of the followup queue', async () => {
  for (const kind of ['steer', 'now'] as const) {
    const message = `${kind} failed exactly`
    const { calls, placement } = harness([accepted('turn-1'), httpError(kind === 'steer' ? 501 : 409, message)])
    await placement.submit({ text: 'running', clientMessageId: 'client-running' }, 'turn')
    const result = await placement.submit({ text: `try ${kind}`, clientMessageId: `client-${kind}` }, kind)
    assert.deepEqual(result, { accepted: false, reason: message, dropped: true })
    assert.deepEqual(calls.map(call => call.params.placement), ['turn', kind])
    assert.deepEqual(placement.close(), [{
      type: 'pending.changed', items: [], dropped: ['client-running'],
    }])
  }
})

test('cancel maps host turn ids to client ids and discards confirmed queue withdrawals', async () => {
  const { calls, emitted, placement } = harness([
    accepted('turn-1'), accepted('turn-2'), accepted('turn-3'),
    { cancelled: true, turnId: 'turn-1', stillQueued: ['turn-2', 'turn-3'], outcome: 'confirmed' },
    { cancelled: true, turnId: 'turn-1', cancelledQueued: ['turn-2', 'turn-3'], stillQueued: [], outcome: 'confirmed' },
  ])
  await placement.submit({ text: 'one', clientMessageId: 'client-1' }, 'turn')
  await placement.submit({ text: 'two', clientMessageId: 'client-2' }, 'followup')
  await placement.submit({ text: 'three', clientMessageId: 'client-3' }, 'followup')
  placement.observe(frame(1, 'turn/start', { turn: 1 }))
  assert.deepEqual(await placement.cancel('user'), { stillQueued: ['client-2', 'client-3'], outcome: 'confirmed' })
  assert.deepEqual(await placement.cancel('interrupt'), { stillQueued: [], outcome: 'confirmed' })
  assert.deepEqual(calls.filter(call => call.method === 'session.cancel').map(call => call.params), [
    { sessionId: 'A', cause: 'user' },
    { sessionId: 'A', cause: 'interrupt' },
  ])
  const retired = flat(emitted).flatMap(event => event.type === 'pending.changed' ? event.discarded ?? [] : [])
  assert.deepEqual(retired, ['client-2', 'client-3'])
})

test('legacy, failed and unmapped cancel receipts stay conservative', async () => {
  const { placement } = harness([
    accepted('turn-1'), accepted('turn-2'),
    { cancelled: true },
    httpError(409, 'cancel failed exactly'),
    { cancelled: true, stillQueued: ['turn-from-another-client'], outcome: 'confirmed' },
  ])
  await placement.submit({ text: 'one', clientMessageId: 'client-1' }, 'turn')
  await placement.submit({ text: 'two', clientMessageId: 'client-2' }, 'followup')
  placement.observe(frame(1, 'turn/start', { turn: 1 }))
  assert.deepEqual(await placement.cancel('user'), { stillQueued: ['client-2'], outcome: 'unknown' })
  assert.deepEqual(await placement.cancel('interrupt'), { stillQueued: ['client-2'], outcome: 'failed' })
  assert.deepEqual(await placement.cancel('user'), { stillQueued: ['client-2'], outcome: 'unknown' })
})

test('pending retraction uses targeted cancel and reports asynchronous failure', async () => {
  const { calls, emitted, placement } = harness([
    accepted('turn-1'), accepted('turn-2'), accepted('turn-3'),
    { cancelled: true, turnId: 'turn-2', cancelledQueued: ['turn-2'], stillQueued: ['turn-3'], outcome: 'confirmed' },
    httpError(409, 'retraction failed exactly'),
  ])
  await placement.submit({ text: 'one', clientMessageId: 'client-1' }, 'turn')
  await placement.submit({ text: 'two', clientMessageId: 'client-2' }, 'followup')
  await placement.submit({ text: 'three', clientMessageId: 'client-3' }, 'followup')
  assert.equal(placement.retract('client-1'), false)
  assert.equal(placement.retract('missing'), false)
  assert.equal(placement.retract('client-2'), true)
  await waitUntil(() => flat(emitted).some(event => event.type === 'pending.changed' && event.discarded?.includes('client-2') === true))
  assert.deepEqual(calls.at(-1), { method: 'session.cancel', params: { sessionId: 'A', cause: 'interrupt', turnId: 'turn-2' } })
  assert.equal(placement.retract('client-2'), false)
  assert.equal(placement.retract('client-3'), true)
  await waitUntil(() => flat(emitted).some(event => event.type === 'notice' && event.text === 'retraction failed exactly'))
  assert.equal(flat(emitted).some(event => event.type === 'pending.changed' && event.discarded?.includes('client-3') === true), false)
})

test('turn events before prompt ACK never resurrect a settled input', async () => {
  let release!: (value: unknown) => void
  const ack = new Promise(resolve => { release = resolve })
  const emitted: AgentEvent[][] = []
  const placement = createDshGoPlacement({
    sessionId: 'A',
    call: async () => ack,
    emit: events => { emitted.push([...events]) },
  })
  const submission = placement.submit({ text: 'early', clientMessageId: 'client-early' }, 'turn')
  placement.observe(frame(1, 'turn/start', { turn: 1 }))
  placement.observe(frame(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  release(accepted('turn-early'))
  assert.deepEqual(await submission, { accepted: true })
  assert.deepEqual(placement.close(), [])
  assert.equal(flat(emitted).some(event => event.type === 'pending.changed' && event.items.some(item => item.id === 'client-early')), false)
})

test('unsupported now preserves the old queue and contradictory cancel is not confirmed', async () => {
  const { emitted, placement } = harness([
    accepted('turn-1'), accepted('turn-2'), httpError(501, 'now unsupported exactly'),
    { cancelled: false, stillQueued: ['turn-2'], outcome: 'confirmed' },
  ])
  await placement.submit({ text: 'one', clientMessageId: 'client-1' }, 'turn')
  await placement.submit({ text: 'still queued', clientMessageId: 'client-2' }, 'followup')
  assert.deepEqual(await placement.submit({ text: 'urgent', clientMessageId: 'client-3' }, 'now'), {
    accepted: false, reason: 'now unsupported exactly', dropped: true,
  })
  assert.equal(flat(emitted).some(event => event.type === 'pending.changed' && event.discarded?.includes('client-2') === true), false)
  placement.observe(frame(1, 'turn/start', { turn: 1 }))
  assert.deepEqual(await placement.cancel('user'), { stillQueued: ['client-2'], outcome: 'unknown' })
})

test('accepted now uses the official drop-own queue path without optimistic steer fallback', async () => {
  const { calls, emitted, placement } = harness([accepted('turn-1'), accepted('turn-2'), accepted('turn-3')])
  await placement.submit({ text: 'one', clientMessageId: 'client-1' }, 'turn')
  await placement.submit({ text: 'old queued', clientMessageId: 'client-2' }, 'followup')
  assert.deepEqual(await placement.submit({ text: 'urgent', clientMessageId: 'client-3' }, 'now'), { accepted: true })
  assert.deepEqual(calls.map(call => call.params.placement), ['turn', 'followup', 'now'])
  assert.equal(flat(emitted).some(event => event.type === 'pending.changed' && event.discarded?.includes('client-2') === true), true)
  assert.deepEqual(placement.observe(frame(1, 'turn/start', { turn: 2 })).map(event => event.type === 'pending.changed' ? event.claimed : undefined), [['client-3']])
})

test('steer shares only the active host turn while followup and now keep independent turns', async () => {
  const { calls, emitted, placement } = harness([
    accepted('turn-1'), accepted('turn-2'), accepted('turn-1'), accepted('turn-3'), accepted('turn-4'),
  ])
  await placement.submit({ text: 'running', clientMessageId: 'client-running' }, 'turn')
  await placement.submit({ text: 'later', clientMessageId: 'client-followup' }, 'followup')
  placement.observe(frame(1, 'turn/start', { turn: 1 }))
  assert.deepEqual(await placement.submit({ text: 'next step', clientMessageId: 'client-steer' }, 'steer'), { accepted: true })
  assert.deepEqual(placement.observe(frame(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } })), [
    { type: 'pending.changed', items: [{ id: 'client-followup', text: 'later', placement: 'followup' }], claimed: ['client-steer'] },
  ])
  assert.deepEqual(placement.observe(frame(3, 'turn/done', { turnId: 'turn-1' })), [])
  assert.deepEqual(placement.observe(frame(4, 'turn/start', { turn: 1 })).map(event => event.type === 'pending.changed' ? event.claimed : undefined), [['client-followup']])
  placement.observe(frame(5, 'turn/done', { turnId: 'turn-2' }))

  await placement.submit({ text: 'interrupt me', clientMessageId: 'client-old-now' }, 'turn')
  placement.observe(frame(6, 'turn/start', { turn: 1 }))
  assert.deepEqual(await placement.submit({ text: 'immediate', clientMessageId: 'client-now' }, 'now'), { accepted: true })
  assert.deepEqual(placement.observe(frame(7, 'turn/error', { turnId: 'turn-3', error: 'interrupted' })), [])
  assert.deepEqual(placement.observe(frame(8, 'turn/start', { turn: 1 })).map(event => event.type === 'pending.changed' ? event.claimed : undefined), [['client-now']])
  placement.observe(frame(9, 'turn/done', { turnId: 'turn-4' }))
  assert.deepEqual(calls.map(call => call.params.placement), ['turn', 'followup', 'steer', 'turn', 'now'])
  assert.deepEqual(placement.close(), [])
  assert.equal(flat(emitted).some(event => event.type === 'pending.changed' && event.discarded?.includes('client-steer') === true), false)

  const stale = harness([accepted('turn-1'), accepted('turn-2'), accepted('turn-2')])
  await stale.placement.submit({ text: 'running', clientMessageId: 'client-running' }, 'turn')
  await stale.placement.submit({ text: 'queued', clientMessageId: 'client-queued' }, 'followup')
  await assert.rejects(
    stale.placement.submit({ text: 'wrong turn', clientMessageId: 'client-stale-steer' }, 'steer'),
    /session\.prompt reused a live turnId/u,
  )
})

/**
 * T5B red ② (taskbook §5.3 T5「先红」②) — the `clientMessageId` race: a
 * `turn/end` that arrives BEFORE the `session.prompt` ACK settles the entry
 * while it has no turn id yet. When the ACK finally lands it must retire that
 * entry completely (map + host-turn shadow), so a later cancel whose receipt
 * still names the dead host turn cannot drag the settled `clientMessageId`
 * back into the queue snapshot (`stillQueued`) the dock reads.
 */
test('a turn that ends before the prompt ACK never re-enters a later cancel snapshot', async () => {
  let release!: (value: unknown) => void
  const ack = new Promise(resolve => { release = resolve })
  const emitted: AgentEvent[][] = []
  const methods: string[] = []
  const placement = createDshGoPlacement({
    sessionId: 'A',
    call: async method => {
      methods.push(method)
      if (method === 'session.prompt') return ack
      if (method === 'session.cancel') {
        return { cancelled: true, turnId: 'turn-early', stillQueued: ['turn-early'], outcome: 'confirmed' }
      }
      throw new Error(`unexpected ${method}`)
    },
    emit: events => { emitted.push([...events]) },
  })

  const submission = placement.submit({ text: 'early', clientMessageId: 'client-early' }, 'turn')
  placement.observe(frame(1, 'turn/start', { turn: 1 }))
  placement.observe(frame(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  release(accepted('turn-early'))
  assert.deepEqual(await submission, { accepted: true })
  assert.deepEqual(methods, ['session.prompt'])

  // The host still names turn-early, but its client copy settled before the
  // ACK: the receipt must not resurrect `client-early` as a live queue row.
  const receipt = await placement.cancel('user')
  assert.equal(
    receipt.stillQueued.includes('client-early'),
    false,
    `a settled input must not re-enter the cancel snapshot: ${JSON.stringify(receipt)}`,
  )
  assert.deepEqual(receipt, { stillQueued: [], outcome: 'unknown' })
  assert.deepEqual(methods, ['session.prompt', 'session.cancel'])

  const changed = flat(emitted).filter(event => event.type === 'pending.changed')
  assert.equal(
    changed.some(event => event.type === 'pending.changed' && event.items.some(item => item.id === 'client-early')),
    false,
    'the settled input must never be listed as a pending row again',
  )
  assert.deepEqual(placement.close(), [], 'a settled input leaves nothing to drop on close')
})
