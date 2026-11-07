import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionCapabilities } from '../../src/types/agent/capabilities.js'
import type { AgentEventOf } from '../../src/types/agent/events.js'
import {
  createDshGoForkCapability,
  createDshGoRewindCapability,
  createDshGoTranscriptCapability,
  loadDshGoTranscriptCapability,
  previewDshGoRewind,
  runDshGoFork,
  runDshGoRewind,
  type DshGoSessionOperationsTransport,
} from '../../src/session-operations.js'

interface Call {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>> | undefined
}

function transportReturning(result: unknown, calls: Call[]): DshGoSessionOperationsTransport {
  return {
    async call<T = unknown>(method: string, params?: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      return result as T
    },
  }
}

function transportFailing(failure: Error, calls = 0): { readonly transport: DshGoSessionOperationsTransport; readonly calls: () => number } {
  let count = calls
  return {
    transport: { async call<T = unknown>(): Promise<T> { count++; throw failure } },
    calls: () => count,
  }
}

function transcriptLoad(count: number): Record<string, unknown> {
  return {
    messages: Array.from({ length: count }, (_, index) => ({
      seq: index + 1,
      v4Seq: index + 101,
      role: 'user',
      text: `m${index + 1}`,
      time: index + 1000,
    })),
    total: count,
    truncated: false,
    journalEpoch: '7',
    lastSeq: count,
  }
}

function userTexts(events: ReturnType<NonNullable<SessionCapabilities['transcript']>['older']>): readonly string[] {
  return events.filter((event): event is AgentEventOf<'user.message'> => event.type === 'user.message').map(event => event.text)
}

test('whole-session fork reuses bare id params and returns the real child ref', async () => {
  const calls: Call[] = []
  const capability = createDshGoForkCapability(transportReturning({ sessionId: 'child-1' }, calls), 'parent-1')
  assert.deepEqual(await capability.fork(), { backendId: 'dsh-go', sessionId: 'child-1' })
  assert.deepEqual(calls, [{ method: 'session.fork', params: { id: 'parent-1' } }])
})

test('anchored titled fork forwards and requires exact anchor/title acknowledgements', async () => {
  const calls: Call[] = []
  const response = { sessionId: 'child-2', anchor: 'user-anchor-9', title: '  Keep this title  ' }
  const result = await runDshGoFork(transportReturning(response, calls), 'parent-2', 'user-anchor-9', '  Keep this title  ')
  assert.deepEqual(result, { backendId: 'dsh-go', sessionId: 'child-2' })
  assert.deepEqual(calls, [{
    method: 'session.fork',
    params: { id: 'parent-2', anchor: 'user-anchor-9', title: '  Keep this title  ' },
  }])
})

test('fork never hides an old host ignoring anchor or title', async () => {
  await assert.rejects(
    runDshGoFork(transportReturning({ sessionId: 'accidental-full-copy' }, []), 'parent', 'anchor-1'),
    /created "accidental-full-copy" but did not confirm anchor "anchor-1"/,
  )
  await assert.rejects(
    runDshGoFork(transportReturning({ sessionId: 'untitled-copy' }, []), 'parent', undefined, 'wanted-title'),
    /created "untitled-copy" but did not confirm title "wanted-title"/,
  )
})

test('fork validates arguments/results and preserves transport failures', async () => {
  await assert.rejects(runDshGoFork(transportReturning({}, []), 'parent'), /session\.fork returned no sessionId/)
  await assert.rejects(runDshGoFork(transportReturning({ sessionId: 'parent' }, []), 'parent'), /returned the source session id/)
  await assert.rejects(runDshGoFork(transportReturning({}, []), ''), /requires a session id/)
  await assert.rejects(runDshGoFork(transportReturning({}, []), 'parent', ''), /anchor must not be empty/)
  const failure = new Error('fork disk write failed')
  const failing = transportFailing(failure)
  await assert.rejects(runDshGoFork(failing.transport, 'parent'), error => error === failure)
  assert.equal(failing.calls(), 1)
})

