import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { BackendHost } from '../../src/types/agent/backend.js'
import type { AgentEvent } from '../../src/types/agent/events.js'
import { formatSessionRef } from '../../src/refs.js'
import { createDshGoBackend, type DshGoSupervisor } from '../../src/backend.js'
import { DshGoInitError } from '../../src/init.js'
import { DshGoLaunch, type ServerFrame } from '../../src/transport.js'
import { manifest } from '../../src/manifest.js'

const CWD = 'D:/work'

interface FixtureSession {
  readonly id: string
  title: string
  titleExplicit?: boolean
  titleSource?: 'user' | 'auto'
  color: string
  readonly cwd: string
  readonly updatedAt: string
  journalEpoch: number
  lastSeq: number
  readonly messages: { seq: number; role: string; text: string; time: number; v4Seq?: number; messageId?: string }[]
}

interface ApiRequest {
  readonly method: string
  readonly body: Record<string, unknown>
}

interface Peer {
  readonly socket: WebSocket
  sessionId?: string
  readonly controls: Record<string, unknown>[]
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function errorBody(code: string, message: string): unknown {
  return { error: { code, message, hint: `hint:${code}`, retryable: false } }
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

class TestSupervisor {
  broken = false
  private closing: Promise<void> | undefined
  private readonly exitListeners = new Set<(error: Error) => void>()

  constructor(readonly transport: Awaited<ReturnType<DshGoLaunch['connect']>>) {}

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener)
    return () => { this.exitListeners.delete(listener) }
  }

  break(): void {
    if (this.broken) return
    this.broken = true
    for (const listener of this.exitListeners) listener(new Error('fixture child exited'))
  }

  close(): Promise<void> {
    this.closing ??= this.transport.close()
    return this.closing
  }
}

class BackendFixture {
  readonly sessions = new Map<string, FixtureSession>()
  readonly api: ApiRequest[] = []
  readonly peers: Peer[] = []
  readonly supervisorCwds: string[] = []
  readonly supervisors: TestSupervisor[] = []
  createCalls = 0
  connectCalls = 0
  nextPromptId = 1
  failCancel = false
  earlyTurn = false
  /** 落点 → 该落点的 HTTP 失败（T4：证明"宿主拒绝时只能说 dropped"）。 */
  readonly promptErrors = new Map<string, { status: number; message: string }>()
  initReports: unknown[] = []
  renameWriteGate: Promise<void> | undefined
  colorWriteGate: Promise<void> | undefined
  private earlyAckResolve: (() => void) | undefined

