import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import {
  DshGoLaunch,
  DshGoTransportError,
  type ServerFrame,
  type SessionLoad,
} from '../../src/transport.js'

type ApiReply = {
  readonly status?: number
  readonly json?: unknown
  readonly raw?: string
  readonly chunks?: readonly Buffer[]
  readonly contentType?: string
}

type ApiHandler = (method: string, body: unknown, raw: string) => ApiReply | Promise<ApiReply>

interface ApiRequest {
  readonly method: string
  readonly body: unknown
  readonly raw: string
  readonly cookie: string | undefined
}

interface ControlFrame {
  readonly raw: string
  readonly t: string | undefined
  readonly topic: string | undefined
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function frame(seq: number, type = 'test/event'): ServerFrame {
  return { seq, type, data: { seq }, time: 1_700_000_000_000 + seq }
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

class Peer {
  readonly controls: ControlFrame[] = []
  sessionId: string | undefined

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data: RawData) => {
      const raw = data.toString()
      const value = record(JSON.parse(raw))
      const control: ControlFrame = {
        raw,
        t: typeof value.t === 'string' ? value.t : undefined,
        topic: typeof value.topic === 'string' ? value.topic : undefined,
      }
      this.controls.push(control)
      if (control.t === 'sub' && control.topic?.startsWith('session:') === true) {
        this.sessionId = control.topic.slice('session:'.length)
      }
    })
  }

  send(value: unknown): void {
    this.socket.send(JSON.stringify(value))
  }

  sendRaw(raw: string): void {
    this.socket.send(raw)
  }

  drop(): void {
    this.socket.terminate()
  }
}

class Fixture {
  readonly apiRequests: ApiRequest[] = []
  readonly peers: Peer[] = []
  connectCalls = 0
  rejectUpgrades = 0

  private readonly server = createServer((request, response) => {
    void this.handleHttp(request, response).catch(error => {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(error instanceof Error ? error.message : String(error))
    })
  })

  private readonly wss = new WebSocketServer({ noServer: true })
  private baseUrl = ''

  constructor(private readonly api: ApiHandler) {
    this.server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/ws' || request.headers.cookie !== 'dshd_session=test-cookie') {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      if (this.rejectUpgrades > 0) {
        this.rejectUpgrades--
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(request, socket, head, websocket => {
        this.wss.emit('connection', websocket, request)
      })
    })
    this.wss.on('connection', (socket: WebSocket) => {
      this.peers.push(new Peer(socket))
    })
  }

  get url(): string {
    return this.baseUrl
  }

  latestPeer(sessionId: string): Peer | undefined {
    return this.peers.filter(peer => peer.sessionId === sessionId).at(-1)
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    for (const peer of this.peers) peer.socket.terminate()
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
    await new Promise<void>(resolve => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/connect') {
      this.connectCalls++
      if (url.searchParams.get('token') !== 'launch-secret' || this.connectCalls !== 1) {
        this.reply(response, {
          status: 401,
          json: { error: { code: 'unauthorized', message: 'token used', hint: 'relaunch', retryable: false } },
        })
        return
      }
      response.writeHead(303, {
        location: '/',
        'set-cookie': 'dshd_session=test-cookie; Path=/; HttpOnly; SameSite=Strict',
        'cache-control': 'no-store',
      })
      response.end()
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      this.reply(response, { status: 404, json: { error: { code: 'not_found', message: 'missing', hint: 'path', retryable: false } } })
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    const body: unknown = raw === '' ? undefined : JSON.parse(raw)
    const method = url.pathname.slice('/api/'.length)
    const cookie = request.headers.cookie
    this.apiRequests.push({ method, body, raw, cookie })
    if (cookie !== 'dshd_session=test-cookie') {
      this.reply(response, {
        status: 401,
        json: { error: { code: 'unauthorized', message: 'cookie required', hint: 'connect', retryable: false } },
      })
      return
    }
    this.reply(response, await this.api(method, body, raw))
  }

  private reply(response: ServerResponse, reply: ApiReply): void {
    if (reply.chunks !== undefined) {
      response.writeHead(reply.status ?? 200, { 'content-type': reply.contentType ?? 'application/x-ndjson' })
      for (const chunk of reply.chunks) response.write(chunk)
      response.end()
      return
    }
    const raw = reply.raw ?? JSON.stringify(reply.json ?? {})
    response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
    response.end(raw)
  }
}

