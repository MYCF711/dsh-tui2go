import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent, AgentEventOf, AgentEventType } from '../../src/types/agent/events.js'
import {
  createDshGoEventTranslator,
  dshGoSideQueryFrame,
  dshGoSideQueryResult,
  NO_EVENTS,
  type DshGoJournalEpoch,
  type DshGoLoadResult,
  type DshGoServerFrame,
} from '../../src/events.js'

const frame = (seq: number, type: string, data?: unknown, time = 1793683940000): DshGoServerFrame => ({ seq, type, data, time })

const emptyLoad = (journalEpoch: DshGoJournalEpoch, lastSeq: number): DshGoLoadResult => ({
  messages: [],
  total: 0,
  truncated: false,
  journalEpoch,
  lastSeq,
})

const one = <T extends AgentEventType>(events: readonly AgentEvent[], type: T): AgentEventOf<T> => {
  const found = events.filter(event => event.type === type)
  assert.equal(found.length, 1, `expected exactly one ${type}, got ${JSON.stringify(events)}`)
  return found[0] as AgentEventOf<T>
}

const types = (events: readonly AgentEvent[]): readonly string[] => events.map(event => event.type)

const assertNoFabricatedStream = (events: readonly AgentEvent[]): void => {
  assert.equal(events.some(event => event.type === 'assistant.delta' || event.type === 'assistant.attempt.start' || event.type === 'assistant.attempt.end'), false)
}

// 固定自 DSH-GO internal/transport/testdata/ws-golden.jsonl。
const goldenUserA = frame(2, 'user/message', {
  content: [{ type: 'text', text: '用 glob 找一下 *.go 的数量' }],
  id: 'user-a-1',
  role: 'user',
  source: { kind: 'user' },
  surfaceOp: 'append',
  v4Seq: 41,
  messageId: 'user-a-1',
}, 1793683940010)

const goldenAssistantA = frame(3, 'assistant/message', {
  turn: 1,
  step: 1,
  message: { role: 'assistant', content: [{ type: 'reasoning', text: '先看看目录里有什么，再数。' }] },
  stream: [{ type: 'finish', reason: { kind: 'completed' } }],
  surfaceOp: 'append',
  usage: { inputTokens: 120, outputTokens: 14, totalTokens: 134 },
  v4Seq: 42,
}, 1793683941007)

const goldenToolCallA = frame(5, 'tool/call', {
  turn: 1,
  step: 2,
  name: 'glob',
  arguments: '{"pattern":"**/*.go"}',
  callId: 'call-a-1',
}, 1793683941110)

const goldenToolResultA = frame(6, 'tool/result', {
  turn: 1,
  step: 2,
  message: {
    role: 'tool',
    source: { kind: 'tool', callId: 'call-a-1' },
    toolCallId: 'call-a-1',
    content: [{ type: 'text', text: '共 47 个 .go 文件' }],
    isError: false,
    id: 'tool-result-a-1',
  },
  meta: { cwd: '/workspace' },
  sourceEventSeqs: [],
  surfaceOp: 'append',
  view: { kind: 'table', columns: ['path'], rows: [['a.go']] },
}, 1793683941190)

const goldenApprovalA = frame(7, 'approval/request', {
  requestId: 'perm-a-timeout',
  sessionId: 'session-a',
  tool: 'bash',
  timeoutMs: 120000,
  deadlineMs: 1793684061200,
  toolCall: {
    toolCallId: 'perm-a-timeout',
    title: 'bash: rm -rf build/',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'rm -rf build/' },
  },
  options: [
    { optionId: 'allow_once', name: '允许这一次', kind: 'allow_once' },
    { optionId: 'allow_always', name: '这个会话里以后都允许', kind: 'allow_always' },
    { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
  ],
}, 1793683941200)

