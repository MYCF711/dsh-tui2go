import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createDshGoSideQuery, createDshGoIndependentSideQueryRunner, type DshGoSideQueryRunner } from '../../src/side-query.js'
import { DshGoLaunch } from '../../src/transport.js'

test('sideQuery refuses missing or unmarked runners instead of using session.prompt', () => {
  assert.throws(() => createDshGoSideQuery('session-a', undefined as unknown as DshGoSideQueryRunner), /real isolated session or independent runner/)
  assert.throws(() => createDshGoSideQuery('session-a', { isolation: 'ordinary', run: async () => 'no' } as unknown as DshGoSideQueryRunner), /session\.prompt is not a side query/)
})

test('an independent runner streams and returns its answer', async () => {
  const prompts: string[] = []
  const runner: DshGoSideQueryRunner = {
    isolation: 'independent-runner',
    async run(request) {
      prompts.push(request.prompt)
      request.onText('side ')
      request.onText('answer')
      return 'side answer'
    },
  }
  const helper = createDshGoSideQuery('session-a', runner)
  const deltas: string[] = []
  assert.deepEqual(await helper.capability.ask('recap this', { onText: delta => { deltas.push(delta) } }), { answer: 'side answer' })
  assert.deepEqual(prompts, ['recap this'])
  assert.deepEqual(deltas, ['side ', 'answer'])
  helper.close()
})

test('a non-streaming isolated runner settles the full text once', async () => {
  const helper = createDshGoSideQuery('session-a', { isolation: 'ephemeral-session', run: async () => '  complete answer  ' })
  const deltas: string[] = []
  assert.deepEqual(await helper.capability.ask('question', { onText: delta => { deltas.push(delta) } }), { answer: 'complete answer' })
  assert.deepEqual(deltas, ['complete answer'])
})

test('A/B source sessions stay isolated across concurrent side calls', async () => {
  const seen: string[] = []
  const runner: DshGoSideQueryRunner = {
    isolation: 'ephemeral-session',
    async run({ sessionId, prompt, onText }) {
      seen.push(`${sessionId}:${prompt}`)
      await new Promise(resolve => setTimeout(resolve, sessionId === 'session-a' ? 5 : 1))
      onText(`${sessionId}-delta`)
      return `${sessionId}-answer`
    },
  }
  const a = createDshGoSideQuery('session-a', runner)
  const b = createDshGoSideQuery('session-b', runner)
  const deltas: string[] = []
  const [left, right] = await Promise.all([
    a.capability.ask('recap-a', { onText: delta => { deltas.push(delta) } }),
    b.capability.ask('btw-b', { onText: delta => { deltas.push(delta) } }),
  ])
  assert.deepEqual(left, { answer: 'session-a-answer' })
  assert.deepEqual(right, { answer: 'session-b-answer' })
  assert.deepEqual(seen.sort(), ['session-a:recap-a', 'session-b:btw-b'])
  assert.deepEqual(deltas.sort(), ['session-a-delta', 'session-b-delta'])
  a.close()
  b.close()
})

test('pre-aborted calls never start a runner', async () => {
  let calls = 0
  const helper = createDshGoSideQuery('session-a', { isolation: 'independent-runner', run: async () => { calls++; return 'no' } })
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await helper.capability.ask('cancelled', { signal: controller.signal }), { answer: null })
  assert.equal(calls, 0)
})

test('mid-flight cancellation aborts the real runner and suppresses late deltas', async () => {
  let observed: AbortSignal | undefined
  let lateText: ((delta: string) => void) | undefined
  const helper = createDshGoSideQuery('session-a', {
    isolation: 'independent-runner',
    run: ({ signal, onText }) => {
      observed = signal
      lateText = onText
      onText('before')
      return new Promise<string>(() => undefined)
    },
  })
  const controller = new AbortController()
  const deltas: string[] = []
  const pending = helper.capability.ask('long', { signal: controller.signal, onText: delta => { deltas.push(delta) } })
  await Promise.resolve()
  controller.abort()
  assert.deepEqual(await pending, { answer: null })
  assert.equal(observed?.aborted, true)
  lateText?.('late')
  assert.deepEqual(deltas, ['before'])
})