test('ready line, one-shot connect cookie, bare HTTP params and four-field errors', async t => {
  const fixture = new Fixture((method, body) => {
    if (method === 'session.echo') return { json: { result: { echo: body } } }
    if (method === 'session.fail') {
      return {
        status: 409,
        json: { error: { code: 'conflict', message: 'not applied', hint: 'reload first', retryable: false } },
      }
    }
    throw new Error(`unexpected method ${method}`)
  })
  await fixture.start()
  t.after(() => fixture.stop())

  assert.throws(
    () => new DshGoLaunch(`transport: ready ${JSON.stringify({ url: fixture.url, token: 'launch-secret' })}`),
    /ready/,
  )
  const launch = new DshGoLaunch(`ready ${JSON.stringify({ url: fixture.url, token: 'launch-secret' })}`)
  const transport = await launch.connect()
  t.after(() => transport.close())
  await assert.rejects(launch.connect(), /already consumed/)
  assert.equal(fixture.connectCalls, 1)

  const params = { text: 'hello', nested: { n: 2 } }
  const result = await transport.call<{ echo: unknown }>('session.echo', params)
  assert.deepEqual(result, { echo: params })
  const echo = fixture.apiRequests.find(request => request.method === 'session.echo')
  assert.equal(echo?.raw, JSON.stringify(params))
  assert.equal(echo?.cookie, 'dshd_session=test-cookie')
  assert.equal('params' in record(echo?.body), false)

  await assert.rejects(transport.call('session.fail', {}), (error: unknown) => {
    if (!(error instanceof DshGoTransportError)) return false
    assert.equal(error.code, 'conflict')
    assert.equal(error.message, 'not applied')
    assert.equal(error.hint, 'reload first')
    assert.equal(error.retryable, false)
    assert.equal(error.status, 409)
    return true
  })
})