test('session.load emits ready and text with independent bridge seq and durable v4Seq=0', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'session-a' })
  const events = translator.translateLoad({
    messages: [
      { seq: 900, role: 'user', text: 'zero identity', time: 100, v4Seq: 0, messageId: 'user-zero' },
      {
        seq: 901,
        role: 'assistant',
        text: 'answer',
        time: 101,
        v4Seq: 1,
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      },
    ],
    total: 2,
    truncated: false,
    model: 'deepseek-chat',
    cwd: 'D:/work',
    permission: 'ask',
    effort: 'high',
    contextWindow: 128000,
    journalEpoch: 7,
    lastSeq: 2,
  })

  assert.deepEqual(types(events), ['session.ready', 'user.message', 'assistant.message'])
  const ready = one(events, 'session.ready')
  assert.equal(ready.sessionId, 'session-a')
  assert.equal(ready.cwd, 'D:/work')
  assert.equal(ready.model, 'deepseek-chat')
  assert.equal(ready.effort, 'high')
  assert.equal(ready.contextWindow, 128000)
  assert.equal(ready.permissionMode, 'ask')

  const user = one(events, 'user.message')
  assert.equal(user.id, 'user-zero')
  assert.equal(user.anchor, '0')
  assert.equal(user.seq, 1, 'load projection seq is not AgentEvent.seq')
  assert.equal(user.text, 'zero identity')
  const assistant = one(events, 'assistant.message')
  assert.equal(assistant.anchor, '1')
  assert.equal(assistant.seq, 2)
  assert.equal(assistant.canonical, false, 'load is a projection, not a raw canonical attempt')
  assert.deepEqual(assistant.blocks, [{ type: 'text', text: 'answer' }])
  assert.deepEqual(assistant.usage, { input: 3, output: 2, cacheRead: undefined, cacheWrite: undefined })
  assert.deepEqual(translator.transport(), { journalEpoch: 7, lastSeq: 2, requiresLoad: false })
  assertNoFabricatedStream(events)
})

test('load and WS dedupe by durable identity even when transport fence alone would admit the frame', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'session-a' })
  const loaded = translator.translateLoad({
    ...emptyLoad(7, 1),
    messages: [
      { seq: 41, role: 'user', text: '用 glob 找一下 *.go 的数量', time: 1793683940010, v4Seq: 41, messageId: 'user-a-1' },
      { seq: 42, role: 'assistant', text: '', reasoning: '先看看目录里有什么，再数。', time: 1793683941007, v4Seq: 42 },
    ],
    total: 2,
  })
  assert.deepEqual(types(loaded), ['session.ready', 'user.message', 'assistant.message'])

  // 手构低水位，让 seq=2/3 通过 Transport fence；必须仍被 durable 身份拦住。
  assert.deepEqual(translator.translateFrame(goldenUserA), [])
  assert.deepEqual(translator.translateFrame(goldenAssistantA), [])
  assert.equal(translator.transport().lastSeq, 3)

  const novel = translator.translateFrame(frame(4, 'assistant/message', {
    turn: 1,
    step: 2,
    message: { role: 'assistant', content: [{ type: 'text', text: '我用 glob 数一下。' }] },
    stream: [],
    v4Seq: 43,
  }, 1793683941101))
  const assistant = one(novel, 'assistant.message')
  assert.equal(assistant.anchor, '43')
  assert.equal(assistant.seq, 3)
  assert.equal(assistant.canonical, true)
  assertNoFabricatedStream(novel)
})

test('golden B keeps same text with different v4Seq and never duplicates out-of-order replay', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'session-b' })
  const loaded = translator.translateLoad({
    ...emptyLoad(11, 6),
    messages: [
      { seq: 71, role: 'user', text: 'SESSION-B-ONLY', time: 1, v4Seq: 71, messageId: 'user-b-1' },
      { seq: 72, role: 'assistant', text: '这是 session-b 的回答，不能串到 session-a。', time: 2, v4Seq: 72 },
      { seq: 73, role: 'user', text: 'SESSION-B-ONLY', time: 3, v4Seq: 73, messageId: 'user-b-2' },
      { seq: 74, role: 'assistant', text: '这是 session-b 的回答，不能串到 session-a。', time: 4, v4Seq: 74 },
    ],
    total: 4,
  })
  assert.deepEqual(types(loaded), ['session.ready', 'user.message', 'assistant.message', 'user.message', 'assistant.message'])
  assert.deepEqual(loaded.slice(1).map(event => event.type === 'user.message' || event.type === 'assistant.message' ? event.anchor : ''), ['71', '72', '73', '74'])
  assert.deepEqual(loaded.slice(1).map(event => 'seq' in event ? event.seq : -1), [1, 2, 3, 4])

  const replayData: Record<number, { v4Seq: number; role: string; text: string; messageId?: string }> = {
    2: { v4Seq: 71, role: 'user', text: 'SESSION-B-ONLY', messageId: 'user-b-1' },
    3: { v4Seq: 72, role: 'assistant', text: '这是 session-b 的回答，不能串到 session-a。' },
    4: { v4Seq: 73, role: 'user', text: 'SESSION-B-ONLY', messageId: 'user-b-2' },
    5: { v4Seq: 74, role: 'assistant', text: '这是 session-b 的回答，不能串到 session-a。' },
  }
  for (const seq of [5, 2, 4, 3, 2, 5]) {
    const item = replayData[seq]
    const type = item.role === 'user' ? 'user/message' : 'assistant/message'
    const data = item.role === 'user'
      ? { content: [{ type: 'text', text: item.text }], source: { kind: 'user' }, v4Seq: item.v4Seq, messageId: item.messageId }
      : { message: { content: [{ type: 'text', text: item.text }] }, v4Seq: item.v4Seq }
    assert.deepEqual(translator.translateFrame(frame(seq, type, data)), [])
  }
  assert.equal(translator.transport().lastSeq, 6)
})

