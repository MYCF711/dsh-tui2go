import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshGoStepStreamTranslator } from '../../src/step-stream.js'
import type { DshGoServerFrame } from '../../src/events.js'

const frame = (seq: number, type: string, data: unknown, time: number): DshGoServerFrame => ({ seq, type, data, time })

test('step/delta/TTFT preserve raw positions, indexes and wall-clock timestamps', () => {
  const stream = createDshGoStepStreamTranslator()
  assert.deepEqual(stream.translateFrame(frame(1, 'step/start', { turn: 1, step: 2 }, 100)), [
    { type: 'step.start', turn: 1, step: 2 },
  ])
  const reasoning = stream.translateFrame(frame(2, 'assistant/reasoning', { turn: 1, step: 2, text: 'think', index: 4 }, 150))!
  assert.deepEqual(reasoning, [
    { type: 'assistant.attempt.start', attemptId: 'dsh-go:step:1:2', turn: 1, step: 2, firstTokenTime: 150 },
    { type: 'assistant.delta', attemptId: 'dsh-go:step:1:2', index: 4, time: 150, turn: 1, step: 2, delta: { kind: 'reasoning', text: 'think' } },
  ])
  assert.deepEqual(stream.translateFrame(frame(3, 'assistant/text', { turn: 1, step: 2, text: 'answer' }, 225)), [
    { type: 'assistant.delta', attemptId: 'dsh-go:step:1:2', index: 5, time: 225, turn: 1, step: 2, delta: { kind: 'text', text: 'answer' } },
  ])
  assert.deepEqual(stream.translateFrame(frame(4, 'step/end', { turn: 1, step: 2 }, 250)), [
    { type: 'assistant.attempt.end', attemptId: 'dsh-go:step:1:2', outcome: 'committed' },
    { type: 'step.end', turn: 1, step: 2 },
  ])
  assert.deepEqual(stream.timings(), [{
    turn: 1, step: 2, startTime: 100, firstTokenTime: 150, lastTokenTime: 225,
    endTime: 250, ttftMs: 50, decodeMs: 75,
  }])
})

test('a delta without step/start keeps its facts but does not fabricate a step boundary or TTFT', () => {
  const stream = createDshGoStepStreamTranslator()
  const events = stream.translateFrame(frame(8, 'assistant/text', { turn: 3, step: 1, text: 'tail', v4Seq: 91 }, 800))!
  assert.deepEqual(events.map(event => event.type), ['assistant.attempt.start', 'assistant.delta'])
  assert.equal(events.some(event => event.type === 'step.start'), false)
  assert.deepEqual(events[1], {
    type: 'assistant.delta', attemptId: 'dsh-go:step:3:1', index: 0, time: 800,
    turn: 3, step: 1, seq: 91, delta: { kind: 'text', text: 'tail' },
  })
  assert.deepEqual(stream.timings(), [{
    turn: 3, step: 1, firstTokenTime: 800, lastTokenTime: 800, decodeMs: 0,
  }])
})

test('missing positions or delta text do not invent events', () => {
  const stream = createDshGoStepStreamTranslator()
  assert.deepEqual(stream.translateFrame(frame(1, 'step/start', { step: 1 }, 1)), [])
  assert.deepEqual(stream.translateFrame(frame(2, 'assistant/text', { turn: 1, text: 'x' }, 2)), [])
  assert.deepEqual(stream.translateFrame(frame(3, 'assistant/text', { turn: 1, step: 1 }, 3)), [])
  assert.equal(stream.translateFrame(frame(4, 'assistant/message', { turn: 1, step: 1 }, 4)), undefined)
  assert.deepEqual(stream.timings(), [])
})

test('A/B stream state and same-position projection keys stay isolated', () => {
  const a = createDshGoStepStreamTranslator()
  const b = createDshGoStepStreamTranslator()
  a.translateFrame(frame(1, 'step/start', { turn: 1, step: 1 }, 100))
  b.translateFrame(frame(1, 'step/start', { turn: 1, step: 1 }, 900))
  a.translateFrame(frame(2, 'assistant/text', { turn: 1, step: 1, text: 'A' }, 120))
  b.translateFrame(frame(2, 'assistant/text', { turn: 1, step: 1, text: 'B' }, 1_000))
  assert.deepEqual(a.timings().map(timing => timing.ttftMs), [20])
  assert.deepEqual(b.timings().map(timing => timing.ttftMs), [100])
  assert.equal(a.timings()[0]?.startTime, 100)
  assert.equal(b.timings()[0]?.startTime, 900)
})

test('reset clears timing and open-attempt state', () => {
  const stream = createDshGoStepStreamTranslator()
  stream.translateFrame(frame(1, 'assistant/text', { turn: 1, step: 1, text: 'A' }, 10))
  stream.reset()
  assert.deepEqual(stream.timings(), [])
  assert.deepEqual(stream.translateFrame(frame(2, 'step/end', { turn: 1, step: 1 }, 20)), [
    { type: 'step.end', turn: 1, step: 1 },
  ])
})