  private readonly server = createServer((request, response) => {
    void this.handle(request, response).catch(error => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify(errorBody('fixture', error instanceof Error ? error.message : String(error))))
    })
  })
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly usedTokens = new Set<string>()
  private baseUrl = ''

  constructor() {
    this.server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/ws' || request.headers.cookie !== 'dshd_session=backend-cookie') {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(request, socket, head, websocket => {
        const peer: Peer = { socket: websocket, controls: [] }
        this.peers.push(peer)
        websocket.on('message', (data: RawData) => {
          const control = record(JSON.parse(data.toString()))
          peer.controls.push(control)
          if (control.t === 'sub' && typeof control.topic === 'string') peer.sessionId = control.topic.slice('session:'.length)
        })
      })
    })
  }

  get url(): string { return this.baseUrl }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => resolve())
    })
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    for (const peer of this.peers) peer.socket.terminate()
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
    await new Promise<void>(resolve => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  launch(cwd: string): Promise<DshGoSupervisor> {
    this.supervisorCwds.push(cwd)
    const token = `backend-token-${this.supervisorCwds.length}`
    return new DshGoLaunch(`ready ${JSON.stringify({ url: this.url, token })}`).connect({ reconnectInitialMs: 10, reconnectMaxMs: 40 }).then(transport => {
      const supervisor = new TestSupervisor(transport)
      this.supervisors.push(supervisor)
      return supervisor
    })
  }

  breakLatestSupervisor(): void {
    const supervisor = this.supervisors.at(-1)
    assert.ok(supervisor, 'no supervisor to break')
    supervisor.break()
  }

  get earlyPromptWaiting(): boolean { return this.earlyAckResolve !== undefined }

  releaseEarlyPrompt(): void {
    const release = this.earlyAckResolve
    this.earlyAckResolve = undefined
    release?.()
  }

  latestPeer(sessionId: string): Peer | undefined {
    return this.peers.filter(peer => peer.sessionId === sessionId).at(-1)
  }

  send(sessionId: string, frame: ServerFrame): void {
    const session = this.sessions.get(sessionId)
    assert.ok(session, `unknown fixture session ${sessionId}`)
    const peer = this.latestPeer(sessionId)
    assert.ok(peer, `no subscriber for ${sessionId}`)
    if (frame.seq !== undefined && frame.seq > 0) session.lastSeq = frame.seq
    const data = record(frame.data)
    if (frame.type === 'user/message' || frame.type === 'assistant/message') {
      const content = Array.isArray(data.content) ? data.content : record(data.message).content
      const blocks = Array.isArray(content) ? content : []
      const text = blocks.map(block => record(block).type === 'text' ? record(block).text : '').join('')
      session.messages.push({
        seq: session.messages.length + 1,
        role: frame.type === 'user/message' ? 'user' : 'assistant',
        text: typeof text === 'string' ? text : '',
        time: frame.time ?? 0,
        ...(typeof data.v4Seq === 'number' ? { v4Seq: data.v4Seq } : {}),
        ...(typeof data.messageId === 'string' ? { messageId: data.messageId } : {}),
      })
    }
    peer.socket.send(JSON.stringify(frame))
  }

  sendControl(sessionId: string, value: unknown): void {
    const peer = this.latestPeer(sessionId)
    assert.ok(peer, `no subscriber for ${sessionId}`)
    peer.socket.send(JSON.stringify(value))
  }

  private result(response: ServerResponse, result: unknown, status = 200): void {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(status >= 400 ? result : { result }))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/connect') {
      this.connectCalls++
      const token = url.searchParams.get('token') ?? ''
      if (!token.startsWith('backend-token-') || this.usedTokens.has(token)) {
        this.result(response, errorBody('unauthorized', 'bad or used token'), 401)
        return
      }
      this.usedTokens.add(token)
      response.writeHead(303, {
        location: '/',
        'set-cookie': 'dshd_session=backend-cookie; Path=/; HttpOnly; SameSite=Strict',
      })
      response.end()
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      this.result(response, errorBody('not_found', 'unknown path'), 404)
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = record(raw === '' ? {} : JSON.parse(raw))
    const method = url.pathname.slice('/api/'.length)
    this.api.push({ method, body })
    if (request.headers.cookie !== 'dshd_session=backend-cookie') {
      this.result(response, errorBody('unauthorized', 'cookie required'), 401)
      return
    }
    if (method === 'session.create') {
      this.createCalls++
      const id = this.createCalls === 1 ? 'A' : this.createCalls === 2 ? 'B' : `C${this.createCalls}`
      this.sessions.set(id, {
        id, title: `session-${id}`, color: '', cwd: CWD, updatedAt: '2026-11-05T09:00:00Z', journalEpoch: id === 'A' ? 101 : 201, lastSeq: 0, messages: [],
      })
      this.result(response, { sessionId: id })
      return
    }
    if (method === 'session.list') {
      this.result(response, { sessions: [...this.sessions.values()].map(session => ({
        id: session.id, title: session.title, cwd: session.cwd, updatedAt: session.updatedAt,
        ...(session.titleExplicit === undefined ? {} : { titleExplicit: session.titleExplicit }),
        ...(session.titleSource === undefined ? {} : { titleSource: session.titleSource }),
      })) })
      return
    }
    if (method === 'models.list') {
      // OwnedBy 是网关给的分组名；空串那条覆盖"没有 provider"的形状。
      this.result(response, { models: [
        { ID: 'group/deepseek-v4.1-flash1017', OwnedBy: 'magpie' },
        { id: 'snake/model', owned_by: 'snake-provider' },
        { ID: 'group/other', OwnedBy: '' },
      ] })
      return
    }
    if (method === 'session.setModel') {
      this.result(response, { ok: true })
      return
    }
    if (method === 'side.close') {
      this.result(response, { ok: true })
      return
    }
    if (method === 'session.approve') {
      this.result(response, { accepted: true, optionId: body.optionId })
      return
    }
    if (method === 'workspace.init') {
      assert.ok(this.initReports.length > 0, 'unexpected workspace.init call')
      this.result(response, this.initReports.shift())
      return
    }
    const id = typeof body.id === 'string' ? body.id : typeof body.sessionId === 'string' ? body.sessionId : ''
    const session = this.sessions.get(id)
    if (session === undefined) {
      this.result(response, errorBody('no_such_session', `missing ${id}`), 404)
      return
    }
    if (method === 'session.rename') {
      await this.renameWriteGate
      session.title = body.title as string
      session.titleExplicit = true
      session.titleSource = 'user'
      this.send(id, { seq: session.lastSeq + 1, type: 'session/title', data: { title: session.title, messageSeqs: [], source: { kind: 'user' } }, time: 20 })
      this.result(response, { id, title: session.title })
      return
    }
    if (method === 'session.color.get') {
      this.result(response, { color: session.color })
      return
    }
    if (method === 'session.color.set') {
      await this.colorWriteGate
      session.color = body.color as string
      this.send(id, { seq: session.lastSeq + 1, type: 'session/color', data: { color: session.color }, time: 21 })
      this.result(response, { color: session.color })
      return
    }
    if (method === 'session.load') {
      this.result(response, {
        messages: session.messages,
        total: session.messages.length,
        truncated: false,
        model: 'fixture-model',
        cwd: session.cwd,
        journalEpoch: session.journalEpoch,
        lastSeq: session.lastSeq,
      })
      return
    }
    if (method === 'session.prompt') {
      const requested = typeof body.placement === 'string' ? body.placement : 'turn'
      const refused = this.promptErrors.get(requested)
      if (refused !== undefined) {
        this.result(response, errorBody('busy', refused.message), refused.status)
        return
      }
      if (this.earlyTurn) {
        this.earlyTurn = false
        this.send(id, { seq: session.lastSeq + 1, type: 'turn/start', data: { turn: 1, userMessageId: 'client-early' }, time: 10 })
        this.send(id, { seq: session.lastSeq + 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 11 })
        await new Promise<void>(resolve => { this.earlyAckResolve = resolve })
      }
      this.result(response, { accepted: body.text !== 'refused', turnId: `turn-${id}-${this.nextPromptId++}` })
      return
    }
    if (method === 'session.cancel') {
      if (this.failCancel) this.result(response, errorBody('busy', 'cancel refused'), 409)
      else this.result(response, { cancelled: true })
      return
    }
    if (method === 'session.delete') {
      this.sessions.delete(id)
      this.result(response, { id, deleted: true })
      return
    }
    if (method === 'session.history') {
      this.result(response, { frames: [], journalEpoch: session.journalEpoch, lastSeq: session.lastSeq })
      return
    }
    throw new Error(`unexpected method ${method}`)
  }
}

