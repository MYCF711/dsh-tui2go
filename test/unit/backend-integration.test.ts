import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import type { AgentEvent, ContentBlockView, ImageRef } from '../../src/types/agent/events.js'
import type { AgentInput } from '../../src/types/agent/session.js'
import type { BackendHost } from '../../src/types/agent/backend.js'
import { createDshGoBackend } from '../../src/backend.js'
import { createDshGoEventTranslator, type DshGoLoadMessage, type DshGoLoadResult, type DshGoServerFrame } from '../../src/events.js'
import { DshGoInitError } from '../../src/init.js'
import { manifest } from '../../src/manifest.js'
import type { DshGoLoadToolMessage } from '../../src/view-spec.js'
import type { DshGoSideQueryRequest, DshGoTransport, ServerFrame, SessionCallbacks, SessionLoad, SessionTransport } from '../../src/transport.js'

const CWD = 'D:/work'
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII='
const PNG = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'))
const ATTACHMENT_ID = `att-${'a'.repeat(32)}`
const ATTACHMENT = {
  id: ATTACHMENT_ID,
  name: 'pixel.png',
  byteSize: PNG.byteLength,
  mime: 'image/png',
  sha256: createHash('sha256').update(PNG).digest('hex'),
  width: 1,
  height: 1,
}
const ATTACHMENT_BLOCK = { type: 'attachment', attachmentId: ATTACHMENT_ID, ...ATTACHMENT }
const GOAL = { id: 'goal-a', revision: 2, objective: 'wire the backend', phase: 'active', maxGoalRounds: 4 } as const

interface Call {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function baseline(messages: readonly DshGoLoadMessage[] = []): SessionLoad {
  return {
    messages,
    total: messages.length,
    truncated: false,
    model: 'model-a',
    cwd: CWD,
    permission: 'ask',
    effort: 'low',
    effortSelection: 'high',
    contextTokens: 123,
    contextWindow: 1000,
    journalEpoch: '7',
    lastSeq: 0,
  }
}

function defaultMessages(): readonly DshGoLoadToolMessage[] {
  return [
    {
      seq: 1, role: 'user', text: 'BEFORE', time: 1, v4Seq: 1, messageId: 'user-a',
      content: [{ type: 'text', text: 'BEFORE' }, ATTACHMENT_BLOCK, { type: 'text', text: 'AFTER' }],
    },
    {
      seq: 2, role: 'tool', text: 'loaded result', callId: 'call-load', turn: 1, step: 2, time: 2,
      view: { kind: 'plain', body: 'loaded view' },
    },
    { seq: 3, role: 'assistant', text: 'done', time: 3, v4Seq: 3 },
  ]
}

function directLoad(journalEpoch: number | string, messages: readonly DshGoLoadMessage[] = []): DshGoLoadResult {
  return { messages, total: messages.length, truncated: false, journalEpoch, lastSeq: 0 }
}

class IntegrationHost {
  readonly calls: Call[] = []
  readonly transport: DshGoTransport
  readonly job = { id: 'job-1', sessionId: 'A', command: 'run-integration', done: false, exit_code: 0, bytes: 12 }
  readonly output = 'job ✅ output'
  pages: { messages: readonly DshGoLoadMessage[]; hasOlder: boolean; nextCursor?: string }[] = []
  sideQueryHandler?: (request: DshGoSideQueryRequest) => Promise<string | null>
  title = 'seeded title'
  color = 'cyan'
  activeModel = 'model-a'
  catalogError?: Error
  initReports: unknown[] = []
  closed = false
  sessionDisposed = false
  stagingPath = ''
  hostTurnReady = true
  private callbacks: SessionCallbacks | undefined
  private configured = false