test('A/B translators keep transport and durable state isolated', () => {
  const a = createDshGoEventTranslator({ sessionId: 'session-a' })
  const b = createDshGoEventTranslator({ sessionId: 'session-b' })
  a.translateLoad(emptyLoad(7, 0))
  b.translateLoad(emptyLoad('9223372036854775807', 0))
  const userA = frame(1, 'user/message', { content: [{ type: 'text', text: 'SHARED' }], source: { kind: 'user' }, v4Seq: 41, messageId: 'user-a' })
  const userB = frame(1, 'user/message', { content: [{ type: 'text', text: 'SHARED' }], source: { kind: 'user' }, v4Seq: 71, messageId: 'user-b' })
  assert.equal(one(a.translateFrame(userA), 'user.message').id, 'user-a')
  assert.equal(one(b.translateFrame(userB), 'user.message').id, 'user-b')
  assert.equal(one(a.translateFrame(frame(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'A' }] }, v4Seq: 42 })), 'assistant.message').anchor, '42')
  assert.equal(one(b.translateFrame(frame(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'B' }] }, v4Seq: 72 })), 'assistant.message').anchor, '72')
  assert.deepEqual(a.transport(), { journalEpoch: 7, lastSeq: 2, requiresLoad: false })
  assert.deepEqual(b.transport(), { journalEpoch: '9223372036854775807', lastSeq: 2, requiresLoad: false })
})

test('golden tool call/result maps raw fields, actual ViewSpec and error text', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'session-a' })
  translator.translateLoad(emptyLoad(7, 4))
  const call = one(translator.translateFrame(goldenToolCallA), 'tool.call')
  assert.equal(call.seq, 1)
  assert.equal(call.anchor, undefined)
  assert.equal(call.turn, 1)
  assert.equal(call.step, 2)
  assert.equal(call.callId, 'call-a-1')
  assert.equal(call.name, 'glob')
  assert.equal(call.argsJson, '{"pattern":"**/*.go"}')
  assert.equal(call.time, 1793683941110)

  const result = one(translator.translateFrame(goldenToolResultA), 'tool.result')
  assert.equal(result.seq, 2)
  assert.equal(result.callId, 'call-a-1')
  assert.equal(result.isError, false)
  assert.equal(result.text, '共 47 个 .go 文件')
  assert.deepEqual(result.content, [{ type: 'text', text: '共 47 个 .go 文件' }])
  assert.deepEqual(result.meta, { cwd: '/workspace' })
  assert.equal(result.errorText, undefined)
  assert.equal(result.presentation?.card, 'generic', 'the real host ViewSpec is preserved')

  const failed = one(translator.translateFrame(frame(7, 'tool/result', {
    turn: 1,
    step: 2,
    message: { toolCallId: 'call-a-1', content: [{ type: 'text', text: 'tool boom' }], isError: true },
  })), 'tool.result')
  assert.equal(failed.isError, true)
  assert.equal(failed.errorText, 'tool boom')
  assertNoFabricatedStream([call, result, failed])
})

