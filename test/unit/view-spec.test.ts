import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEventOf } from '../../src/types/agent/events.js'
import { createDshGoEventTranslator, type DshGoServerFrame } from '../../src/events.js'
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

import { dshGoLoadToolResult, dshGoViewSpecPresentation, withDshGoToolResultPresentation } from '../../src/view-spec.js'

const realToolFrame = goldenFrames.find((frame): frame is DshGoServerFrame => frame.type === 'tool/result')!
const realToolData = realToolFrame.data as Record<string, unknown>

function realResult(view: unknown, sessionId = 'session-a'): AgentEventOf<'tool.result'> {
  const translator = createDshGoEventTranslator({ sessionId })
  translator.translateLoad({ messages: [], total: 0, truncated: false, journalEpoch: 7, lastSeq: 5 })
  const translated = translator.translateFrame({ ...realToolFrame, data: { ...realToolData, ...(view === undefined ? {} : { view }) } })
  const events = withDshGoToolResultPresentation(translated, view)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, 'tool.result')
  return events[0] as AgentEventOf<'tool.result'>
}

test('ViewSpec card maps fields, badge and body to a real generic presentation', () => {
  assert.deepEqual(dshGoViewSpecPresentation({
    kind: 'card',
    title: 'Read result',
    badge: 'cached',
    fields: [{ key: 'path', value: 'a.ts' }, { key: 'lines', value: '2' }],
    body: 'body',
  }), {
    card: 'generic',
    title: 'Read result',
    content: [
      { type: 'text', text: 'cached' },
      { type: 'text', text: 'path: a.ts\nlines: 2' },
      { type: 'text', text: 'body' },
    ],
  })
})

test('ViewSpec table and plain use explicit lossless generic bodies', () => {
  const table = dshGoViewSpecPresentation({
    kind: 'table', title: 'Files', columns: ['path', 'line'], rows: [['a|b.ts', '7'], ['c.ts', '8']],
  })
  assert.deepEqual(table, {
    card: 'generic',
    title: 'Files',
    content: [{ type: 'text', text: '| path | line |\n| --- | --- |\n| a\\|b.ts | 7 |\n| c.ts | 8 |' }],
  })
  assert.deepEqual(dshGoViewSpecPresentation({ kind: 'plain', body: 'raw body' }), {
    card: 'generic', content: [{ type: 'text', text: 'raw body' }],
  })
})

test('real golden tool frame receives only its actual view; A/B and missing view keep raw fallback', () => {
  const presented = realResult(realToolData.view)
  assert.equal(presented.callId, 'call-a-1')
  assert.equal(presented.turn, 1)
  assert.equal(presented.step, 2)
  assert.equal(presented.text, '共 47 个 .go 文件')
  assert.equal(presented.presentation?.card, 'generic')
  assert.equal(presented.presentation?.title, undefined)
  const content = presented.presentation?.card === 'generic' ? presented.presentation.content : undefined
  assert.match(content?.[0]?.text ?? '', /\| path \|/u)

  const { view: _view, ...withoutView } = realToolData
  const rawFrame = { ...realToolFrame, data: withoutView }
  const translator = createDshGoEventTranslator({ sessionId: 'session-b' })
  translator.translateLoad({ messages: [], total: 0, truncated: false, journalEpoch: 11, lastSeq: 5 })
  const fallback = withDshGoToolResultPresentation(translator.translateFrame(rawFrame), withoutView.view)[0]
  assert.ok(fallback?.type === 'tool.result')
  assert.equal(fallback.text, '共 47 个 .go 文件')
  assert.equal('presentation' in fallback, false)
  assert.equal(dshGoViewSpecPresentation(undefined), undefined)
  assert.equal(dshGoViewSpecPresentation({ kind: 'invented', body: 'no' }), undefined)
  assert.equal(dshGoViewSpecPresentation({ kind: 'card', fields: {} }), undefined)
  assert.equal(dshGoViewSpecPresentation({ kind: 'table', rows: [{}] }), undefined)
})

test('load tool result restores real callId/turn/step and its view without inventing a tool call', () => {
  const event = dshGoLoadToolResult({
    seq: 88,
    role: 'tool',
    text: '共 47 个 .go 文件',
    tool: 'glob',
    args: '{"pattern":"**/*.go"}',
    callId: 'call-a-1',
    turn: 1,
    step: 2,
    time: 1793683941190,
    view: realToolData.view,
    meta: { cwd: '/workspace' },
  }, 9)
  assert.ok(event)
  assert.deepEqual({
    type: event.type, seq: event.seq, callId: event.callId, turn: event.turn, step: event.step,
    time: event.time, text: event.text, isError: event.isError, meta: event.meta,
  }, {
    type: 'tool.result', seq: 9, callId: 'call-a-1', turn: 1, step: 2,
    time: 1793683941190, text: '共 47 个 .go 文件', isError: false, meta: { cwd: '/workspace' },
  })
  assert.equal(event.presentation?.card, 'generic')
})

test('load never invents missing callId/turn/step', () => {
  const base = { seq: 88, role: 'tool', text: 'result', tool: 'glob', args: '{}', callId: 'call-a-1', turn: 1, step: 2 } as const
  assert.equal(dshGoLoadToolResult({ ...base, callId: undefined }, 1), undefined)
  assert.equal(dshGoLoadToolResult({ ...base, turn: undefined }, 1), undefined)
  assert.equal(dshGoLoadToolResult({ ...base, step: undefined }, 1), undefined)
  assert.equal(dshGoLoadToolResult({ ...base, role: 'assistant' }, 1), undefined)
  const legacy = dshGoLoadToolResult({ seq: 88, role: 'tool', text: 'result', view: { kind: 'plain', body: 'view' } }, 1)
  assert.equal(legacy, undefined)
})