  constructor(readonly load: SessionLoad = baseline(defaultMessages())) {
    this.transport = {
      call: <T = unknown>(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<T> =>
        this.invoke(method, params) as Promise<T>,
      sideQuery: (request: DshGoSideQueryRequest): Promise<string | null> => {
        this.calls.push({ method: 'side.query', params: {
          id: request.id, requestId: request.requestId, prompt: request.prompt, stream: request.stream,
        } })
        if (this.sideQueryHandler !== undefined) return this.sideQueryHandler(request)
        if (request.stream) {
          request.onText('side ')
          request.onText('answer')
          return Promise.resolve('side answer')
        }
        return Promise.resolve('whole answer')
      },
      openSession: async (sessionId: string, callbacks: SessionCallbacks) => {
        this.callbacks = callbacks
        const session: SessionTransport = {
          sessionId,
          journalEpoch: String(this.load.journalEpoch),
          lastSeq: this.load.lastSeq,
          ping: async () => undefined,
          dispose: async () => { this.sessionDisposed = true },
        }
        return { baseline: this.load, session }
      },
      close: async () => { this.closed = true },
    } as unknown as DshGoTransport
  }

  frame(frame: ServerFrame): void {
    assert.ok(this.callbacks, 'session is open')
    this.callbacks.onFrame(frame)
  }

  reset(): void {
    assert.ok(this.callbacks?.onReset, 'session reset callback is open')
    this.callbacks.onReset(this.load, 'session/reset')
  }

  private catalog(): unknown {
    return {
      models: [
        { id: 'model-a', apiKeyEnv: 'KEY_A', reasoningEfforts: { low: 'LOW', high: 'HIGH' } },
        { id: 'model-b', apiKeyEnv: 'KEY_B', reasoningEfforts: { low: 'low' } },
      ],
      credentials: {
        KEY_A: { configured: false, writable: true },
        KEY_B: { configured: this.configured, writable: true },
      },
      active: { id: this.activeModel, revision: 0 },
    }
  }

  private async invoke(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.calls.push({ method, params })
    if (method === 'session.create') return { sessionId: 'A' }
    if (method === 'workspace.resolve') return { workspace: undefined }
    if (method === 'workspace.create') return { workspace: { workspaceId: 'w', path: String(params.request?.path ?? ''), title: 'w' } }
    if (method === 'session.load') return this.load
    if (method === 'session.setPermission') { this.load = { ...this.load, permission: params.permission as string }; return { ok: true } }
    if (method === 'session.list') {
      return { sessions: [{ id: 'A', title: this.title, titleExplicit: true, titleSource: 'user', cwd: CWD, updatedAt: '2026-11-06T00:00:00Z' }] }
    }
    if (method === 'session.rename') {
      this.title = params.title as string
      return { id: 'A', title: this.title }
    }
    if (method === 'session.color.get') return { color: this.color }
    if (method === 'session.color.set') {
      this.color = params.color as string
      return { color: this.color }
    }
    if (method === 'workspace.init') {
      assert.ok(this.initReports.length > 0, 'unexpected workspace.init call')
      return this.initReports.shift()
    }
    if (method === 'session.goal.get') return { goal: GOAL, roundsStarted: 1 }
    if (method === 'models.catalog.list') {
      if (this.catalogError !== undefined) throw this.catalogError
      return this.catalog()
    }
    if (method === 'models.list') return { models: [{ id: 'model-a' }, { id: 'model-b' }] }
    if (method === 'jobs.list') return { jobs: [{ ...this.job }] }
    if (method === 'jobs.output') {
      const cursor = params.cursor
      const limit = params.limit
      assert.equal(typeof cursor, 'number')
      assert.equal(typeof limit, 'number')
      const runes = Array.from(this.output)
      const start = cursor as number
      const count = limit as number
      const output = runes.slice(start, start + count).join('')
      const nextCursor = start + Array.from(output).length
      return {
        id: 'job-1', sessionId: 'A', output, done: this.job.done, exit_code: this.job.exit_code,
        cursor: start, nextCursor, total: runes.length, hasMore: nextCursor < runes.length, truncated: false,
      }
    }
    if (method === 'jobs.stop') {
      this.job.done = true
      return { id: 'job-1', sessionId: 'A', stopped: true, done: true, exit_code: 0 }
    }
    if (method === 'attachment.put') {
      const path = params.path
      assert.equal(typeof path, 'string')
      this.stagingPath = path as string
      assert.deepEqual(new Uint8Array(readFileSync(this.stagingPath)), PNG)
      return { attachment: ATTACHMENT }
    }
    if (method === 'attachment.get') {
      assert.deepEqual(params, { id: ATTACHMENT_ID })
      return { attachment: ATTACHMENT, dataBase64: PNG_BASE64 }
    }
    if (method === 'session.prompt') {
      if (params.placement === 'turn' && !this.hostTurnReady) return { accepted: false }
      if (params.placement === 'turn') this.hostTurnReady = false
      return { accepted: true, turnId: 'turn-a' }
    }
    if (method === 'session.fork') {
      return { sessionId: 'forked-a', ...(params.anchor === undefined ? {} : { anchor: params.anchor }), ...(params.title === undefined ? {} : { title: params.title }) }
    }
    if (method === 'session.rewind.preview') return { filesChanged: ['src/a.ts'], insertions: 2, deletions: 1 }
    if (method === 'session.rewind.apply') {
      return { kind: 'rewound', sessionId: 'A', files: { filesChanged: ['src/a.ts'], insertions: 2, deletions: 1 } }
    }
    if (method === 'context.usage') {
      return { used: 123, max: 1000, categories: [{ name: 'messages', tokens: 123, kind: 'used' }], sections: [{ name: 'system', tokens: 10 }] }
    }
    if (method === 'mcp.list') return { servers: [{ name: 'docs', status: 'connected', toolCount: 2 }] }
    if (method === 'models.catalog.upsert') {
      this.configured = params.credential !== ''
      return this.catalog()
    }
    if (method === 'session.transcript.page') {
      const page = this.pages.shift()
      assert.ok(page, 'unexpected transcript.page call')
      return page
    }
    if ([
      'session.setEffort', 'session.setPermission', 'session.setGoal', 'session.goal.pause',
      'session.goal.resume', 'session.setModel', 'mcp.reconnect', 'mcp.toggle', 'side.cancel', 'side.close',
    ].includes(method)) return { ok: true }
    throw new Error(`unexpected method ${method}`)
  }
}

function host(): BackendHost {
  return { cwd: CWD, locale: () => 'en', debug: () => undefined, warn: () => undefined }
}

function backendFor(fixture: IntegrationHost) {
  return createDshGoBackend({
    launch: async () => ({
      transport: fixture.transport,
      close: async () => { fixture.closed = true },
    }),
  })
}

function eventsOf<T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T) {
  return events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)
}