test('load tool projection does not fabricate missing callId/turn/step', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'session-a' })
  const events = translator.translateLoad({
    ...emptyLoad(7, 9),
    messages: [{ seq: 88, role: 'tool', text: '共 47 个 .go 文件', tool: 'glob', args: '{"pattern":"**/*.go"}', summary: '47 files', time: 10 }],
    total: 1,
  })
  assert.deepEqual(types(events), ['session.ready'])
})

test('approval request, seq=0 replay and timeout map by requestId and option semantics', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'session-a' })
  translator.translateLoad(emptyLoad(7, 6))
  const request = one(translator.translateFrame(goldenApprovalA), 'permission.request').request
  assert.equal(request.requestId, 'perm-a-timeout')
  assert.equal(request.toolName, 'bash')
  assert.equal(request.callId, 'perm-a-timeout')
  assert.equal(request.title, 'bash: rm -rf build/')
  assert.deepEqual(request.input, { command: 'rm -rf build/' })
  assert.deepEqual(request.options, [
    { id: 'allow_once', kind: 'allow-once', label: '允许这一次' },
    { id: 'allow_always', kind: 'allow-always', label: '这个会话里以后都允许' },
    { id: 'reject_once', kind: 'reject', label: '拒绝' },
  ])
  assert.deepEqual(translator.pendingPermissions(), [request])

  const replay = translator.translateFrame({ ...goldenApprovalA, seq: 0, time: 1793683941300 })
  assert.deepEqual(replay, [])
  assert.equal(translator.transport().lastSeq, 7, 'seq=0 pending replay must not advance transport waterline')

  const settled = one(translator.translateFrame(frame(8, 'approval/timeout', goldenApprovalA.data, 1793684061200)), 'permission.settled')
  assert.deepEqual(settled, { type: 'permission.settled', requestId: 'perm-a-timeout', outcome: 'cancelled' })
  assert.deepEqual(translator.pendingPermissions(), [])
  assert.equal(translator.transport().lastSeq, 8)
})

test('approval cancel settles and reset clears pending plus durable state until a new load', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'session-b' })
  translator.translateLoad(emptyLoad(11, 0))
  const originalUser = frame(1, 'user/message', { content: [{ type: 'text', text: 'before reset' }], source: { kind: 'user' }, v4Seq: 0, messageId: 'user-zero' })
  assert.equal(one(translator.translateFrame(originalUser), 'user.message').anchor, '0')

  const request = frame(2, 'approval/request', { ...goldenApprovalA.data as object, requestId: 'perm-b-pending', sessionId: 'session-b' })
  translator.translateFrame(request)
  assert.equal(translator.pendingPermissions().length, 1)
  const cancelled = one(translator.translateFrame(frame(3, 'approval/cancel', request.data)), 'permission.settled')
  assert.deepEqual(cancelled, { type: 'permission.settled', requestId: 'perm-b-pending', outcome: 'cancelled' })

  translator.translateFrame(frame(4, 'approval/request', { ...goldenApprovalA.data as object, requestId: 'perm-reset', sessionId: 'session-b' }))
  assert.deepEqual(translator.pendingPermissions().map(item => item.requestId), ['perm-reset'])
  const reset = translator.translateFrame(frame(0, 'session/reset', { journalEpoch: 12, lastSeq: 4 }))
  assert.deepEqual(reset, [{ type: 'session.reset', trigger: 'dsh-go/session/reset' }])
  assert.deepEqual(translator.pendingPermissions(), [])
  assert.deepEqual(translator.transport(), { journalEpoch: 12, lastSeq: 4, requiresLoad: true })
  assert.deepEqual(translator.translateFrame(frame(5, 'assistant/message', { text: 'stale before load' })), [])

  const baseline = translator.translateLoad({
    ...emptyLoad(12, 4),
    messages: [{ seq: 0, role: 'user', text: 'before reset', time: 1, v4Seq: 0, messageId: 'user-zero' }],
    total: 1,
  })
  assert.deepEqual(types(baseline), ['session.ready', 'user.message'], 'reset must clear durable replay dedupe')
  assert.equal(one(baseline, 'user.message').seq, 1, 'bridge seq restarts with the reset projection')
  assert.equal(translator.transport().requiresLoad, false)
  assert.equal(one(translator.translateFrame(frame(5, 'assistant/message', { message: { content: [{ type: 'text', text: 'after reset' }] }, v4Seq: 1 })), 'assistant.message').seq, 2)
})