function host(): BackendHost {
  return {
    cwd: CWD,
    locale: () => 'en',
    debug: () => undefined,
    warn: () => undefined,
  }
}

test('backend assembly performs catalog, lifecycle, events, approval, cancellation and A/B isolation', async t => {
  const fixture = new BackendFixture()
  await fixture.start()
  t.after(() => fixture.stop())
  const backend = createDshGoBackend({
    launch: cwd => fixture.launch(cwd),
    detect: async () => ({ installed: true, auth: 'unknown', version: '0.2.2' }),
  })
  assert.equal(backend.id, 'dsh-go')
  assert.equal(manifest.id, 'dsh-go')
  assert.deepEqual(manifest.capabilities, [
    'native', 'permissions', 'questions', 'pendingRetraction', 'models', 'effort', 'modes',
    'goals', 'compact', 'fork', 'rewind', 'tasks', 'subagents', 'images', 'transcript',
    'context', 'mcp', 'sideQuery', 'auth', 'rename', 'color', 'init',
  ])
  assert.deepEqual(await backend.detect(host()), { installed: true, auth: 'unknown', version: '0.2.2' })
  assert.equal(backend.launch?.resumeCommand('A'), 'dsh-tui --backend dsh-go --resume A')
  const prefs = backend.launch?.sessionPrefs(host())
  assert.equal(prefs?.lastSession(), undefined)
  prefs?.setLastSession('A')
  prefs?.touch('A')
  assert.equal(prefs?.lastSession(), 'A')
  prefs?.forget('A')
  assert.equal(prefs?.lastSession(), undefined)

  const a = await backend.open({ kind: 'create', cwd: CWD }, host())
  t.after(() => a.dispose())
  const b = await backend.open({ kind: 'create', cwd: CWD }, host())
  t.after(() => b.dispose())
  assert.equal(a.ref.sessionId, 'A')
  assert.equal(b.ref.sessionId, 'B')
  assert.equal(formatSessionRef(a.ref), 'dsh-go:A')
  assert.equal(a.cwd, CWD)
  assert.deepEqual(Object.keys(a.capabilities).sort(), [
    'auth', 'color', 'compact', 'context', 'effort', 'fork', 'goals', 'images', 'init', 'mcp', 'models', 'modes',
    'native', 'pendingRetraction', 'permissions', 'questions', 'rename', 'rewind', 'sideQuery', 'subagents', 'tasks', 'transcript',
  ])
  // 模型选择：目录来自 models.list，当前值来自 session.load；切一次必须真发
  // session.setModel 并把 current() 跟着改（否则 `/model` 显示的永远是旧值）。
  const models = a.capabilities.models
  assert.ok(models !== undefined, 'models capability must be declared')
  assert.deepEqual(models.current(), { model: 'fixture-model' })
  assert.deepEqual(await models.list(), [
    { id: 'group/deepseek-v4.1-flash1017', label: 'group/deepseek-v4.1-flash1017', provider: 'magpie' },
    { id: 'snake/model', label: 'snake/model', provider: 'snake-provider' },
    { id: 'group/other', label: 'group/other' },
  ])
  assert.deepEqual(await models.set({ model: 'group/other' }), { kind: 'switched' })
  assert.deepEqual(models.current(), { model: 'group/other' })
  assert.deepEqual(fixture.api.filter(call => call.method === 'session.setModel').map(call => call.body), [
    { id: 'A', model: 'group/other' },
  ])
  assert.equal((await a.history()).some(event => event.type === 'session.ready' && event.cwd === CWD), true)
  assert.equal((await a.history()).some(event => event.type === 'assistant.delta'), false)
  assert.deepEqual((await backend.catalog!.list({ cwd: CWD })).map(row => row.id), ['A', 'B'])
  assert.deepEqual(await backend.catalog!.list({ cwd: 'D:/other' }), [])
  assert.equal((await backend.catalog!.info!('A', CWD))?.backendId, 'dsh-go')

  const aEvents: AgentEvent[] = []
  const bEvents: AgentEvent[] = []
  const unsubscribeA = a.subscribe(batch => { aEvents.push(...batch) })
  b.subscribe(batch => { bEvents.push(...batch) })
  t.after(() => unsubscribeA())
  await waitUntil(() => fixture.latestPeer('A') !== undefined && fixture.latestPeer('B') !== undefined, 'A/B subscriptions')

  assert.deepEqual(await a.submit({ text: 'hello A', clientMessageId: 'client-a' }, 'turn'), { accepted: true })
  assert.deepEqual(await b.submit({ text: 'hello B', clientMessageId: 'client-b' }, 'turn'), { accepted: true })
  assert.deepEqual(fixture.api.filter(call => call.method === 'session.prompt').map(call => call.body), [
    { sessionId: 'A', text: 'hello A', placement: 'turn' },
    { sessionId: 'B', text: 'hello B', placement: 'turn' },
  ])
  const promptWithBlocks = await a.submit({
    text: 'hello blocks', clientMessageId: 'client-blocks', blocks: [{ type: 'text', text: 'hello blocks' }],
  }, 'followup')
  assert.equal(promptWithBlocks.accepted, true)
  assert.deepEqual(fixture.api.filter(call => call.method === 'session.prompt').at(-1)?.body, {
    sessionId: 'A', content: [{ type: 'text', text: 'hello blocks' }], placement: 'followup',
  })
  const invalidImage = {
    id: 'invalid-image', name: 'invalid.png', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    read: async () => new Uint8Array([1, 2, 3]),
  }
  await assert.rejects(
    a.submit({ text: 'image', clientMessageId: 'client-image', images: [invalidImage] }, 'turn'),
    /image bytes have no supported image signature/u,
  )

  fixture.send('A', { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'A-only' }], source: { kind: 'user' }, v4Seq: 11, messageId: 'user-a' }, time: 1 })
  fixture.send('B', { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'B-only' }], source: { kind: 'user' }, v4Seq: 21, messageId: 'user-b' }, time: 2 })
  await waitUntil(() => aEvents.some(event => event.type === 'user.message') && bEvents.some(event => event.type === 'user.message'), 'A/B user events')
  assert.equal(aEvents.some(event => JSON.stringify(event).includes('B-only')), false)
  assert.equal(bEvents.some(event => JSON.stringify(event).includes('A-only')), false)

  fixture.send('A', { seq: 2, type: 'approval/request', data: {
    requestId: 'permission-a', tool: 'bash', toolCall: { toolCallId: 'call-a', rawInput: { command: 'pwd' } },
    options: [
      { optionId: 'allow_once', name: 'once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'always', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'reject', kind: 'reject_once' },
    ],
  }, time: 3 })
  await waitUntil(() => a.capabilities.permissions?.pending().length === 1, 'A pending approval')
  assert.equal(a.status, 'requires-action')
  assert.equal(b.capabilities.permissions?.pending().length, 0)
  a.capabilities.permissions!.respond('permission-a', { kind: 'allow-once' })
  await waitUntil(() => fixture.api.some(call => call.method === 'session.approve'), 'approval HTTP call')
  assert.deepEqual(fixture.api.find(call => call.method === 'session.approve')?.body, { requestId: 'permission-a', optionId: 'allow_once' })
  await waitUntil(() => a.capabilities.permissions?.pending().length === 0, 'A approval settled')
  assert.equal(aEvents.some(event => event.type === 'permission.settled' && event.requestId === 'permission-a' && event.outcome === 'allow-once'), true)
  assert.equal(bEvents.some(event => event.type === 'permission.request'), false)

  const approvalOptions = [
    { optionId: 'allow_once', name: 'once', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'always', kind: 'allow_always' },
    { optionId: 'reject_once', name: 'reject', kind: 'reject_once' },
  ]
  fixture.send('A', { seq: 3, type: 'approval/request', data: { requestId: 'permission-a-always', tool: 'bash', options: approvalOptions }, time: 4 })
  await waitUntil(() => a.capabilities.permissions?.pending().some(request => request.requestId === 'permission-a-always') === true, 'allow-always request')
  a.capabilities.permissions!.respond('permission-a-always', { kind: 'allow-always' })
  await waitUntil(() => fixture.api.some(call => call.method === 'session.approve' && call.body.requestId === 'permission-a-always'), 'allow-always HTTP call')
  assert.deepEqual(fixture.api.find(call => call.method === 'session.approve' && call.body.requestId === 'permission-a-always')?.body, {
    requestId: 'permission-a-always', optionId: 'allow_always',
  })
  fixture.send('A', { seq: 4, type: 'approval/request', data: { requestId: 'permission-a-reject', tool: 'bash', options: approvalOptions }, time: 5 })
  await waitUntil(() => a.capabilities.permissions?.pending().some(request => request.requestId === 'permission-a-reject') === true, 'reject request')
  a.capabilities.permissions!.respond('permission-a-reject', { kind: 'reject', message: 'not safe' })
  await waitUntil(() => fixture.api.some(call => call.method === 'session.approve' && call.body.requestId === 'permission-a-reject'), 'reject HTTP call')
  assert.deepEqual(fixture.api.find(call => call.method === 'session.approve' && call.body.requestId === 'permission-a-reject')?.body, {
    requestId: 'permission-a-reject', optionId: 'reject_once',
  })
  await waitUntil(() => aEvents.some(event => event.type === 'permission.settled' && event.requestId === 'permission-a-reject' && event.outcome === 'rejected'), 'reject settled')
  assert.equal(aEvents.some(event => event.type === 'notice' && event.text.includes('feedback text is not transported')), true)

  // The durable user/message above claimed client-a; only the queued blocks remain uncovered.
  assert.deepEqual(await a.cancel('user'), { stillQueued: ['client-blocks'], outcome: 'unknown' })
  assert.equal(fixture.api.filter(call => call.method === 'session.cancel' && call.body.sessionId === 'A').length, 1)
  fixture.failCancel = true
  assert.deepEqual(await b.cancel('interrupt'), { stillQueued: [], outcome: 'failed' })
  fixture.failCancel = false

  await a.dispose()
  assert.equal(a.status, 'disposed')
  assert.equal(fixture.latestPeer('A')?.controls.some(control => control.t === 'unsub'), true)
  fixture.send('B', { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'B-after-A-dispose' }] }, v4Seq: 22 }, time: 4 })
  await waitUntil(() => bEvents.some(event => event.type === 'assistant.message'), 'B remains live')
  assert.equal(aEvents.some(event => JSON.stringify(event).includes('B-after-A-dispose')), false)

  const resumed = await backend.open({ kind: 'resume', sessionId: 'A', cwd: CWD }, host())
  t.after(() => resumed.dispose())
  assert.equal(resumed.ref.sessionId, 'A')
  const replay = await resumed.history()
  assert.equal(replay.some(event => event.type === 'user.message' && event.text === 'A-only'), true)
  assert.equal(replay.some(event => JSON.stringify(event).includes('B-only')), false)
  assert.deepEqual(await backend.catalog!.preview!('A', { cwd: CWD, limit: 1 }), [{ role: 'user', text: 'A-only', at: 1 }])

  const createsBeforeFailure = fixture.createCalls
  await assert.rejects(backend.open({ kind: 'resume', sessionId: 'missing', cwd: CWD }, host()), /missing/u)
  assert.equal(fixture.createCalls, createsBeforeFailure, 'failed resume must not create a session')

  await resumed.dispose()
  await b.dispose()
  await backend.catalog!.delete!('A', CWD)
  await backend.catalog!.delete!('B', CWD)
  assert.deepEqual(await backend.catalog!.list({ allProjects: true }), [])
  assert.equal(fixture.connectCalls, fixture.supervisorCwds.length, 'each supervisor consumes its launch token exactly once')
})