test('backend integrates durable capabilities, image submission, event owners and auth questions', async t => {
  const fixture = new IntegrationHost()
  const session = await backendFor(fixture).open({ kind: 'create', cwd: CWD }, host())
  t.after(() => session.dispose())
  const history = await session.history()

  assert.deepEqual(Object.keys(session.capabilities).sort(), [
    'auth', 'color', 'compact', 'context', 'effort', 'fork', 'goals', 'images', 'init', 'mcp', 'models', 'modes',
    'native', 'pendingRetraction', 'permissions', 'questions', 'rename', 'rewind', 'sideQuery', 'subagents', 'tasks', 'transcript', 'workspace',
  ])
  for (const present of ['mcp', 'sideQuery', 'rename', 'color', 'init']) assert.equal(manifest.capabilities?.includes(present), true)

  const ready = eventsOf(history, 'session.ready')[0]
  assert.equal(ready?.permissionMode, 'ask')
  assert.equal(ready?.effort, 'high')
  assert.equal(ready?.title, 'seeded title')
  assert.equal(eventsOf(history, 'session.title')[0]?.title, 'seeded title')
  assert.equal(eventsOf(history, 'session.color')[0]?.color, 'cyan')
  assert.equal(eventsOf(history, 'goal.change')[0]?.goal?.id, 'goal-a')

  const user = eventsOf(history, 'user.message')[0]
  assert.equal(user?.text, 'BEFORE')
  assert.equal(user?.images?.length, 1)
  assert.deepEqual(await user?.images?.[0]?.read(), PNG)
  const loadedTool = eventsOf(history, 'tool.result')[0]
  assert.equal(loadedTool?.callId, 'call-load')
  assert.equal(loadedTool?.presentation?.card, 'generic')
  assert.equal(loadedTool?.presentation?.card === 'generic' ? loadedTool.presentation.content?.[0]?.text : undefined, 'loaded view')
  assert.equal(session.capabilities.transcript?.hasOlder(), false)
  assert.equal(eventsOf(session.capabilities.transcript?.record() ?? [], 'user.message')[0]?.images?.length, 1)

  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  await waitUntil(() => eventsOf(events, 'task.start').length === 1, 'initial jobs refresh')
  assert.equal(eventsOf(events, 'task.start').length, 1, 'tasks subscribe must not double emit refresh results')
  assert.equal(eventsOf(events, 'task.output')[0]?.text, fixture.output)
  assert.equal(await session.capabilities.tasks?.readOutput?.('job-1'), fixture.output)
  assert.equal(await session.capabilities.tasks?.stop('job-1'), true)
  assert.equal(eventsOf(events, 'task.end').at(-1)?.status, 'stopped')

  assert.equal(session.capabilities.effort?.levelsAvailable, true)
  assert.equal(session.capabilities.effort?.current(), 'high')
  await session.capabilities.effort?.set('low')
  assert.equal(session.capabilities.effort?.current(), 'low')
  await session.capabilities.modes?.set('allow')
  assert.equal(session.capabilities.modes?.current(), 'allow')
  await session.capabilities.goals?.set('next goal')
  await session.capabilities.goals?.pause()
  await session.capabilities.goals?.resume()
  await session.capabilities.goals?.clear()

  const exactTitle = `  ${'精确标题🐳-'.repeat(80)}  `
  await session.capabilities.rename!.rename(exactTitle)
  assert.equal(fixture.title, exactTitle)
  assert.deepEqual(fixture.calls.find(call => call.method === 'session.rename')?.params, { id: 'A', title: exactTitle })
  assert.equal(eventsOf(events, 'session.title').filter(event => event.title === exactTitle && event.source === 'user').length, 1)
  session.capabilities.color!.set('')
  await waitUntil(() => session.capabilities.color!.current() === '', 'accent clear readback')
  assert.equal(fixture.color, '')
  assert.deepEqual(fixture.calls.filter(call => call.method === 'session.color.set').map(call => call.params), [{ id: 'A', color: '' }])
  assert.equal(eventsOf(events, 'session.color').filter(event => event.color === '').length, 1)

  const created = { path: 'D:/work/AGENTS.md', status: 'created' } as const
  const unchanged = { path: 'D:/work/docs/AGENTS.md', status: 'unchanged' } as const
  const failed = { path: 'D:/work/other/AGENTS.md', status: 'failed', error: 'permission denied' } as const
  fixture.initReports.push(
    { files: [created] },
    { files: [unchanged] },
    { files: [created, unchanged, failed] },
  )
  await session.capabilities.init!.run()
  await session.capabilities.init!.run()
  await assert.rejects(session.capabilities.init!.run(), error => {
    assert.ok(error instanceof DshGoInitError)
    assert.deepEqual(error.result, {
      ok: false,
      files: [created, unchanged, failed],
      created: [created.path],
      unchanged: [unchanged.path],
      failed: [failed],
    })
    assert.match(error.message, /created=1, unchanged=1, failed=1/u)
    assert.match(error.message, /permission denied/u)
    return true
  })
  assert.deepEqual(fixture.calls.filter(call => call.method === 'workspace.init').map(call => call.params), [
    { cwd: CWD }, { cwd: CWD }, { cwd: CWD },
  ])

  assert.deepEqual(await session.capabilities.fork?.fork('1', 'fork title'), { backendId: 'dsh-go', sessionId: 'forked-a' })
  assert.deepEqual(await session.capabilities.rewind?.preview?.('1'), { filesChanged: ['src/a.ts'], insertions: 2, deletions: 1 })
  const rewound = await session.capabilities.rewind?.rewind('1', 'files')
  assert.equal(rewound?.kind, 'rewound')
  assert.equal(rewound?.kind === 'rewound' ? rewound.session.sessionId : undefined, 'A')
  assert.deepEqual(await session.capabilities.context?.usage('summary'), {
    used: 123, max: 1000, categories: [{ name: 'context', tokens: 123, kind: 'used' }],
  })
  assert.equal((await session.capabilities.context?.usage('full'))?.sections?.[0]?.name, 'system')
  assert.deepEqual(await session.capabilities.mcp?.status(), [{ name: 'docs', status: 'connected', toolCount: 2 }])
  await session.capabilities.mcp?.reconnect?.('docs')
  await session.capabilities.mcp?.toggle?.('docs', false)
  assert.deepEqual(fixture.calls.find(call => call.method === 'mcp.toggle')?.params, { id: 'A', name: 'docs', enabled: false })
  const promptsBeforeSide = fixture.calls.filter(call => call.method === 'session.prompt').length
  assert.deepEqual(await session.capabilities.sideQuery?.ask('whole'), { answer: 'whole answer' })
  const sideDeltas: string[] = []
  assert.deepEqual(await session.capabilities.sideQuery?.ask('stream', { onText: delta => { sideDeltas.push(delta) } }), { answer: 'side answer' })
  assert.deepEqual(sideDeltas, ['side ', 'answer'])
  const sideCalls = fixture.calls.filter(call => call.method === 'side.query')
  assert.deepEqual(sideCalls.map(call => [call.params.id, call.params.prompt, call.params.stream]), [['A', 'whole', false], ['A', 'stream', true]])
  assert.equal(new Set(sideCalls.map(call => call.params.requestId)).size, 2)
  assert.equal(fixture.calls.filter(call => call.method === 'session.prompt').length, promptsBeforeSide)

  assert.deepEqual(await session.capabilities.models?.set({ model: 'model-b' }), { kind: 'switched' })
  assert.equal(session.capabilities.effort?.levels()[0]?.id, 'low')
  const authLines = (await session.capabilities.auth?.status())?.lines.join('\n') ?? ''
  assert.match(authLines, /KEY_B/u, 'auth must use the live switched model, not the baseline model')
  const login = session.capabilities.auth!.login!()
  await waitUntil(() => eventsOf(events, 'question.request').length === 1, 'auth question')
  const question = eventsOf(events, 'question.request')[0]!
  assert.equal(question.request.questions[0]?.secret, true)
  session.capabilities.questions!.respond(question.request.requestId, { answers: [{ selected: [], custom: 'integration-secret' }] })
  await login
  assert.equal(fixture.calls.filter(call => call.method === 'models.catalog.upsert').length, 1)
  await session.capabilities.auth!.reconnect()

  const image: ImageRef = {
    id: 'local-image', name: 'pixel.png', mediaType: 'image/png', bytes: PNG.byteLength, width: 1, height: 1,
    read: async () => PNG,
  }
  const blocks = [
    { type: 'text', text: 'BEFORE' },
    { type: 'image', attachment: { attachmentId: 'local-image' } },
    { type: 'text', text: 'AFTER' },
  ] as unknown as AgentInput['blocks']
  const submitted = await session.submit({ text: 'BEFORE\nAFTER', blocks, images: [image], clientMessageId: 'image-a' }, 'turn')
  assert.deepEqual(submitted, { accepted: true })
  const prompt = fixture.calls.find(call => call.method === 'session.prompt')
  assert.deepEqual(prompt?.params, {
    sessionId: 'A', placement: 'turn',
    content: [{ type: 'text', text: 'BEFORE' }, { type: 'attachment', attachmentId: ATTACHMENT_ID }, { type: 'text', text: 'AFTER' }],
  })
  assert.equal(existsSync(dirname(fixture.stagingPath)), false, 'image staging is removed')

  fixture.frame({ seq: 1, type: 'goal/change', data: { kind: 'goal/change', version: 3, operation: 'pause', goal: { ...GOAL, phase: 'paused' }, roundsStarted: 1 }, time: 4 })
  assert.equal(eventsOf(events, 'goal.change').filter(event => event.operation === 'pause').length, 1)
  assert.equal(eventsOf(events, 'custom').filter(event => event.nativeType === 'goal/change').length, 0)

  fixture.frame({ seq: 2, type: 'tool/call', data: { turn: 1, step: 3, callId: 'child-1', name: 'subagent', arguments: '{"description":"child work"}' }, time: 5 })
  fixture.frame({ seq: 3, type: 'tool/result', data: { turn: 1, step: 3, message: { toolCallId: 'child-1', content: [{ type: 'text', text: 'child done' }] } }, time: 6 })
  const childEvents = events.filter(event => ['tool.call', 'tool.result', 'subagent.start', 'subagent.end'].includes(event.type))
  assert.deepEqual(childEvents.map(event => event.type), ['tool.call', 'subagent.start', 'tool.result', 'subagent.end'])
  assert.equal(eventsOf(events, 'subagent.end')[0]?.summary, 'child done')

  fixture.frame({ seq: 4, type: 'step/start', data: { turn: 2, step: 1 }, time: 100 })
  fixture.frame({ seq: 5, type: 'assistant/text', data: { turn: 2, step: 1, text: 'stream', index: 0, v4Seq: 50, model: 'model-b' }, time: 125 })
  fixture.frame({ seq: 6, type: 'step/end', data: { turn: 2, step: 1 }, time: 130 })
  assert.equal(eventsOf(events, 'assistant.attempt.start')[0]?.firstTokenTime, 125)
  assert.equal(eventsOf(events, 'assistant.delta')[0]?.time, 125)
  assert.equal(eventsOf(events, 'step.end').length, 1)
  assert.equal(eventsOf(events, 'assistant.attempt.end')[0]?.outcome, 'committed')

  fixture.frame({ seq: 7, type: 'tool/result', data: {
    turn: 2, step: 2, message: { toolCallId: 'live-view', content: [{ type: 'text', text: 'live result' }] },
    view: { kind: 'card', title: 'Live card', fields: [{ key: 'key', value: 'value' }] },
  }, time: 140 })
  assert.equal(eventsOf(events, 'tool.result').find(event => event.callId === 'live-view')?.presentation?.card, 'generic')
  fixture.frame({ seq: 8, type: 'session/title', data: { title: 'external title', source: { kind: 'user' } }, time: 150 })
  fixture.frame({ seq: 9, type: 'session/color', data: { color: 'magenta' }, time: 151 })
  assert.equal(eventsOf(events, 'session.title').filter(event => event.title === 'external title').length, 1)
  assert.equal(eventsOf(events, 'session.color').filter(event => event.color === 'magenta').length, 1)
  assert.equal(eventsOf(events, 'custom').filter(event => event.nativeType === 'session/title' || event.nativeType === 'session/color').length, 0)

  fixture.title = 'reset title'
  fixture.color = 'orange'
  fixture.reset()
  await waitUntil(() => eventsOf(events, 'session.ready').some(event => event.title === 'reset title')
    && eventsOf(events, 'session.title').some(event => event.title === 'reset title')
    && eventsOf(events, 'session.color').some(event => event.color === 'orange'), 'reset metadata refresh and seed')
  assert.equal(eventsOf(events, 'session.title').filter(event => event.title === 'reset title').length, 1)
  assert.equal(eventsOf(events, 'session.color').filter(event => event.color === 'orange').length, 1)
  assert.equal(session.capabilities.color!.current(), 'orange')
  assert.equal(eventsOf(events, 'custom').filter(event => event.nativeType === 'session/title' || event.nativeType === 'session/color').length, 0)

  const secondLogin = session.capabilities.auth!.login!()
  await waitUntil(() => eventsOf(events, 'question.request').length === 2, 'second auth question')
  const disposed = session.dispose()
  await secondLogin
  await disposed
  assert.equal(fixture.calls.filter(call => call.method === 'models.catalog.upsert').length, 1, 'dispose cancels the pending secret prompt')
  assert.equal(fixture.sessionDisposed, true)
  assert.equal(fixture.closed, true)
})