test('turn start/end/done/error closes once and keeps raw error text', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'session-a' })
  translator.translateLoad(emptyLoad(7, 0))
  assert.deepEqual(translator.translateFrame(frame(1, 'turn/start', { turn: 1 }, 1793683940001)), [
    { type: 'turn.start', turn: 1, origin: 'user', time: 1793683940001 },
  ])
  assert.deepEqual(translator.translateFrame(frame(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 1793683940100)), [])
  assert.deepEqual(translator.translateFrame(frame(3, 'turn/done', { turnId: 'turn-a-1' }, 1793683940200)), [
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 1793683940100 },
  ])
  assert.deepEqual(translator.translateFrame(frame(4, 'turn/done', { turnId: 'turn-a-1' }, 1793683940201)), [], 'duplicate raw done cannot duplicate public completion')

  translator.translateFrame(frame(5, 'turn/start', { turn: 2 }, 1793684062000))
  const failed = one(translator.translateFrame(frame(6, 'turn/error', { turnId: 'turn-a-2', error: 'synthetic turn failure: boom' }, 1793684062100)), 'turn.end')
  assert.deepEqual(failed, {
    type: 'turn.end',
    turn: 2,
    reason: { kind: 'error', message: 'synthetic turn failure: boom' },
    time: 1793684062100,
  })

  translator.translateFrame(frame(7, 'turn/start', { turn: 3 }, 1793684062200))
  const done = one(translator.translateFrame(frame(8, 'turn/done', { turnId: 'turn-a-3' }, 1793684062300)), 'turn.end')
  assert.deepEqual(done.reason, { kind: 'completed' })
})

test('transport gap waits for ordered history frames instead of reordering live events', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'session-a' })
  translator.translateLoad(emptyLoad(7, 1))
  const later = frame(3, 'assistant/message', { message: { content: [{ type: 'text', text: 'later' }] }, v4Seq: 42 })
  assert.deepEqual(translator.translateFrame(later), [])
  assert.equal(translator.transport().lastSeq, 1)

  // session.history 的原始帧由调用方按序补入；本层不发起网络请求。
  const missing = one(translator.translateFrame(frame(2, 'user/message', {
    content: [{ type: 'text', text: 'missing' }],
    source: { kind: 'user' },
    v4Seq: 41,
    messageId: 'user-a-1',
  })), 'user.message')
  assert.equal(missing.text, 'missing')
  assert.equal(one(translator.translateFrame(later), 'assistant.message').anchor, '42')
  assert.equal(translator.transport().lastSeq, 3)
})

test('approval malformed rawInput keeps original text without claiming parsed input', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'session-a' })
  translator.translateLoad(emptyLoad(7, 0))
  const request = one(translator.translateFrame(frame(1, 'approval/request', {
    requestId: 'perm-raw',
    tool: 'bash',
    toolCall: { toolCallId: 'call-raw', title: 'bash: {bad', rawInput: '{bad' },
    options: [
      { optionId: 'allow_once', kind: 'allow_once' },
      { optionId: 'reject_once', kind: 'reject_once' },
    ],
  })), 'permission.request').request
  assert.equal(request.input, undefined)
  assert.equal(request.command, '{bad')
  assert.deepEqual(request.options.map(option => option.kind), ['allow-once', 'reject'])
})

test('title and color changes map to metadata events while malformed frames stay custom', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'session-a' })
  translator.translateLoad(emptyLoad(7, 0))
  assert.deepEqual(translator.translateFrame(frame(1, 'session/title', {
    title: '  exact title  ', messageSeqs: [], source: { kind: 'user' },
  })), [{ type: 'session.title', title: '  exact title  ', source: 'user' }])
  assert.deepEqual(translator.translateFrame(frame(2, 'session/color', { color: 'cyan' })), [
    { type: 'session.color', color: 'cyan' },
  ])
  assert.deepEqual(translator.translateFrame(frame(3, 'session/title', { title: 'missing source' })), [
    { type: 'custom', nativeType: 'session/title', data: { title: 'missing source' } },
  ])
  assert.deepEqual(translator.translateFrame(frame(4, 'session/color', { color: 1 })), [
    { type: 'custom', nativeType: 'session/color', data: { color: 1 } },
  ])
})