test('metadata and workspace.init capabilities use real Transport with durable A/B readback', async t => {
  const fixture = new BackendFixture()
  await fixture.start()
  t.after(() => fixture.stop())
  const backend = createDshGoBackend({ launch: cwd => fixture.launch(cwd) })
  const a = await backend.open({ kind: 'create', cwd: CWD }, host())
  const b = await backend.open({ kind: 'create', cwd: CWD }, host())
  t.after(() => Promise.all([a.dispose(), b.dispose()]).then(() => undefined))
  await a.history()
  await b.history()
  const aEvents: AgentEvent[] = []
  const bEvents: AgentEvent[] = []
  a.subscribe(batch => { aEvents.push(...batch) })
  b.subscribe(batch => { bEvents.push(...batch) })
  await waitUntil(() => fixture.latestPeer('A') !== undefined && fixture.latestPeer('B') !== undefined, 'metadata A/B subscriptions')

  const exactTitle = `  ${'长标题🐳-'.repeat(100)}  `
  await a.capabilities.rename!.rename(exactTitle)
  await b.capabilities.rename!.rename('B exact title')
  assert.deepEqual(fixture.api.filter(call => call.method === 'session.rename').map(call => call.body), [
    { id: 'A', title: exactTitle },
    { id: 'B', title: 'B exact title' },
  ])
  assert.equal(fixture.sessions.get('A')?.title, exactTitle)
  assert.equal(fixture.sessions.get('A')?.titleExplicit, true)
  assert.equal(fixture.sessions.get('A')?.titleSource, 'user')
  assert.equal(aEvents.filter(event => event.type === 'session.title' && event.title === exactTitle && event.source === 'user').length, 1)
  assert.equal(bEvents.filter(event => event.type === 'session.title' && event.title === 'B exact title').length, 1)

  a.capabilities.color!.set('red')
  b.capabilities.color!.set('blue')
  await waitUntil(() => a.capabilities.color!.current() === 'red' && b.capabilities.color!.current() === 'blue', 'A/B accent readback')
  a.capabilities.color!.set('')
  await waitUntil(() => a.capabilities.color!.current() === '', 'A accent clear')
  assert.equal(b.capabilities.color!.current(), 'blue')
  a.capabilities.color!.set('green')
  await waitUntil(() => a.capabilities.color!.current() === 'green', 'A durable non-empty accent')
  assert.deepEqual(fixture.api.filter(call => call.method === 'session.color.set').map(call => call.body), [
    { id: 'A', color: 'red' }, { id: 'B', color: 'blue' }, { id: 'A', color: '' }, { id: 'A', color: 'green' },
  ])
  assert.equal(aEvents.filter(event => event.type === 'session.color' && ['red', '', 'green'].includes(event.color)).length, 3)
  assert.equal(bEvents.filter(event => event.type === 'session.color' && event.color === 'blue').length, 1)
  assert.equal([...aEvents, ...bEvents].some(event => event.type === 'custom' && (event.nativeType === 'session/title' || event.nativeType === 'session/color')), false)

  const catalog = await backend.catalog!.list({ cwd: CWD })
  assert.deepEqual(catalog.find(row => row.id === 'A')?.title, { text: exactTitle, source: 'renamed' })
  assert.deepEqual(catalog.find(row => row.id === 'B')?.title, { text: 'B exact title', source: 'renamed' })
  await Promise.all([a.dispose(), b.dispose()])

  const resumedA = await backend.open({ kind: 'resume', sessionId: 'A', cwd: CWD }, host())
  const resumedB = await backend.open({ kind: 'resume', sessionId: 'B', cwd: CWD }, host())
  t.after(() => Promise.all([resumedA.dispose(), resumedB.dispose()]).then(() => undefined))
  const replayA = await resumedA.history()
  const replayB = await resumedB.history()
  assert.equal(replayA.find(event => event.type === 'session.ready')?.title, exactTitle)
  assert.equal(replayA.filter(event => event.type === 'session.title' && event.title === exactTitle && event.source === 'user').length, 1)
  assert.equal(replayA.filter(event => event.type === 'session.color' && event.color === 'green').length, 1)
  assert.equal(resumedA.capabilities.color!.current(), 'green')
  assert.equal(replayB.filter(event => event.type === 'session.title' && event.title === 'B exact title').length, 1)
  assert.equal(replayB.filter(event => event.type === 'session.color' && event.color === 'blue').length, 1)
  assert.equal(resumedB.capabilities.color!.current(), 'blue')

  const created = { path: 'D:/work/AGENTS.md', status: 'created' } as const
  const unchanged = { path: 'D:/work/docs/AGENTS.md', status: 'unchanged' } as const
  const failed = { path: 'D:/work/other/AGENTS.md', status: 'failed', error: 'permission denied' } as const
  fixture.initReports.push({ files: [created] }, { files: [unchanged] }, { files: [created, unchanged, failed] })
  await resumedA.capabilities.init!.run()
  await resumedA.capabilities.init!.run()
  await assert.rejects(resumedA.capabilities.init!.run(), error => {
    assert.ok(error instanceof DshGoInitError)
    assert.deepEqual(error.result, {
      ok: false,
      files: [created, unchanged, failed],
      created: [created.path],
      unchanged: [unchanged.path],
      failed: [failed],
    })
    assert.match(error.message, /created=1, unchanged=1, failed=1/u)
    assert.match(error.message, /D:\/work\/other\/AGENTS\.md: permission denied/u)
    return true
  })
  assert.deepEqual(fixture.api.filter(call => call.method === 'workspace.init').map(call => call.body), [
    { cwd: CWD }, { cwd: CWD }, { cwd: CWD },
  ])
  await Promise.all([resumedA.dispose(), resumedB.dispose()])
})