test('missing baseline model uses only the live catalog default without A/B or explicit-set fallback', async t => {
  const freshLoad = (): SessionLoad => ({
    messages: [],
    total: 0,
    truncated: false,
    cwd: CWD,
    permission: 'ask',
    contextTokens: 123,
    contextWindow: 1000,
    journalEpoch: '7',
    lastSeq: 0,
  })
  const fixtureA = new IntegrationHost(freshLoad())
  const fixtureB = new IntegrationHost(freshLoad())
  fixtureB.activeModel = 'model-b'
  const missingDefault = new IntegrationHost(freshLoad())
  missingDefault.activeModel = ''
  const staleDefault = new IntegrationHost(freshLoad())
  staleDefault.activeModel = 'stale-model'
  const fixtures = new Map([
    ['D:/default-a', fixtureA],
    ['D:/default-b', fixtureB],
    ['D:/default-missing', missingDefault],
    ['D:/default-stale', staleDefault],
  ])
  const backend = createDshGoBackend({
    launch: async cwd => {
      const fixture = fixtures.get(cwd)
      assert.ok(fixture, `unexpected fixture cwd ${cwd}`)
      return { transport: fixture.transport, close: async () => { fixture.closed = true } }
    },
  })

  const a = await backend.open({ kind: 'create', cwd: 'D:/default-a' }, host())
  const b = await backend.open({ kind: 'create', cwd: 'D:/default-b' }, host())
  t.after(async () => { await Promise.all([a.dispose(), b.dispose()]) })
  assert.deepEqual(a.capabilities.models?.current(), { model: 'model-a' })
  assert.deepEqual(b.capabilities.models?.current(), { model: 'model-b' })
  assert.deepEqual(a.capabilities.effort?.levels().map(level => level.id), ['low', 'high'])
  assert.deepEqual(b.capabilities.effort?.levels().map(level => level.id), ['low'])
  assert.equal(a.capabilities.effort?.current(), undefined)
  assert.equal(eventsOf(await a.history(), 'session.ready')[0]?.model, 'model-a')
  assert.equal(eventsOf(await b.history(), 'session.ready')[0]?.model, 'model-b')

  await a.capabilities.effort!.set('low')
  assert.equal(a.capabilities.effort!.current(), 'low')
  assert.deepEqual(fixtureA.calls.find(call => call.method === 'session.setEffort')?.params, { id: 'A', effort: 'low' })
  const catalogCallsBeforeSet = fixtureA.calls.filter(call => call.method === 'models.catalog.list').length
  await a.capabilities.models!.set({ model: 'model-b' })
  assert.equal(fixtureA.calls.filter(call => call.method === 'models.catalog.list').length, catalogCallsBeforeSet + 1)
  assert.deepEqual(a.capabilities.models?.current(), { model: 'model-b' })
  assert.deepEqual(b.capabilities.models?.current(), { model: 'model-b' })
  assert.deepEqual(a.capabilities.effort?.levels().map(level => level.id), ['low'])
  assert.deepEqual(b.capabilities.effort?.levels().map(level => level.id), ['low'])

  await assert.rejects(backend.open({ kind: 'create', cwd: 'D:/default-missing' }, host()), /no active default model/u)
  await assert.rejects(backend.open({ kind: 'create', cwd: 'D:/default-stale' }, host()), /not present in the catalog/u)
  assert.equal(missingDefault.closed, true)
  assert.equal(staleDefault.closed, true)
})

