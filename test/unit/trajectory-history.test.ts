import assert from 'node:assert/strict'
import test from 'node:test'
import type { DshGoLoadMessage, DshGoServerFrame } from '../../src/events.js'
import { readDshGoRawTrajectoryHistory, readDshGoTranscriptPages } from '../../src/trajectory-history.js'
import type { SessionHistory } from '../../src/transport.js'
// Vendored from 0.18 src/backends/dsh-go/trajectory.test-fixture.ts (the fixture is not part of this bundle).
const goldenFrames: readonly DshGoServerFrame[] = [
  { seq: 1, type: 'turn/start', time: 1793683940001, data: { turn: 1 } },
  { seq: 2, type: 'user/message', time: 1793683940010, data: { content: [{ type: 'text', text: '用 glob 找一下 *.go 的数量' }], id: 'user-a-1', role: 'user', source: { kind: 'user' }, surfaceOp: 'append', v4Seq: 41, messageId: 'user-a-1' } },
  { seq: 3, type: 'assistant/message', time: 1793683941007, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '先看看目录里有什么，再数。' }] }, stream: [{ type: 'finish', reason: { kind: 'completed' } }], surfaceOp: 'append', usage: { inputTokens: 120, outputTokens: 14, totalTokens: 134 }, v4Seq: 42 } },
  { seq: 4, type: 'assistant/message', time: 1793683941101, data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '我用 glob 数一下。' }, { type: 'tool-call', id: 'call-a-1', name: 'glob', arguments: '{"pattern":"**/*.go"}' }] }, stream: [{ type: 'finish', reason: { kind: 'tool-calls' } }], surfaceOp: 'append', usage: { inputTokens: 134, outputTokens: 22, totalTokens: 156 }, v4Seq: 43 } },
  { seq: 5, type: 'tool/call', time: 1793683941110, data: { turn: 1, step: 2, name: 'glob', arguments: '{"pattern":"**/*.go"}', callId: 'call-a-1' } },
  { seq: 6, type: 'tool/result', time: 1793683941190, data: { turn: 1, step: 2, message: { role: 'tool', source: { kind: 'tool', callId: 'call-a-1' }, toolCallId: 'call-a-1', content: [{ type: 'text', text: '共 47 个 .go 文件' }], isError: false, id: 'tool-result-a-1' }, meta: { cwd: '/workspace' }, sourceEventSeqs: [], surfaceOp: 'append', view: { kind: 'table', columns: ['path'], rows: [['a.go']] } } },
  { seq: 7, type: 'approval/request', time: 1793683941200, data: { requestId: 'perm-a-timeout', sessionId: 'session-a', tool: 'bash', timeoutMs: 120000, deadlineMs: 1793684061200, toolCall: { toolCallId: 'perm-a-timeout', title: 'bash: rm -rf build/', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf build/' } }, options: [{ optionId: 'allow_once', name: '允许这一次', kind: 'allow_once' }, { optionId: 'allow_always', name: '这个会话里以后都允许', kind: 'allow_always' }, { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' }] } },
  { seq: 8, type: 'approval/timeout', time: 1793684061200, data: { requestId: 'perm-a-timeout', sessionId: 'session-a', tool: 'bash', timeoutMs: 120000, deadlineMs: 1793684061200, toolCall: { toolCallId: 'perm-a-timeout', title: 'bash: rm -rf build/', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf build/' } }, options: [{ optionId: 'allow_once', name: '允许这一次', kind: 'allow_once' }, { optionId: 'allow_always', name: '这个会话里以后都允许', kind: 'allow_always' }, { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' }] } },
  { seq: 9, type: 'turn/done', time: 1793684061300, data: { turnId: 'turn-a-1' } },
  { seq: 10, type: 'turn/start', time: 1793684062000, data: { turn: 2 } },
  { seq: 11, type: 'turn/error', time: 1793684062100, data: { turnId: 'turn-a-2', error: 'synthetic turn failure: boom' } },
  { seq: 0, type: 'pong', time: 1793684062200 },
  { seq: 0, type: 'session/reset', time: 1793684062300, data: { journalEpoch: 7, lastSeq: 11 } },
]