test('WS ping/sub/unsub, gap history, replay-live dedupe, bounded reconnect and A/B watermarks', async t => {
  const fixture = new Fixture(async (method, body) => {
    const params = record(body)
    if (method === 'session.load') {
      const a = params.id === 'A'
      return { json: { result: { messages: [], journalEpoch: a ? 101 : 201, lastSeq: a ? 1 : 7 } } }
    }
    if (method === 'session.history') {
      assert.equal(params.id, 'A')
      const peer = fixture.latestPeer('A')
      assert.ok(peer)
      peer.send(frame(4))
      return {
        json: {
          result: {
            journalEpoch: 101,
            lastSeq: 4,
            frames: [frame(2), frame(3), frame(4)],
          },
        },
      }
    }
    throw new Error(`unexpected method ${method}`)
  })
  await fixture.start()
  t.after(() => fixture.stop())
  const launch = new DshGoLaunch(`ready ${JSON.stringify({ url: fixture.url, token: 'launch-secret' })}`)
  const transport = await launch.connect({ reconnectInitialMs: 20, reconnectMaxMs: 80 })
  t.after(() => transport.close())

  const aFrames: ServerFrame[] = []
  const bFrames: ServerFrame[] = []
  const reconnectDelays: number[] = []
  const a = await transport.openSession('A', {
    onFrame: value => { aFrames.push(value) },
    onReconnect: delay => { reconnectDelays.push(delay) },
  })
  const b = await transport.openSession('B', {
    onFrame: value => { bFrames.push(value) },
  })
  await waitUntil(() => fixture.latestPeer('A')?.controls.some(control => control.t === 'sub') === true, 'A sub')
  await waitUntil(() => fixture.latestPeer('B')?.controls.some(control => control.t === 'sub') === true, 'B sub')
  const firstA = fixture.latestPeer('A')!
  const firstB = fixture.latestPeer('B')!
  assert.equal(
    firstA.controls.find(control => control.t === 'sub')?.raw,
    '{"t":"sub","topic":"session:A","sinceSeq":1,"journalEpoch":101}',
  )
  assert.equal(
    firstB.controls.find(control => control.t === 'sub')?.raw,
    '{"t":"sub","topic":"session:B","sinceSeq":7,"journalEpoch":201}',
  )

  firstA.send({ seq: 0, type: 'approval/request', data: { requestId: 'pending-a' }, time: 1_700_000_000_000 })
  await waitUntil(() => aFrames.length === 1, 'seq=0 delivery')
  assert.equal(a.session.lastSeq, 1)

  firstA.send(frame(1))
  firstA.send(frame(3))
  await waitUntil(() => aFrames.length === 4, 'history and buffered live delivery')
  firstA.send(frame(5))
  await waitUntil(() => aFrames.length === 5, 'post-gap live delivery')
  assert.deepEqual(aFrames.map(value => value.seq), [0, 2, 3, 4, 5])
  const history = fixture.apiRequests.find(request => request.method === 'session.history')
  assert.equal(history?.raw, '{"id":"A","sinceSeq":1,"limit":256,"journalEpoch":101}')
  assert.equal(a.session.lastSeq, 5)
  assert.equal(b.session.lastSeq, 7)

  await a.session.ping()
  await waitUntil(() => firstA.controls.some(control => control.t === 'ping'), 'ping')
  firstA.sendRaw('{"type":"pong","time":1700000000000}')
  firstA.send(frame(6))
  await waitUntil(() => aFrames.length === 6, 'frame after pong')
  assert.equal(a.session.lastSeq, 6)
  assert.equal(aFrames.some(value => value.type === 'pong'), false)

  assert.deepEqual(reconnectDelays, [])
  fixture.rejectUpgrades = 2
  firstA.drop()
  await waitUntil(() => {
    const peer = fixture.latestPeer('A')
    return peer !== undefined && peer !== firstA && peer.controls.some(control => control.t === 'sub')
  }, 'A reconnect after two refused upgrades')
  const secondA = fixture.latestPeer('A')!
  assert.deepEqual([...reconnectDelays], [20, 40, 80])
  assert.equal(fixture.connectCalls, 1)
  assert.equal(
    secondA.controls.find(control => control.t === 'sub')?.raw,
    '{"t":"sub","topic":"session:A","sinceSeq":6,"journalEpoch":101}',
  )
  secondA.send(frame(6))
  secondA.send(frame(7))
  firstB.send(frame(8))
  await waitUntil(() => aFrames.length === 7 && bFrames.length === 1, 'A/B independent live frames')
  assert.deepEqual(aFrames.map(value => value.seq), [0, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(bFrames.map(value => value.seq), [8])
  assert.equal(a.session.lastSeq, 7)
  assert.equal(b.session.lastSeq, 8)
  assert.equal(fixture.latestPeer('B'), firstB)

  await a.session.dispose()
  await waitUntil(() => secondA.controls.some(control => control.t === 'unsub'), 'A unsub')
  assert.equal(
    secondA.controls.find(control => control.t === 'unsub')?.raw,
    '{"t":"unsub","topic":"session:A"}',
  )
})

test('stale_epoch and session/reset reload exact 63-bit epochs and rebase without stale delivery', async t => {
  const epochs = ['9223372036854775001', '9223372036854775003', '9223372036854775005']
  const watermarks = [2, 9, 12]
  let loadCalls = 0
  let historyCalls = 0
  const fixture = new Fixture(method => {
    if (method === 'session.load') {
      const index = loadCalls++
      return {
        raw: `{"result":{"messages":[{"text":"baseline-${index}"}],"journalEpoch":${epochs[index]},"lastSeq":${watermarks[index]}}}`,
      }
    }
    if (method === 'session.history') {
      historyCalls++
      return {
        status: 409,
        raw: `{"error":{"code":"stale_epoch","message":"old epoch","hint":"reload","retryable":true},"journalEpoch":${epochs[1]},"lastSeq":9}`,
      }
    }
    throw new Error(`unexpected method ${method}`)
  })
  await fixture.start()
  t.after(() => fixture.stop())
  const launch = new DshGoLaunch(`ready ${JSON.stringify({ url: fixture.url, token: 'launch-secret' })}`)
  const transport = await launch.connect()
  t.after(() => transport.close())

  const frames: ServerFrame[] = []
  const resets: { baseline: SessionLoad; trigger: string }[] = []
  const opened = await transport.openSession('A', {
    onFrame: value => { frames.push(value) },
    onReset: (baseline, trigger) => { resets.push({ baseline, trigger }) },
  })
  assert.equal(opened.session.journalEpoch, epochs[0])
  await waitUntil(() => fixture.latestPeer('A')?.controls.some(control => control.t === 'sub') === true, 'initial 63-bit sub')
  const peer = fixture.latestPeer('A')!
  assert.equal(
    peer.controls[0]?.raw,
    `{"t":"sub","topic":"session:A","sinceSeq":2,"journalEpoch":${epochs[0]}}`,
  )

  peer.send(frame(4))
  await waitUntil(() => resets.length === 1, 'stale_epoch rebase')
  await waitUntil(() => peer.controls.some(control => control.raw.includes(`"journalEpoch":${epochs[1]}`)), 'rebased sub')
  assert.equal(resets[0]?.trigger, 'stale_epoch')
  assert.equal(resets[0]?.baseline.journalEpoch, epochs[1])
  assert.equal(opened.session.lastSeq, 9)
  assert.equal(frames.length, 0)
  assert.equal(
    fixture.apiRequests.find(request => request.method === 'session.history')?.raw,
    `{"id":"A","sinceSeq":2,"limit":256,"journalEpoch":${epochs[0]}}`,
  )

  peer.send(frame(10))
  await waitUntil(() => frames.length === 1, 'live frame after stale rebase')
  peer.sendRaw(`{"type":"session/reset","data":{"journalEpoch":${epochs[2]},"lastSeq":999},"time":1700000000000}`)
  await waitUntil(() => resets.length === 2, 'session/reset rebase')
  await waitUntil(() => peer.controls.some(control => control.raw.includes(`"journalEpoch":${epochs[2]}`)), 'second rebased sub')
  assert.equal(resets[1]?.trigger, 'session/reset')
  assert.equal(resets[1]?.baseline.journalEpoch, epochs[2])
  assert.equal(opened.session.lastSeq, 12)
  assert.equal(
    peer.controls.at(-1)?.raw,
    `{"t":"sub","topic":"session:A","sinceSeq":12,"journalEpoch":${epochs[2]}}`,
  )

  peer.send(frame(13))
  await waitUntil(() => frames.length === 2, 'live frame after reset rebase')
  assert.deepEqual(frames.map(value => value.seq), [10, 13])
  assert.equal(opened.session.lastSeq, 13)
  assert.equal(loadCalls, 3)
  assert.equal(historyCalls, 1)
})

test('dispose while gap history is in flight suppresses late delivery', async t => {
  let notifyHistoryStarted!: () => void
  let releaseHistory!: () => void
  const historyStarted = new Promise<void>(resolve => { notifyHistoryStarted = resolve })
  const historyReleased = new Promise<void>(resolve => { releaseHistory = resolve })
  const fixture = new Fixture(async method => {
    if (method === 'session.load') return { json: { result: { messages: [], journalEpoch: 1, lastSeq: 1 } } }
    if (method === 'session.history') {
      notifyHistoryStarted()
      await historyReleased
      return { json: { result: { journalEpoch: 1, lastSeq: 3, frames: [frame(2), frame(3)] } } }
    }
    throw new Error(`unexpected method ${method}`)
  })
  await fixture.start()
  t.after(() => fixture.stop())
  const launch = new DshGoLaunch(`ready ${JSON.stringify({ url: fixture.url, token: 'launch-secret' })}`)
  const transport = await launch.connect()
  t.after(() => transport.close())
  const frames: ServerFrame[] = []
  const opened = await transport.openSession('A', {
    onFrame: value => { frames.push(value) },
  })
  await waitUntil(() => fixture.latestPeer('A')?.controls.some(control => control.t === 'sub') === true, 'dispose-race sub')
  const peer = fixture.latestPeer('A')!
  peer.send(frame(3))
  await historyStarted
  await opened.session.dispose()
  releaseHistory()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(frames.length, 0)
  assert.equal(opened.session.lastSeq, 1)
})

test('concurrent dispose calls share the socket-close completion barrier', async t => {
  const fixture = new Fixture(method => {
    if (method === 'session.load') return { json: { result: { messages: [], journalEpoch: 1, lastSeq: 0 } } }
    throw new Error(`unexpected method ${method}`)
  })
  await fixture.start()
  t.after(() => fixture.stop())
  const launch = new DshGoLaunch(`ready ${JSON.stringify({ url: fixture.url, token: 'launch-secret' })}`)
  const transport = await launch.connect()
  t.after(() => transport.close())
  const opened = await transport.openSession('A', { onFrame: () => undefined })
  await waitUntil(() => fixture.latestPeer('A')?.controls.some(control => control.t === 'sub') === true, 'dispose-barrier sub')
  const peer = fixture.latestPeer('A')!
  peer.socket.pause()
  let secondSettled = false
  const first = opened.session.dispose()
  const second = opened.session.dispose().then(() => { secondSettled = true })
  await new Promise(resolve => setTimeout(resolve, 50))
  const settledBeforeClose = secondSettled
  peer.socket.resume()
  await Promise.all([first, second])
  assert.equal(settledBeforeClose, false)
})

test('real empty load omits lastSeq under Go omitempty and subscribes from zero', async t => {
  const fixture = new Fixture(method => {
    if (method === 'session.load') return { raw: '{"result":{"messages":[],"total":0,"truncated":false,"journalEpoch":9223372036854775001}}' }
    throw new Error(`unexpected method ${method}`)
  })
  await fixture.start()
  t.after(() => fixture.stop())
  const launch = new DshGoLaunch(`ready ${JSON.stringify({ url: fixture.url, token: 'launch-secret' })}`)
  const transport = await launch.connect()
  t.after(() => transport.close())
  const opened = await transport.openSession('empty', { onFrame: () => undefined })
  assert.equal(opened.baseline.lastSeq, 0)
  assert.equal(opened.session.lastSeq, 0)
  await waitUntil(() => fixture.latestPeer('empty')?.controls.some(control => control.t === 'sub') === true, 'empty-load sub')
  assert.equal(
    fixture.latestPeer('empty')?.controls.find(control => control.t === 'sub')?.raw,
    '{"t":"sub","topic":"session:empty","sinceSeq":0,"journalEpoch":9223372036854775001}',
  )
})


/**
 * T3 port addition (taskbook §5.3 T3 先红 ①/②; 0.18 has no equivalent test):
 *
 *   ① a 63-bit `journalEpoch` must round-trip as **text** — `Number` silently
 *      turns 9007199254740993 into 9007199254740992;
 *   ② the one-shot `/connect` credential is the only source of the session
 *      cookie, so a response without `dshd_session` must fail *before* any
 *      `/api` request goes out bearing an empty credential.
 */
test('a 63-bit journalEpoch round-trips as exact text through load and sub', async t => {
  const epoch63 = '9007199254740993'
  const fixture = new Fixture(method => {
    if (method === 'session.load') {
      return {
        raw: `{"result":{"messages":[],"total":0,"truncated":false,"journalEpoch":${epoch63},"lastSeq":1}}`,
      }
    }
    throw new Error(`unexpected method ${method}`)
  })
  await fixture.start()
  t.after(() => fixture.stop())
  const launch = new DshGoLaunch(`ready ${JSON.stringify({ url: fixture.url, token: 'launch-secret' })}`)
  const transport = await launch.connect()
  t.after(() => transport.close())

  const opened = await transport.openSession('A', { onFrame: () => undefined })
  assert.equal(opened.baseline.journalEpoch, epoch63, 'baseline journalEpoch must stay text')
  assert.equal(opened.session.journalEpoch, epoch63, 'session journalEpoch must stay text')
  await waitUntil(() => fixture.latestPeer('A')?.controls.some(control => control.t === 'sub') === true, 'text epoch sub')
  assert.equal(
    fixture.latestPeer('A')?.controls.find(control => control.t === 'sub')?.raw,
    `{"t":"sub","topic":"session:A","sinceSeq":1,"journalEpoch":${epoch63}}`,
  )
})

test('connect without a dshd_session cookie fails before any API call', async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  try {
    const launch = new DshGoLaunch(
      `ready ${JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: 'launch-secret' })}`,
    )
    await assert.rejects(launch.connect(), /dshd_session/u)
    assert.deepEqual(
      requests,
      ['/connect?token=launch-secret'],
      'no /api request may be sent with an empty credential',
    )
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()) })
    server.closeAllConnections()
  }
})