test('session dispose waits for in-flight title and color queues before closing Transport', async t => {
  const fixture = new BackendFixture()
  await fixture.start()
  t.after(() => fixture.stop())
  const backend = createDshGoBackend({ launch: cwd => fixture.launch(cwd) })
  const session = await backend.open({ kind: 'create', cwd: CWD }, host())
  t.after(() => session.dispose())
  await session.history()
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  await waitUntil(() => fixture.latestPeer('A') !== undefined, 'dispose metadata subscription')

  let releaseRename!: () => void
  let releaseColor!: () => void
  fixture.renameWriteGate = new Promise<void>(resolve => { releaseRename = resolve })
  fixture.colorWriteGate = new Promise<void>(resolve => { releaseColor = resolve })
  const renaming = session.capabilities.rename!.rename('dispose exact title')
  session.capabilities.color!.set('dispose color')
  await waitUntil(() => fixture.api.some(call => call.method === 'session.rename')
    && fixture.api.some(call => call.method === 'session.color.set'), 'in-flight metadata writes')

  let disposeCompleted = false
  const disposing = session.dispose().then(() => { disposeCompleted = true })
  await Promise.resolve()
  assert.equal(disposeCompleted, false)
  assert.equal(fixture.latestPeer('A')?.controls.some(control => control.t === 'unsub'), false)
  releaseRename()
  await renaming
  await Promise.resolve()
  assert.equal(disposeCompleted, false, 'color idle still owns the dispose barrier')
  releaseColor()
  await disposing
  assert.equal(disposeCompleted, true)
  assert.equal(fixture.latestPeer('A')?.controls.some(control => control.t === 'unsub'), true)
  assert.equal(fixture.api.filter(call => call.method === 'session.color.get').length >= 2, true)
  assert.equal(events.some(event => event.type === 'session.title' && event.title === 'dispose exact title'), false)
  assert.equal(events.some(event => event.type === 'session.color' && event.color === 'dispose color'), false)
})