const message = (seq: number): DshGoLoadMessage => ({ seq, role: 'assistant', text: `m${seq}` })
const frame = (seq: number, type: string, data: unknown, time: number): DshGoServerFrame => ({ seq, type, data, time })
const history = (frames: readonly DshGoServerFrame[], lastSeq: number, journalEpoch = '7'): SessionHistory => ({ frames, lastSeq, journalEpoch })

test('W145 transcript.page preserves opaque cursors and returns pages as one oldest-first record', async () => {
  const calls: Record<string, unknown>[] = []
  const result = await readDshGoTranscriptPages({
    call: async (method, params) => {
      assert.equal(method, 'session.transcript.page')
      calls.push(params!)
      return calls.length === 1
        ? { messages: [message(8), message(9)], hasOlder: true, nextCursor: 'durable-A/+= opaque' }
        : { messages: [message(6), message(7)], hasOlder: false, nextCursor: 'stable-exhaustion-cursor' }
    },
  }, 'session-a', { limit: 2 })

  assert.deepEqual(calls, [
    { id: 'session-a', limit: 2 },
    { id: 'session-a', cursor: 'durable-A/+= opaque', limit: 2 },
  ])
  assert.equal(result.status, 'complete')
  assert.deepEqual(result.messages.map(row => row.seq), [6, 7, 8, 9])
  assert.deepEqual(result.pages.map(page => page.map(row => row.seq)), [[8, 9], [6, 7]])
  assert.equal(result.cursor, 'stable-exhaustion-cursor')
})

test('transcript.page rejects a non-advancing cursor and bounds partial aggregates honestly', async () => {
  await assert.rejects(() => readDshGoTranscriptPages({
    call: async () => ({ messages: [message(2)], hasOlder: true, nextCursor: 'same' }),
  }, 'session-a', { cursor: 'same' }), /advancing nextCursor/u)

  const bounded = await readDshGoTranscriptPages({
    call: async () => ({ messages: [message(3), message(4)], hasOlder: true, nextCursor: 'older' }),
  }, 'session-a', { maxMessages: 1 })
  assert.equal(bounded.status, 'degraded')
  assert.match(bounded.reason ?? '', /maxMessages=1/u)
  assert.deepEqual(bounded.messages.map(row => row.seq), [3, 4])
})

test('transcript.page A/B cursors and session identities never share state', async () => {
  const calls: Record<string, unknown>[] = []
  const transport = {
    call: async (_method: string, params?: Readonly<Record<string, unknown>>) => {
      calls.push(params!)
      return { messages: [], hasOlder: false }
    },
  }
  await readDshGoTranscriptPages(transport, 'session-a', { cursor: 'cursor-a' })
  await readDshGoTranscriptPages(transport, 'session-b')
  assert.deepEqual(calls, [
    { id: 'session-a', cursor: 'cursor-a', limit: 50 },
    { id: 'session-b', limit: 50 },
  ])
})