test('unknown events degrade to custom, pong is inert, and no delta or attempt lifecycle is invented', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'session-a' })
  translator.translateLoad(emptyLoad(7, 0))
  assert.deepEqual(translator.translateFrame(frame(0, 'pong')), [])
  assert.equal(translator.transport().lastSeq, 0)
  assert.deepEqual(translator.translateFrame(frame(1, 'plugin/future', { value: 1 })), [
    { type: 'custom', nativeType: 'plugin/future', data: { value: 1 } },
  ])
  const events = translator.translateFrame(frame(2, 'assistant/message', { text: '', reasoning: 'only thought' }))
  const assistant = one(events, 'assistant.message')
  assert.deepEqual(assistant.blocks, [{ type: 'reasoning', text: 'only thought' }])
  assert.equal(assistant.canonical, false)
  assert.equal(assistant.anchor, '', 'anonymous non-v4 source has no durable anchor')
  assertNoFabricatedStream(events)
})

test('side.query result and NDJSON frames preserve independent answer, cancellation and errors', () => {
  assert.equal(dshGoSideQueryResult({ requestId: 'side-a', answer: 'whole answer' }, 'side-a'), 'whole answer')
  assert.equal(dshGoSideQueryResult({ requestId: 'side-a', answer: null, cancelled: true }, 'side-a'), null)
  assert.deepEqual(dshGoSideQueryFrame({ type: 'text', requestId: 'side-a', text: '流式' }, 'side-a'), {
    type: 'text', requestId: 'side-a', text: '流式',
  })
  assert.deepEqual(dshGoSideQueryFrame({ type: 'done', requestId: 'side-a', answer: 'side answer' }, 'side-a'), {
    type: 'done', requestId: 'side-a', answer: 'side answer',
  })
  const error = { code: 'internal', message: 'runner failed exactly', hint: '', retryable: false }
  assert.deepEqual(dshGoSideQueryFrame({ type: 'error', requestId: 'side-a', error }, 'side-a'), {
    type: 'error', requestId: 'side-a', error,
  })
})

test('side.query rejects crossed request ids and malformed terminal frames', () => {
  for (const value of [
    undefined,
    { requestId: 'side-a' },
    { requestId: 'side-b', answer: 'crossed' },
    { requestId: 'side-a', answer: null },
    { type: 'text', requestId: 'side-a', text: 1 },
    { type: 'done', requestId: 'side-a' },
    { type: 'error', requestId: 'side-a', error: { message: 'incomplete' } },
  ]) {
    assert.throws(() => dshGoSideQueryFrame(value, 'side-a'), /side\.query returned an invalid result/)
  }
})

test('NO_EVENTS is the shared frozen empty batch, exported as a real runtime value', () => {
  // A `.d.ts` never emits a `.js`, so `NO_EVENTS` imported from
  // `./types/agent/events.js` typechecks and then dies with
  // ERR_MODULE_NOT_FOUND; `./events.js` is where the frozen array really lives.
  assert.equal(Array.isArray(NO_EVENTS), true)
  assert.equal(NO_EVENTS.length, 0)
  assert.deepEqual(NO_EVENTS, [])
  assert.equal(Object.isFrozen(NO_EVENTS), true)
  assert.throws(() => { (NO_EVENTS as AgentEvent[]).push() }, TypeError)
})

test('a frame that maps to nothing returns that same shared empty batch', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'session-a' })
  translator.translateLoad(emptyLoad(7, 0))

  assert.equal(translator.translateFrame(frame(1, 'pong')), NO_EVENTS)
  assert.equal(translator.translateFrame(frame(0, 'user/message', { content: [] })), NO_EVENTS)
  assert.equal(translator.translateFrame(frame(2, 'assistant/message', { text: 'gap' })), NO_EVENTS)
  assert.equal(translator.translateFrame(frame(3, 'pong')), NO_EVENTS)
  // None of those moved the transport fence: every one of them was an empty result.
  assert.deepEqual(translator.transport(), { journalEpoch: 7, lastSeq: 0, requiresLoad: false })
})