test('rewind preview sends the real anchor and preserves file statistics', async () => {
  const calls: Call[] = []
  const capability = createDshGoRewindCapability(transportReturning({ filesChanged: ['a.ts', 'b.ts'], insertions: 4, deletions: 2 }, calls), 'session-r')
  assert.deepEqual(await capability.preview?.('anchor-r'), { filesChanged: ['a.ts', 'b.ts'], insertions: 4, deletions: 2 })
  assert.deepEqual(calls, [{ method: 'session.rewind.preview', params: { id: 'session-r', anchor: 'anchor-r' } }])
})

test('rewind preview rejects malformed success and propagates host errors', async () => {
  for (const response of [undefined, null, {}, { filesChanged: 'a.ts' }, { filesChanged: [1] }, { filesChanged: [], insertions: -1 }]) {
    await assert.rejects(previewDshGoRewind(transportReturning(response, []), 's', 'a'), /session\.rewind\.preview returned/)
  }
  const failure = new Error('preview checkpoint missing')
  await assert.rejects(previewDshGoRewind(transportFailing(failure).transport, 's', 'a'), error => error === failure)
})

test('conversation rewind requires and returns the host-created session', async () => {
  const calls: Call[] = []
  const outcome = await runDshGoRewind(transportReturning({ kind: 'rewound', sessionId: 'rewound-child' }, calls), 'source', 'picked-user', 'conversation')
  assert.deepEqual(outcome, { kind: 'rewound', session: { backendId: 'dsh-go', sessionId: 'rewound-child' } })
  assert.deepEqual(calls, [{ method: 'session.rewind.apply', params: { id: 'source', anchor: 'picked-user', mode: 'conversation' } }])
})

test('files rewind returns the bound session and actual restore preview', async () => {
  const files = { filesChanged: ['src/a.ts'], insertions: 0, deletions: 8 }
  const outcome = await runDshGoRewind(transportReturning({ kind: 'rewound', files }, []), 'source', 'anchor', 'files')
  assert.deepEqual(outcome, { kind: 'rewound', session: { backendId: 'dsh-go', sessionId: 'source' }, files })
})

test('both rewind preserves a real files-restored conversation-failed partial outcome', async () => {
  const files = { filesChanged: ['src/a.ts'], insertions: 3, deletions: 1 }
  const outcome = await runDshGoRewind(transportReturning({ kind: 'rewound', files, conversationError: 'fork write failed' }, []), 'source', 'anchor', 'both')
  assert.deepEqual(outcome, {
    kind: 'rewound',
    session: { backendId: 'dsh-go', sessionId: 'source' },
    files,
    conversationError: 'fork write failed',
  })
})

test('native rewind refusal stays refused without a fabricated session or files', async () => {
  const outcome = await runDshGoRewind(transportReturning({ kind: 'refused', reason: 'anchor is not a user message' }, []), 'source', 'bad-anchor', 'both')
  assert.deepEqual(outcome, { kind: 'refused', reason: 'anchor is not a user message' })
})

test('rewind malformed success cannot impersonate a conversation or partial rewind', async () => {
  const cases: readonly [unknown, 'conversation' | 'files' | 'both'][] = [
    [{}, 'conversation'],
    [{ kind: 'rewound' }, 'conversation'],
    [{ kind: 'rewound', sessionId: 'source' }, 'conversation'],
    [{ kind: 'rewound', conversationError: 'failed' }, 'both'],
    [{ kind: 'rewound', files: { filesChanged: [] }, conversationError: 'failed' }, 'conversation'],
    [{ kind: 'rewound', files: { filesChanged: [] } }, 'conversation'],
    [{ kind: 'rewound', sessionId: 'other' }, 'files'],
    [{ kind: 'refused' }, 'both'],
  ]
  for (const [response, mode] of cases) {
    await assert.rejects(runDshGoRewind(transportReturning(response, []), 'source', 'anchor', mode), /session\.rewind\.apply/)
  }
})