test('missing baseline model prefers selected/env models, isolates A/B and fails loud without either', async t => {
  const freshLoad = (): SessionLoad => ({
    messages: [], total: 0, truncated: false, cwd: CWD, permission: 'ask',
    contextTokens: 123, contextWindow: 1000, journalEpoch: '7', lastSeq: 0,
  })
  const withoutCatalog = () => {
    const fixture = new IntegrationHost(freshLoad())
    fixture.catalogError = new Error('catalog is absent')
    return fixture
  }
  const fixtureA = withoutCatalog()
  const fixtureB = withoutCatalog()
  const catalogDefault = new IntegrationHost(freshLoad())
  const selected = new IntegrationHost({ ...freshLoad(), model: 'model-selected' })
  const missing = withoutCatalog()
  const fixtures = new Map([
    ['D:/env-a', fixtureA], ['D:/env-b', fixtureB], ['D:/env-catalog', catalogDefault],
    ['D:/selected', selected], ['D:/env-missing', missing],
  ])
  const env = { DSH_GO_MODEL: 'model-env-a' }
  const backend = createDshGoBackend({
    env,
    launch: async cwd => {
      const fixture = fixtures.get(cwd)
      assert.ok(fixture, `unexpected fixture cwd ${cwd}`)
      return { transport: fixture.transport, close: async () => { fixture.closed = true } }
    },
  })

  const a = await backend.open({ kind: 'create', cwd: 'D:/env-a' }, host())
  t.after(() => a.dispose())
  env.DSH_GO_MODEL = 'model-env-b'
  const b = await backend.open({ kind: 'create', cwd: 'D:/env-b' }, host())
  t.after(() => b.dispose())
  assert.deepEqual(a.capabilities.models?.current(), { model: 'model-env-a' })
  assert.deepEqual(b.capabilities.models?.current(), { model: 'model-env-b' })
  assert.equal(eventsOf(await a.history(), 'session.ready')[0]?.model, 'model-env-a')
  assert.equal(eventsOf(await b.history(), 'session.ready')[0]?.model, 'model-env-b')
  assert.equal(fixtureA.calls.filter(call => call.method === 'models.catalog.list').length, 1, 'only effort refresh reads the absent catalog')
  assert.equal(fixtureB.calls.filter(call => call.method === 'models.catalog.list').length, 1, 'only effort refresh reads the absent catalog')

  env.DSH_GO_MODEL = 'model-b'
  const fromCatalog = await backend.open({ kind: 'create', cwd: 'D:/env-catalog' }, host())
  t.after(() => fromCatalog.dispose())
  assert.deepEqual(fromCatalog.capabilities.models?.current(), { model: 'model-b' })
  assert.deepEqual(fromCatalog.capabilities.effort?.levels().map(level => level.id), ['low'])
  assert.equal(catalogDefault.calls.filter(call => call.method === 'models.catalog.list').length, 1, 'env default must not add a catalog read')

  const alreadySelected = await backend.open({ kind: 'create', cwd: 'D:/selected' }, host())
  t.after(() => alreadySelected.dispose())
  assert.deepEqual(alreadySelected.capabilities.models?.current(), { model: 'model-selected' })
  assert.equal(selected.calls.filter(call => call.method === 'models.catalog.list').length, 1, 'selected model must not add a catalog read')
  assert.deepEqual(a.capabilities.models?.current(), { model: 'model-env-a' })
  assert.deepEqual(b.capabilities.models?.current(), { model: 'model-env-b' })

  env.DSH_GO_MODEL = ''
  await assert.rejects(backend.open({ kind: 'create', cwd: 'D:/env-missing' }, host()), /catalog is absent/u)
  assert.equal(missing.closed, true)
})

