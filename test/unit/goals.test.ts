import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionCapabilities } from '../../src/types/agent/capabilities.js'
import type { AgentEventOf } from '../../src/types/agent/events.js'
import { createDshGoGoals, dshGoGoalChange, type DshGoGoalsTransport } from '../../src/goals.js'
import type { ServerFrame } from '../../src/transport.js'

interface Call {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

const goal = {
  id: 'goal-1', revision: 4, objective: 'finish the adapter', phase: 'active', maxGoalRounds: 8,
}

function frame(data: unknown, seq = 1): ServerFrame {
  return { seq, type: 'goal/change', data, time: 123 }
}

function fixture(handler: (method: string) => unknown = () => ({ ok: true })) {
  const calls: Call[] = []
  const transport: DshGoGoalsTransport = {
    async call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      return handler(method) as T
    },
  }
  return { calls, transport }
}

test('goal set/clear reuse session.setGoal; pause/resume use additive host methods', async () => {
  const { calls, transport } = fixture()
  const helper = createDshGoGoals(transport, 'session-a')
  const capability: NonNullable<SessionCapabilities['goals']> = helper.capability
  const events: AgentEventOf<'goal.change'>[] = []
  helper.subscribe(event => events.push(event))
  await capability.set('  ship the helper  ')
  await capability.pause()
  await capability.resume()
  await capability.clear()
  assert.deepEqual(calls, [
    { method: 'session.setGoal', params: { id: 'session-a', goal: '  ship the helper  ' } },
    { method: 'session.goal.pause', params: { id: 'session-a' } },
    { method: 'session.goal.resume', params: { id: 'session-a' } },
    { method: 'session.setGoal', params: { id: 'session-a', goal: '' } },
  ])
  assert.deepEqual(events, [], 'RPC success is not a fabricated goal.change')
})

test('goal get returns only authoritative snapshots and never emits change', async () => {
  const { transport } = fixture(() => ({ goal, roundsStarted: 2 }))
  const helper = createDshGoGoals(transport, 'session-a')
  const events: AgentEventOf<'goal.change'>[] = []
  helper.subscribe(event => events.push(event))
  assert.deepEqual(await helper.get(), { goal, roundsStarted: 2 })
  assert.deepEqual(events, [])
})

test('goal get maps null to no goal and rejects malformed snapshots', async () => {
  const empty = createDshGoGoals(fixture(() => ({ goal: null })).transport, 'session-a')
  assert.equal(await empty.get(), undefined)
  const malformed = createDshGoGoals(fixture(() => ({ goal: 'flat text is not a snapshot' })).transport, 'session-a')
  await assert.rejects(malformed.get(), /invalid goal snapshot/)
})

test('goal input and persistence failures do not manufacture events', async () => {
  const failure = new Error('goal store write failed')
  const { calls, transport } = fixture(method => {
    if (method === 'session.setGoal' || method === 'session.goal.pause') throw failure
    return { ok: true }
  })
  const helper = createDshGoGoals(transport, 'session-a')
  const events: AgentEventOf<'goal.change'>[] = []
  helper.subscribe(event => events.push(event))
  await assert.rejects(helper.capability.set(''), /objective is empty/)
  await assert.rejects(helper.capability.set('budgeted', { tokenBudget: 100 }), /token-budgeted goals are unsupported/)
  await assert.rejects(helper.capability.set('persist me'), error => error === failure)
  await assert.rejects(helper.capability.pause(), error => error === failure)
  assert.deepEqual(calls, [
    { method: 'session.setGoal', params: { id: 'session-a', goal: 'persist me' } },
    { method: 'session.goal.pause', params: { id: 'session-a' } },
  ])
  assert.deepEqual(events, [])
})

test('real goal/change frames notify subscribers; unsubscribe and dispose clean up', () => {
  const helper = createDshGoGoals(fixture().transport, 'session-a')
  const first: AgentEventOf<'goal.change'>[] = []
  const second: AgentEventOf<'goal.change'>[] = []
  const unsubscribe = helper.subscribe(event => first.push(event))
  helper.subscribe(event => second.push(event))
  const data = { kind: 'goal/change', version: 1, operation: 'create', goal, roundsStarted: 0 }
  const accepted = helper.acceptFrame(frame(data))
  assert.deepEqual(accepted, { type: 'goal.change', operation: 'create', goal, roundsStarted: 0 })
  assert.deepEqual(first, [accepted])
  assert.deepEqual(second, [accepted])

  unsubscribe()
  helper.acceptFrame(frame({ kind: 'goal/change', version: 1, operation: 'clear', goal: null }, 2))
  assert.equal(first.length, 1)
  assert.equal(second.length, 2)
  assert.deepEqual(second[1], { type: 'goal.change', operation: 'clear' })

  helper.dispose()
  assert.equal(helper.acceptFrame(frame(data, 3)), undefined)
  assert.equal(second.length, 2)
})

test('a real round change preserves the official round event without a snapshot', () => {
  assert.deepEqual(
    dshGoGoalChange(frame({ kind: 'goal/change', version: 1, operation: 'round', round: 3 })),
    { type: 'goal.change', operation: 'round', round: 3 },
  )
})

test('flat goal text, malformed changes and non-goal frames never become goal events', () => {
  const invalid = [
    frame({ kind: 'goal/change', version: 1, operation: 'create', goal: 'objective only' }),
    frame({ kind: 'goal/change', version: 1, operation: 'create', goal: { ...goal, revision: -1 } }),
    frame({ kind: 'goal/change', version: 1, operation: 'pause', goal: { ...goal, phase: 'blocked' } }),
    frame({ kind: 'goal/change', version: 1, operation: 'clear', goal }),
    frame({ kind: 'goal/change', version: 1, operation: '', goal }),
    { seq: 1, type: 'user/message', data: { kind: 'goal/change', version: 1, operation: 'create', goal } },
  ]
  for (const candidate of invalid) assert.equal(dshGoGoalChange(candidate), undefined)
})