test('close aborts active calls and rejects later work without hiding runner errors', async () => {
  const helper = createDshGoSideQuery('session-a', {
    isolation: 'independent-runner',
    run: async ({ prompt, signal }) => {
      if (prompt === 'fail') throw new Error('runner failed')
      if (prompt === 'empty') return ''
      await new Promise<void>(resolve => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      return 'late'
    },
  })
  const active = helper.capability.ask('active')
  helper.close()
  assert.deepEqual(await active, { answer: null })
  assert.deepEqual(await helper.capability.ask('after'), { answer: null, error: 'dsh-go: sideQuery is closed' })
  const failing = createDshGoSideQuery('session-a', {
    isolation: 'independent-runner',
    run: async ({ prompt }) => {
      if (prompt === 'fail') throw new Error('runner failed')
      return ''
    },
  })
  assert.deepEqual(await failing.capability.ask('fail'), { answer: null, error: 'runner failed' })
  assert.deepEqual(await failing.capability.ask('empty'), { answer: null, error: 'dsh-go: isolated sideQuery runner returned no answer' })
})

/* ---------------------------------------------------------------------------
 * T5A red-first: real NDJSON framing through the real Transport.
 *
 * `DshGoSideQueryTransport.sideQuery` is the HTTP `application/x-ndjson` surface
 * (0.18 W149). Framing is a real behaviour of this pair, not an implementation
 * detail: one frame may be split across TCP chunks (mid-JSON), several frames
 * may share one chunk, and the last frame may arrive without a trailing
 * newline. The runner must observe whole `text` deltas, in order, with no
 * partial delta and no parse error at a chunk boundary.
 * ------------------------------------------------------------------------- */

interface NdjsonHost {
  readonly url: string
  readonly close: () => Promise<void>
}

interface NdjsonHostOptions {
  readonly confirmClose?: boolean
}

/**
 * A real HTTP host: `/connect` hands out the session cookie, `/api/side.query`
 * streams NDJSON, every other `/api/*` confirms with `{ok:true}`. The payload is
 * written in `splitAt`-sized pieces with Nagle disabled and a delay between
 * them, so the byte boundaries really do reach the client as separate chunks.
 */
async function startNdjsonHost(
  frames: (requestId: string) => readonly string[],
  splitAt: readonly number[],
  options: NdjsonHostOptions = {},
): Promise<NdjsonHost> {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/connect') === true) {
      response.writeHead(204, { 'set-cookie': 'dshd_session=side-cookie; Path=/; HttpOnly' })
      response.end()
      return
    }
    const received: Buffer[] = []
    request.on('data', chunk => { received.push(chunk as Buffer) })
    request.on('end', () => {
      const body = Buffer.concat(received).toString('utf8')
      const method = (request.url ?? '').replace('/api/', '')
      if (method !== 'side.query') {
        const ok = method === 'side.close' ? options.confirmClose !== false : true
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ result: { ok } }))
        return
      }
      const requestId = String((JSON.parse(body) as { requestId?: unknown }).requestId ?? '')
      const payload = Buffer.from(frames(requestId).join(''), 'utf8')
      response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
      response.socket?.setNoDelay(true)
      const stream = async (): Promise<void> => {
        let offset = 0
        for (const size of splitAt) {
          if (offset >= payload.byteLength) break
          const end = Math.min(offset + size, payload.byteLength)
          response.write(payload.subarray(offset, end))
          offset = end
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        if (offset < payload.byteLength) response.write(payload.subarray(offset))
        response.end()
      }
      void stream()
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => { server.close(() => { resolve() }) }),
  }
}

async function connectRealTransport(url: string) {
  return new DshGoLaunch(`ready ${JSON.stringify({ url, token: 'launch-secret' })}`).connect()
}

test('a real NDJSON side.query stream split mid-frame yields whole deltas in order', async t => {
  const [first, second] = ['side ', 'answer']
  const answer = 'side answer'
  const host = await startNdjsonHost(requestId => [
    `{"type":"text","requestId":"${requestId}","text":${JSON.stringify(first)}}\n`,
    `{"type":"text","requestId":"${requestId}","text":${JSON.stringify(second)}}\n`,
    // Deliberately NO trailing newline: the tail of the stream is still a frame.
    `{"type":"done","requestId":"${requestId}","answer":${JSON.stringify(answer)}}`,
  ], [12, 20, 30, 40])
  t.after(() => host.close())
  const transport = await connectRealTransport(host.url)
  t.after(() => transport.close())

  // Fixture self-check: a raw reader must really see the stream in pieces, or the
  // split-frame property below would be untested. (Kept independent of the
  // transport so the assertion is about the wire, not about our own framing.)
  const probe = await fetch(`${host.url}/api/side.query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'probe', requestId: 'probe', prompt: 'p', stream: true }),
  })
  const reader = probe.body!.getReader()
  const chunkSizes: number[] = []
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    chunkSizes.push(next.value.byteLength)
  }
  assert.ok(
    chunkSizes.length >= 3,
    `fixture did not split the NDJSON stream across chunks: ${JSON.stringify(chunkSizes)}`,
  )

  const runner = createDshGoIndependentSideQueryRunner(transport)
  const deltas: string[] = []
  const settled = await runner.run({
    sessionId: 'session-a',
    prompt: 'recap this',
    stream: true,
    signal: new AbortController().signal,
    onText: delta => { deltas.push(delta) },
  })
  assert.equal(settled, answer)
  assert.deepEqual(deltas, [first, second])
  for (const delta of deltas) {
    assert.equal(delta.includes('{'), false)
    assert.equal(delta.includes('requestId'), false)
  }
})

test('a real host that does not confirm side.close makes close() fail loudly', async t => {
  const host = await startNdjsonHost(() => [], [], { confirmClose: false })
  t.after(() => host.close())
  const transport = await connectRealTransport(host.url)
  t.after(() => transport.close())

  const runner = createDshGoIndependentSideQueryRunner(transport)
  await assert.rejects(runner.close('session-a'), /dsh-go: side\.close returned an invalid result/)
})
