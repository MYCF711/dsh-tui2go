import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent } from '../../src/types/agent/events.js'
import {
  createDshGoSubagentEventTranslator,
  createDshGoTaskEventTranslator,
  dshGoAppendedOutput,
  type DshGoTaskJob,
} from '../../src/task-events.js'

const job = (patch: Partial<DshGoTaskJob> = {}): DshGoTaskJob => ({
  id: 'job-a', sessionId: 'session-a', command: 'sleep 9', done: false, exitCode: 0, bytes: 4,
  ...patch,
})

test('task snapshots contain live ids while start/end retain terminal jobs', () => {
  const translator = createDshGoTaskEventTranslator(() => 123)
  assert.deepEqual(translator.apply([job()]), [
    { type: 'task.start', taskId: 'job-a', kind: 'shell', description: 'sleep 9', command: 'sleep 9', background: true, time: 123 },
    { type: 'tasks.snapshot', taskIds: ['job-a'] },
  ])
  assert.deepEqual(translator.apply([job({ done: true, exitCode: 7 })]), [
    { type: 'task.end', taskId: 'job-a', status: 'failed', summary: 'exit code: 7', time: 123 },
    { type: 'tasks.snapshot', taskIds: [] },
  ])
  assert.deepEqual(translator.apply([job({ done: true, exitCode: 7 })]), [])
})

test('a confirmed stop wins over the later natural done projection', () => {
  const translator = createDshGoTaskEventTranslator(() => 456)
  translator.apply([job()])
  assert.deepEqual(translator.stop(job({ done: true, exitCode: -1 })), [
    { type: 'task.end', taskId: 'job-a', status: 'stopped', summary: 'exit code: -1', time: 456 },
    { type: 'tasks.snapshot', taskIds: [] },
  ])
  assert.deepEqual(translator.apply([job({ done: true, exitCode: -1 })]), [])
  assert.deepEqual(translator.stop(job({ done: true })), [])
})

test('invalid job status regressions and duplicate ids fail instead of rewriting history', () => {
  const translator = createDshGoTaskEventTranslator()
  translator.apply([job({ done: true })])
  assert.throws(() => translator.apply([job()]), /done to running/)
  assert.throws(() => createDshGoTaskEventTranslator().apply([job(), job()]), /duplicate job id/)
})

test('output deltas handle exact appends, sliding Unicode tails and divergence', () => {
  assert.equal(dshGoAppendedOutput(undefined, 'A甲🙂'), 'A甲🙂')
  assert.equal(dshGoAppendedOutput('A甲', 'A甲🙂乙'), '🙂乙')
  assert.equal(dshGoAppendedOutput('A甲🙂', '甲🙂乙'), '乙')
  assert.equal(dshGoAppendedOutput('same', 'same'), '')
  assert.equal(dshGoAppendedOutput('abcdef', 'XYZ'), undefined)
})

test('subagent translation uses only real delegation calls and results', () => {
  const translator = createDshGoSubagentEventTranslator()
  const call: AgentEvent = {
    type: 'tool.call', seq: 1, turn: 1, step: 1, callId: 'call-a', name: 'subagent',
    argsJson: '{"description":" inspect files ","prompt":"do it"}', time: 10,
  }
  assert.deepEqual(translator.accept(call), [{
    type: 'subagent.start', agentId: 'call-a', parentCallId: 'call-a', description: 'inspect files',
    kind: 'subagent', background: false, depth: 1, time: 10,
  }])
  assert.deepEqual(translator.accept(call), [])
  const result: AgentEvent = {
    type: 'tool.result', seq: 2, turn: 1, step: 1, callId: 'call-a', isError: false,
    time: 20, content: [{ type: 'text', text: 'done' }], text: 'done',
  }
  assert.deepEqual(translator.accept(result), [{
    type: 'subagent.end', agentId: 'call-a', status: 'completed', summary: 'done', time: 20,
  }])
  assert.deepEqual(translator.accept(result), [])
  translator.accept(call)
  translator.reset()
  assert.deepEqual(translator.accept(result), [])
})

test('unmatched subagent call ids stay bounded at 200', () => {
  const translator = createDshGoSubagentEventTranslator()
  const callFor = (callId: string): AgentEvent => ({
    type: 'tool.call', seq: 1, turn: 1, step: 1, callId, name: 'subagent', argsJson: '{}', time: 10,
  })
  const resultFor = (callId: string): AgentEvent => ({
    type: 'tool.result', seq: 2, turn: 1, step: 1, callId, isError: false,
    time: 20, content: [{ type: 'text', text: 'done' }], text: 'done',
  })
  for (let index = 0; index <= 200; index += 1) translator.accept(callFor(`call-${index}`))
  assert.deepEqual(translator.accept(resultFor('call-0')), [])
  assert.equal(translator.accept(resultFor('call-200')).length, 1)
})