test('reset closes the active independent side query, replaces it and fences late text', async t => {
  const fixture = new IntegrationHost()
  let lateText: ((delta: string) => void) | undefined
  let release: (() => void) | undefined
  fixture.sideQueryHandler = request => {
    if (request.prompt === 'active') {
      lateText = request.onText
      return new Promise<string>(resolve => { release = () => { resolve('late') } })
    }
    return Promise.resolve('next answer')
  }
  const session = await backendFor(fixture).open({ kind: 'create', cwd: CWD }, host())
  t.after(() => session.dispose())
  const previous = session.capabilities.sideQuery!
  const deltas: string[] = []
  const active = previous.ask('active', { onText: delta => { deltas.push(delta) } })
  await waitUntil(() => lateText !== undefined && release !== undefined, 'active side query')
  fixture.reset()
  assert.deepEqual(await active, { answer: null })
  assert.notStrictEqual(session.capabilities.sideQuery, previous)
  await waitUntil(() => fixture.calls.some(call => call.method === 'side.close' && call.params.id === 'A'), 'reset side.close')
  release?.()
  lateText?.('late')
  await Promise.resolve()
  assert.deepEqual(deltas, [])
  assert.deepEqual(await session.capabilities.sideQuery?.ask('next'), { answer: 'next answer' })
  await session.dispose()
})