test('create subscription receives the baseline ready exactly once when startup skips history', async t => {
  const fixture = new BackendFixture()
  await fixture.start()
  t.after(() => fixture.stop())
  const backend = createDshGoBackend({ launch: cwd => fixture.launch(cwd) })
  const session = await backend.open({ kind: 'create', cwd: CWD }, host())
  t.after(() => session.dispose())
  const deliveries: { events: readonly AgentEvent[]; replay: boolean }[] = []
  session.subscribe((events, meta) => { deliveries.push({ events, replay: meta.replay }) })
  await waitUntil(() => deliveries.some(delivery => delivery.events.some(event => event.type === 'session.ready')), 'fresh session.ready')
  const ready = deliveries.flatMap(delivery => delivery.events).filter(event => event.type === 'session.ready')
  assert.equal(ready.length, 1)
  assert.equal(ready[0]?.model, 'fixture-model')
  assert.equal(deliveries.find(delivery => delivery.events.includes(ready[0]!))?.replay, true)
  assert.deepEqual(await session.history(), [], 'subscribe delivery and history must be mutually exclusive')
})

test('reset retires live state before replaying the new baseline', async t => {
  const fixture = new BackendFixture()
  await fixture.start()
  t.after(() => fixture.stop())
  const backend = createDshGoBackend({ launch: cwd => fixture.launch(cwd) })
  const session = await backend.open({ kind: 'create', cwd: CWD }, host())
  t.after(() => session.dispose())
  assert.equal((await session.history()).some(event => event.type === 'session.ready'), true)
  const deliveries: { events: readonly AgentEvent[]; replay: boolean }[] = []
  session.subscribe((events, meta) => { deliveries.push({ events, replay: meta.replay }) })
  assert.equal((await session.submit({ text: 'running', clientMessageId: 'client-reset' }, 'turn')).accepted, true)
  fixture.send('A', { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'old row' }], source: { kind: 'user' }, v4Seq: 1, messageId: 'old-row' }, time: 1 })
  fixture.send('A', { seq: 2, type: 'turn/start', data: { turn: 1 }, time: 2 })
  fixture.send('A', { seq: 3, type: 'approval/request', data: {
    requestId: 'old-approval', tool: 'bash', options: [{ optionId: 'reject_once', name: 'reject', kind: 'reject_once' }],
  }, time: 3 })
  await waitUntil(() => session.capabilities.permissions?.pending().length === 1, 'old approval')
  assert.equal(session.status, 'requires-action')
  const stored = fixture.sessions.get('A')!
  stored.messages.length = 0
  stored.journalEpoch += 1_000
  stored.lastSeq = 0
  fixture.sendControl('A', { type: 'session/reset', data: { journalEpoch: stored.journalEpoch, lastSeq: 0 }, time: 4 })
  await waitUntil(() => deliveries.some(delivery => delivery.events.some(event => event.type === 'session.ready')), 'rebased ready')
  const resetIndex = deliveries.findIndex(delivery => delivery.events.some(event => event.type === 'session.reset'))
  assert.ok(resetIndex >= 0, 'live reset was delivered')
  const reset = deliveries[resetIndex]!
  assert.equal(reset.replay, false, 'session.reset must be live so Channel clears old rows')
  assert.equal(reset.events.some(event => event.type === 'permission.settled' && event.requestId === 'old-approval' && event.outcome === 'cancelled'), true)
  const replay = deliveries.slice(resetIndex + 1).find(delivery => delivery.events.some(event => event.type === 'session.ready'))
  assert.equal(replay?.replay, true, 'the new baseline is a separate replay batch')
  assert.equal(session.capabilities.permissions?.pending().length, 0)
  assert.equal(session.status, 'idle')
  assert.deepEqual(await session.cancel('user'), { stillQueued: [], outcome: 'unknown' })
})

