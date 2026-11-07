import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionCapabilities } from '../../src/types/agent/capabilities.js'
import type { AgentEvent } from '../../src/types/agent/events.js'
import { createDshGoSubagents } from '../../src/subagents.js'

const call = (callId = 'call-a', name = 'subagent'): AgentEvent => ({
  type: 'tool.call', seq: 1, turn: 1, step: 1, callId, name,
  argsJson: '{"description":"inspect the repo","prompt":"report findings"}', time: 100,
})

const result = (callId = 'call-a', isError = false): AgentEvent => ({
  type: 'tool.result', seq: 2, turn: 1, step: 1, callId, isError, time: 200,
  content: [{ type: 'text', text: isError ? 'child failed' : 'child done' }],
  text: isError ? 'child failed' : 'child done',
  ...(isError ? { errorText: 'child failed' } : {}),
})

test('synchronous subagent calls produce a real bounded start/end lifecycle', () => {
  const helper = createDshGoSubagents()
  const events: AgentEvent[] = []
  helper.subscribe(batch => events.push(...batch))
  assert.deepEqual(helper.acceptEvent(call()), [{
    type: 'subagent.start', agentId: 'call-a', parentCallId: 'call-a', description: 'inspect the repo',
    kind: 'subagent', background: false, depth: 1, time: 100,
  }])
  assert.deepEqual(helper.acceptEvent(result()), [{
    type: 'subagent.end', agentId: 'call-a', status: 'completed', summary: 'child done', time: 200,
  }])
  assert.equal(events.length, 2)
  const capability: NonNullable<SessionCapabilities['subagents']> = helper.capability
  assert.equal(capability.history, undefined)
  assert.equal(capability.messaging, undefined)
})

test('failed tool results and subagent_fork preserve their actual status and kind', () => {
  const helper = createDshGoSubagents()
  helper.acceptEvent(call('call-fork', 'subagent_fork'))
  assert.deepEqual(helper.acceptEvent(result('call-fork', true)), [{
    type: 'subagent.end', agentId: 'call-fork', status: 'failed', summary: 'child failed', time: 200,
  }])
  assert.deepEqual(helper.acceptEvent(call('call-fork', 'subagent_fork'))[0], {
    type: 'subagent.start', agentId: 'call-fork', parentCallId: 'call-fork', description: 'inspect the repo',
    kind: 'subagent_fork', background: false, depth: 1, time: 100,
  })
})

test('unrelated calls, duplicate delivery and malformed args do not invent child facts', () => {
  const helper = createDshGoSubagents()
  assert.deepEqual(helper.acceptEvent(call('call-other', 'bash')), [])
  assert.deepEqual(helper.acceptEvent(result('call-other')), [])
  const malformed = { ...call(), argsJson: '{not json' } as AgentEvent
  assert.deepEqual(helper.acceptEvent(malformed)[0], {
    type: 'subagent.start', agentId: 'call-a', parentCallId: 'call-a', description: 'subagent',
    kind: 'subagent', background: false, depth: 1, time: 100,
  })
  assert.deepEqual(helper.acceptEvent(malformed), [])
  assert.deepEqual(helper.acceptEvent(result()), [{
    type: 'subagent.end', agentId: 'call-a', status: 'completed', summary: 'child done', time: 200,
  }])
  assert.deepEqual(helper.acceptEvent(result()), [])
})

test('a late real result can close an inferred foreground subagent after turn.end', () => {
  const helper = createDshGoSubagents()
  helper.acceptEvent(call())
  assert.deepEqual(helper.acceptEvent({ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 150 }), [])
  assert.deepEqual(helper.acceptEvent(result()), [{
    type: 'subagent.end', agentId: 'call-a', status: 'completed', summary: 'child done', time: 200,
  }])
})

test('interrupt is explicitly unsupported and never cancels the parent or reports success', async () => {
  const helper = createDshGoSubagents()
  helper.acceptEvent(call())
  assert.equal(await helper.capability.interrupt('call-a'), false)
  assert.equal(await helper.capability.interrupt('missing'), false)
})

test('A/B helpers keep identical native call ids isolated', () => {
  const a = createDshGoSubagents()
  const b = createDshGoSubagents()
  assert.equal(a.acceptEvent(call()).length, 1)
  assert.equal(b.acceptEvent(call()).length, 1)
  assert.equal(a.acceptEvent(result()).length, 1)
  assert.deepEqual(b.acceptEvent(result()), [{
    type: 'subagent.end', agentId: 'call-a', status: 'completed', summary: 'child done', time: 200,
  }])
})

test('unsubscribe, reset and dispose suppress stale child events', () => {
  const helper = createDshGoSubagents()
  const events: AgentEvent[] = []
  const unsubscribe = helper.subscribe(batch => events.push(...batch))
  unsubscribe()
  helper.acceptEvent(call())
  assert.equal(events.length, 0)
  helper.subscribe(batch => events.push(...batch))
  helper.acceptEvent(result())
  assert.equal(events.length, 1)

  helper.acceptEvent(call('call-reset'))
  assert.equal(events.length, 2)
  helper.reset()
  assert.deepEqual(helper.acceptEvent(result('call-reset')), [])
  helper.acceptEvent(call('call-disposed'))
  assert.equal(events.length, 3)
  helper.dispose()
  assert.deepEqual(helper.acceptEvent(result('call-disposed')), [])
  assert.equal(events.length, 3)
  assert.equal(helper.subscribe(batch => events.push(...batch))(), undefined)
})

test('a disposed helper accepts no further events, even for a fresh call id', () => {
  const helper = createDshGoSubagents()
  const events: AgentEvent[] = []
  helper.subscribe(batch => events.push(...batch))
  helper.dispose()
  assert.deepEqual(helper.acceptEvent(call('call-after-dispose')), [])
  assert.deepEqual(helper.acceptEvent(result('call-after-dispose')), [])
  assert.equal(events.length, 0)
})