test('truncated baseline prefetches durable transcript pages without replaying the tail twice', async t => {
  const older = { seq: 1, role: 'assistant', text: 'older', v4Seq: 10, time: 1 }
  const newest = { seq: 2, role: 'assistant', text: 'newest', v4Seq: 11, time: 2 }
  const load = { ...baseline([newest]), total: 2, truncated: true }
  const fixture = new IntegrationHost(load)
  fixture.pages = [{ messages: [older, newest], hasOlder: false }]
  const session = await backendFor(fixture).open({ kind: 'create', cwd: CWD }, host())
  t.after(() => session.dispose())
  assert.deepEqual(eventsOf(await session.history(), 'assistant.message').map(event => event.blocks[0]?.text), ['newest'])
  await waitUntil(() => session.capabilities.transcript !== undefined, 'transcript.page prefetch')
  assert.deepEqual(eventsOf(session.capabilities.transcript!.record() ?? [], 'assistant.message').map(event => event.blocks[0]?.text), ['older', 'newest'])
  assert.equal(session.capabilities.transcript!.hasOlder(), true)
  assert.deepEqual(eventsOf(session.capabilities.transcript!.older(), 'assistant.message').map(event => event.blocks[0]?.text), ['older'])
  assert.equal(session.capabilities.transcript!.hasOlder(), false)
  await session.dispose()
})

test('translator preserves TTFT/decode timing, resets stream state and skips incomplete load tools', () => {
  const translator = createDshGoEventTranslator({ sessionId: 'direct' })
  const initial = translator.translateLoad(directLoad(1, [
    { seq: 99, role: 'tool', text: 'orphan', view: { kind: 'plain', body: 'not fabricated' } },
  ]))
  assert.deepEqual(initial.map(event => event.type), ['session.ready'])

  const frames: DshGoServerFrame[] = [
    { seq: 1, type: 'step/start', data: { turn: 3, step: 4 }, time: 10 },
    { seq: 2, type: 'assistant/text', data: { turn: 3, step: 4, text: 'a', index: 0, v4Seq: 100 }, time: 20 },
    { seq: 3, type: 'assistant/reasoning', data: { turn: 3, step: 4, text: 'b', index: 1, v4Seq: 101 }, time: 25 },
    { seq: 4, type: 'step/end', data: { turn: 3, step: 4 }, time: 30 },
  ]
  const streamed = frames.flatMap(frame => translator.translateFrame(frame))
  assert.equal(eventsOf(streamed, 'assistant.attempt.start')[0]?.firstTokenTime, 20)
  assert.deepEqual(translator.timings(), [{ turn: 3, step: 4, startTime: 10, firstTokenTime: 20, lastTokenTime: 25, endTime: 30, ttftMs: 10, decodeMs: 5 }])

  const rebased = translator.translateLoad(directLoad(2))
  assert.deepEqual(rebased.map(event => event.type), ['session.reset', 'session.ready'])
  assert.deepEqual(translator.timings(), [])
  translator.translateFrame({ seq: 1, type: 'step/start', data: { turn: 3, step: 4 }, time: 100 })
  const next = translator.translateFrame({ seq: 2, type: 'assistant/text', data: { turn: 3, step: 4, text: 'next' }, time: 110 })
  assert.equal(eventsOf(next, 'assistant.attempt.start')[0]?.firstTokenTime, 110)
})