test('turn end before the prompt ACK does not re-enter the cancel snapshot', async t => {
  const fixture = new BackendFixture()
  await fixture.start()
  t.after(() => fixture.stop())
  const backend = createDshGoBackend({ launch: cwd => fixture.launch(cwd) })
  const session = await backend.open({ kind: 'create', cwd: CWD }, host())
  t.after(() => session.dispose())
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  fixture.earlyTurn = true
  const submission = session.submit({ text: 'early', clientMessageId: 'client-early' }, 'turn')
  await waitUntil(() => fixture.earlyPromptWaiting, 'early prompt handler')
  assert.equal(session.status, 'running', 'v4 turn/end without host done remains finalizing')
  assert.equal(events.some(event => event.type === 'turn.end'), false)
  fixture.send('A', { seq: 3, type: 'turn/done', data: { turnId: 'turn-A-1' }, time: 12 })
  await waitUntil(() => events.some(event => event.type === 'turn.end'), 'host done and turn end before ACK')
  assert.equal(session.status, 'idle')
  fixture.releaseEarlyPrompt()
  assert.deepEqual(await submission, { accepted: true })
  assert.deepEqual(await session.cancel('user'), { stillQueued: [], outcome: 'unknown' })
})

test('a broken supervisor is closed, reported, and replaced on the next open', async t => {
  const fixture = new BackendFixture()
  await fixture.start()
  t.after(() => fixture.stop())
  const backend = createDshGoBackend({ launch: cwd => fixture.launch(cwd) })
  const first = await backend.open({ kind: 'create', cwd: CWD }, host())
  t.after(() => first.dispose())
  const events: AgentEvent[] = []
  first.subscribe(batch => { events.push(...batch) })
  fixture.breakLatestSupervisor()
  const second = await backend.open({ kind: 'create', cwd: CWD }, host())
  t.after(() => second.dispose())
  assert.equal(second.ref.sessionId, 'B')
  assert.equal(fixture.supervisorCwds.length, 2, 'dead runtime must not be reused')
  await waitUntil(() => events.some(event => event.type === 'notice' && event.text.includes('fixture child exited')), 'broken supervisor notice')
  assert.equal(fixture.supervisors[0]?.broken, true)
})