test('rewind apply validates mode and preserves transport failures', async () => {
  await assert.rejects(runDshGoRewind(transportReturning({}, []), 's', '', 'files'), /anchor must not be empty/)
  await assert.rejects(runDshGoRewind(transportReturning({}, []), 's', 'a', 'invalid' as 'files'), /invalid mode "invalid"/)
  const failure = new Error('rewind apply failed after unknown side effects')
  const failing = transportFailing(failure)
  await assert.rejects(runDshGoRewind(failing.transport, 's', 'a', 'both'), error => error === failure)
  assert.equal(failing.calls(), 1)
})

test('transcript record and older pages use one complete durable load in oldest-first order', async () => {
  const calls: Call[] = []
  const capability = await loadDshGoTranscriptCapability(transportReturning(transcriptLoad(5), calls), 'session-t', {
    initialMessages: 2,
    pageMessages: 2,
    maxMessages: 10,
  })
  assert.deepEqual(calls, [{ method: 'session.load', params: { id: 'session-t', tailMessages: 10 } }])
  assert.deepEqual(userTexts(capability.record() ?? []), ['m1', 'm2', 'm3', 'm4', 'm5'])
  assert.equal(capability.record(), capability.record())
  assert.equal(capability.hasOlder(), true)
  assert.deepEqual(userTexts(capability.older()), ['m2', 'm3'])
  assert.equal(capability.hasOlder(), true)
  assert.deepEqual(userTexts(capability.older()), ['m1'])
  assert.equal(capability.hasOlder(), false)
  assert.deepEqual(capability.older(), [])
})

test('empty durable transcript has an empty record and stable empty pages', () => {
  const capability = createDshGoTranscriptCapability('empty', transcriptLoad(0))
  assert.deepEqual(capability.record(), [])
  assert.equal(capability.hasOlder(), false)
  assert.deepEqual(capability.older(), [])
  assert.deepEqual(capability.older(), [])
})

test('initialMessages=0 pages the whole bounded record without a transport journal claim', () => {
  const capability = createDshGoTranscriptCapability('s', transcriptLoad(3), { initialMessages: 0, pageMessages: 3 })
  assert.deepEqual(userTexts(capability.older()), ['m1', 'm2', 'm3'])
  assert.equal(capability.hasOlder(), false)
})

test('truncated, unknown-total and over-bound loads fail loudly for the missing page API', async () => {
  const truncated = { ...transcriptLoad(2), total: 5, truncated: true }
  await assert.rejects(loadDshGoTranscriptCapability(transportReturning(truncated, []), 's'), /session\.transcript\.page is required/)
  const unknownTotal = { ...transcriptLoad(2), total: -1, truncated: true }
  await assert.rejects(loadDshGoTranscriptCapability(transportReturning(unknownTotal, []), 's'), /invalid transcript projection/)
  const overBound = { ...transcriptLoad(3), total: 3 }
  await assert.rejects(loadDshGoTranscriptCapability(transportReturning(overBound, []), 's', { maxMessages: 2 }), /maxMessages=2.*session\.transcript\.page/)
})

test('transcript validates options and malformed messages before returning a capability', () => {
  for (const options of [{ initialMessages: -1 }, { pageMessages: 0 }, { maxMessages: 0 }, { maxMessages: 1.5 }]) {
    assert.throws(() => createDshGoTranscriptCapability('s', transcriptLoad(0), options), /transcript options require/)
  }
  const badMessage = transcriptLoad(1)
  ;(badMessage.messages as { text: unknown }[])[0]!.text = 4
  assert.throws(() => createDshGoTranscriptCapability('s', badMessage), /invalid message at index 0/)
})

test('transcript load transport errors propagate unchanged', async () => {
  const failure = new Error('durable log read failed')
  const failing = transportFailing(failure)
  await assert.rejects(loadDshGoTranscriptCapability(failing.transport, 's'), error => error === failure)
  assert.equal(failing.calls(), 1)
})