test('public turn completion waits for host readiness through normal, cancel, error and reset lifecycles', async t => {
  const fixture = new IntegrationHost(baseline([]))
  const session = await backendFor(fixture).open({ kind: 'create', cwd: CWD }, host())
  t.after(() => session.dispose())
  await session.history()
  const events: AgentEvent[] = []
  let immediate: ReturnType<typeof session.submit> | undefined
  session.subscribe(batch => {
    events.push(...batch)
    if (immediate === undefined && batch.some(event => event.type === 'turn.end')) {
      immediate = session.submit({ text: 'immediate next turn', clientMessageId: 'immediate-next' }, 'turn')
    }
  })

  assert.deepEqual(await session.submit({ text: 'first turn', clientMessageId: 'first-turn' }, 'turn'), { accepted: true })
  fixture.frame({ seq: 1, type: 'turn/start', data: { turn: 1 }, time: 10 })
  fixture.frame({ seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 11 })
  assert.equal(session.status, 'running', 'v4 end without raw done is finalizing, not idle')
  assert.equal(eventsOf(events, 'turn.end').length, 0, 'missing raw done must not publish a completion')
  assert.equal(immediate, undefined)

  fixture.hostTurnReady = true
  fixture.frame({ seq: 3, type: 'turn/done', data: { turnId: 'turn-a' }, time: 12 })
  await waitUntil(() => immediate !== undefined, 'immediate submit from public completion')
  assert.deepEqual(await immediate, { accepted: true }, 'public completion means the host accepts the next turn')
  assert.equal(session.status, 'idle')
  assert.deepEqual(eventsOf(events, 'turn.end').map(event => event.reason), [{ kind: 'completed' }])
  assert.equal(eventsOf(events, 'turn.end')[0]?.time, 11, 'the delayed event keeps the v4 end timestamp')

  fixture.frame({ seq: 4, type: 'turn/start', data: { turn: 2 }, time: 20 })
  fixture.frame({ seq: 5, type: 'turn/end', data: { turn: 2, reason: { kind: 'interrupted' } }, time: 21 })
  assert.equal(session.status, 'running')
  assert.equal(eventsOf(events, 'turn.end').length, 1)
  fixture.hostTurnReady = true
  fixture.frame({ seq: 6, type: 'turn/done', data: { turnId: 'turn-a' }, time: 22 })
  assert.equal(eventsOf(events, 'turn.end').length, 2)
  assert.deepEqual(eventsOf(events, 'turn.end')[1]?.reason, { kind: 'interrupted' }, 'cancel reason survives finalizing')

  fixture.frame({ seq: 7, type: 'turn/start', data: { turn: 3 }, time: 30 })
  fixture.hostTurnReady = true
  fixture.frame({ seq: 8, type: 'turn/error', data: { turnId: 'turn-a', error: 'raw failure' }, time: 31 })
  assert.equal(eventsOf(events, 'turn.end').length, 3)
  assert.deepEqual(eventsOf(events, 'turn.end')[2]?.reason, { kind: 'error', message: 'raw failure' })
  assert.equal(session.status, 'idle')

  fixture.frame({ seq: 9, type: 'turn/start', data: { turn: 4 }, time: 40 })
  fixture.frame({ seq: 10, type: 'turn/end', data: { turn: 4, reason: { kind: 'aborted' } }, time: 41 })
  assert.equal(session.status, 'running')
  fixture.hostTurnReady = true
  fixture.frame({ seq: 11, type: 'turn/error', data: { turnId: 'turn-a', error: 'late error' }, time: 42 })
  assert.equal(eventsOf(events, 'turn.end').length, 4)
  assert.deepEqual(eventsOf(events, 'turn.end')[3]?.reason, { kind: 'aborted' }, 'raw error releases but does not replace the v4 reason')

  fixture.frame({ seq: 12, type: 'turn/start', data: { turn: 5 }, time: 50 })
  fixture.frame({ seq: 13, type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } }, time: 51 })
  assert.equal(session.status, 'running')
  fixture.reset()
  assert.equal(session.status, 'idle', 'reset abandons the old finalizing generation')
  await waitUntil(() => eventsOf(events, 'session.ready').length === 1, 'reset baseline')
  assert.equal(eventsOf(events, 'turn.end').length, 4, 'reset never releases a stale completion')
})

test('raw host outcomes and deferred completions stay isolated between A and B', async t => {
  const fixtureA = new IntegrationHost(baseline([]))
  const fixtureB = new IntegrationHost(baseline([]))
  const a = await backendFor(fixtureA).open({ kind: 'create', cwd: CWD }, host())
  const b = await backendFor(fixtureB).open({ kind: 'create', cwd: CWD }, host())
  t.after(() => Promise.all([a.dispose(), b.dispose()]).then(() => undefined))
  await Promise.all([a.history(), b.history()])
  const aEvents: AgentEvent[] = []
  const bEvents: AgentEvent[] = []
  a.subscribe(batch => { aEvents.push(...batch) })
  b.subscribe(batch => { bEvents.push(...batch) })
  await a.submit({ text: 'A', clientMessageId: 'client-a' }, 'turn')
  await b.submit({ text: 'B', clientMessageId: 'client-b' }, 'turn')
  fixtureA.frame({ seq: 1, type: 'turn/start', data: { turn: 1 }, time: 10 })
  fixtureB.frame({ seq: 1, type: 'turn/start', data: { turn: 1 }, time: 10 })
  fixtureA.frame({ seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 11 })
  assert.equal(a.status, 'running')
  assert.equal(b.status, 'running')
  fixtureB.hostTurnReady = true
  fixtureB.frame({ seq: 2, type: 'turn/done', data: { turnId: 'turn-a' }, time: 12 })
  assert.equal(a.status, 'running', 'B done cannot release A')
  assert.equal(eventsOf(aEvents, 'turn.end').length, 0)
  assert.equal(b.status, 'idle')
  assert.equal(eventsOf(bEvents, 'turn.end').length, 1, 'raw done without a v4 end retains the completed fallback')
  fixtureA.hostTurnReady = true
  fixtureA.frame({ seq: 3, type: 'turn/done', data: { turnId: 'turn-a' }, time: 13 })
  assert.equal(a.status, 'idle')
  assert.equal(eventsOf(aEvents, 'turn.end').length, 1)
  assert.equal(eventsOf(bEvents, 'turn.end').length, 1)
})