// ── T4 追加：三条上游没钉、但派单点名要钉的规则 ────────────────────────────────

test("submit starts a turn only with 'turn' and reports a refused placement as dropped", async t => {
  const fixture = new BackendFixture()
  await fixture.start()
  t.after(() => fixture.stop())
  const backend = createDshGoBackend({ launch: cwd => fixture.launch(cwd) })
  const session = await backend.open({ kind: 'create', cwd: CWD }, host())
  t.after(() => session.dispose())
  await session.history()

  // 空闲时只有 'turn' 开回合。
  assert.deepEqual(await session.submit({ text: 'turn text', clientMessageId: 'client-turn' }, 'turn'), { accepted: true })

  // 另三类落点必须**原样**上网（不许悄悄降级成 'turn'）；宿主拒绝时只能说
  // "这份输入没跑过"（dropped=true），让 Channel 把文本留成 held row。
  for (const placement of ['steer', 'followup', 'now'] as const) {
    fixture.promptErrors.set(placement, { status: 409, message: `dshd refused ${placement}: busy` })
    assert.deepEqual(
      await session.submit({ text: placement, clientMessageId: `client-${placement}` }, placement),
      { accepted: false, reason: `dshd refused ${placement}: busy`, dropped: true },
    )
  }
  fixture.promptErrors.clear()
  assert.deepEqual(
    fixture.api.filter(call => call.method === 'session.prompt').map(call => call.body.placement),
    ['turn', 'steer', 'followup', 'now'],
  )

  // 已 dispose 的会话在**发 HTTP 之前**就拒绝，且同样带 dropped=true。
  await session.dispose()
  const promptsBefore = fixture.api.filter(call => call.method === 'session.prompt').length
  assert.deepEqual(await session.submit({ text: 'late', clientMessageId: 'client-late' }, 'turn'), {
    accepted: false,
    reason: 'dsh-go: session is disposed',
    dropped: true,
  })
  assert.equal(fixture.api.filter(call => call.method === 'session.prompt').length, promptsBefore)
})

test('D-2: the session capability key set is a subset of the manifest declaration', async t => {
  const fixture = new BackendFixture()
  await fixture.start()
  t.after(() => fixture.stop())
  const backend = createDshGoBackend({ launch: cwd => fixture.launch(cwd) })
  const session = await backend.open({ kind: 'create', cwd: CWD }, host())
  t.after(() => session.dispose())

  const runtime = Object.keys(session.capabilities)
  const declared = [...(manifest.capabilities ?? [])]
  // 声明必须**覆盖**运行时实际服务的键集：多一个运行时键就是"没声明却服务"。
  assert.deepEqual(runtime.filter(key => !declared.includes(key)), [])
  assert.equal(runtime.includes('transcript'), true, 'the declared transcript capability is served')
  assert.equal(declared.includes('channels'), false, 'we do not serve the channels surface')
})