test('raw history pages replay real tool frames plus step/delta/TTFT and presentation', async () => {
  const toolCall = goldenFrames.find(frame => frame.type === 'tool/call')!
  const toolResult = goldenFrames.find(frame => frame.type === 'tool/result')!
  const raw: DshGoServerFrame[] = [
    frame(1, 'turn/start', { turn: 1 }, 50),
    frame(2, 'step/start', { turn: 1, step: 2 }, 100),
    frame(3, 'assistant/text', { turn: 1, step: 2, text: 'Hel' }, 150),
    frame(4, 'assistant/text', { turn: 1, step: 2, text: 'lo' }, 175),
    { ...toolCall, seq: 5 },
    { ...toolResult, seq: 6 },
    frame(7, 'step/end', { turn: 1, step: 2 }, 250),
    frame(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 300),
  ]
  const cursors: number[] = []
  const result = await readDshGoRawTrajectoryHistory({
    history: async (sessionId, sinceSeq, journalEpoch, limit) => {
      assert.equal(sessionId, 'session-a')
      assert.equal(journalEpoch, '7')
      assert.equal(limit, 3)
      cursors.push(sinceSeq)
      return sinceSeq === 0 ? history(raw.slice(0, 3), 8) : history(raw.slice(3), 8)
    },
  }, 'session-a', { journalEpoch: 7, limit: 3 })

  assert.equal(result.status, 'complete')
  assert.deepEqual(cursors, [0, 3])
  assert.deepEqual(result.cursor, { journalEpoch: 7, sinceSeq: 8 })
  assert.deepEqual(result.frames.map(row => row.seq), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(result.timings, [{
    turn: 1, step: 2, startTime: 100, firstTokenTime: 150, lastTokenTime: 175,
    endTime: 250, ttftMs: 50, decodeMs: 25,
  }])
  const call = result.events.find(event => event.type === 'tool.call')
  const settled = result.events.find(event => event.type === 'tool.result')
  assert.ok(call?.type === 'tool.call')
  assert.equal(call.callId, 'call-a-1')
  assert.ok(settled?.type === 'tool.result')
  assert.equal(settled.text, '共 47 个 .go 文件')
  assert.equal(settled.presentation?.card, 'generic')
  assert.deepEqual(result.events.filter(event => event.type === 'assistant.delta').map(event => event.delta), [
    { kind: 'text', text: 'Hel' }, { kind: 'text', text: 'lo' },
  ])
})

test('raw history gap, empty non-caught-up page and stale epoch are not complete empty history', async () => {
  const gap = await readDshGoRawTrajectoryHistory({
    history: async () => history([frame(2, 'assistant/text', { turn: 1, step: 1, text: 'lost' }, 2)], 2),
  }, 'session-a', { journalEpoch: 7 })
  assert.equal(gap.status, 'degraded')
  assert.match(gap.reason ?? '', /expected seq=1/u)
  assert.equal(gap.frames.length, 0)

  const empty = await readDshGoRawTrajectoryHistory({ history: async () => history([], 4) }, 'session-a', { journalEpoch: 7 })
  assert.equal(empty.status, 'degraded')
  assert.match(empty.reason ?? '', /empty page/u)

  const stale = await readDshGoRawTrajectoryHistory({ history: async () => history([], 0, '8') }, 'session-a', { journalEpoch: 7 })
  assert.equal(stale.status, 'degraded')
  assert.match(stale.reason ?? '', /stale_epoch/u)
  assert.equal(stale.frames.length, 0)
})

test('raw history transport errors and A/B cursors stay explicit and isolated', async () => {
  const failed = await readDshGoRawTrajectoryHistory({
    history: async () => { throw new Error('socket gone') },
  }, 'session-a', { journalEpoch: 7 })
  assert.equal(failed.status, 'error')
  assert.equal(failed.reason, 'socket gone')
  assert.equal(failed.frames.length, 0)

  const cursors: [string, number][] = []
  const transport = {
    history: async (sessionId: string, sinceSeq: number, journalEpoch: string) => {
      cursors.push([sessionId, sinceSeq])
      return history([], 0, journalEpoch)
    },
  }
  const a = await readDshGoRawTrajectoryHistory(transport, 'session-a', { journalEpoch: 7 })
  const b = await readDshGoRawTrajectoryHistory(transport, 'session-b', { journalEpoch: '9007199254740993' })
  assert.equal(a.status, 'complete')
  assert.equal(b.status, 'complete')
  assert.deepEqual(cursors, [['session-a', 0], ['session-b', 0]])
  assert.deepEqual(a.cursor, { journalEpoch: 7, sinceSeq: 0 })
  assert.deepEqual(b.cursor, { journalEpoch: '9007199254740993', sinceSeq: 0 })
})
