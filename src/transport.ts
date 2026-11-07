import WebSocket, { type RawData } from 'ws'
import { dshGoSideQueryFrame, dshGoSideQueryResult } from './events.js'

/** Decimal JSON integer, kept as text so a random 63-bit host epoch is lossless. */
export type JournalEpoch = string

export interface ServerFrame {
  readonly seq?: number
  readonly type: string
  readonly data?: unknown
  readonly time?: number
}

export interface SessionLoad {
  readonly journalEpoch: JournalEpoch
  readonly lastSeq: number
  readonly [key: string]: unknown
}

export interface DshGoSideQueryRequest {
  readonly id: string
  readonly requestId: string
  readonly prompt: string
  readonly stream: boolean
  readonly signal: AbortSignal
  readonly onText: (delta: string) => void
}

export interface SessionHistory {
  readonly frames: readonly ServerFrame[]
  readonly journalEpoch: JournalEpoch
  readonly lastSeq: number
}

export interface TransportOptions {
  readonly historyLimit?: number
  readonly reconnectInitialMs?: number
  readonly reconnectMaxMs?: number
}

export type ResetTrigger = 'session/reset' | 'stale_epoch' | 'invalid_history'

export interface SessionCallbacks {
  onFrame(frame: ServerFrame): void
  /** Replace projection state with this new session.load baseline. */
  onReset?(baseline: SessionLoad, trigger: ResetTrigger): void
  onReconnect?(delayMs: number): void
  onError?(error: Error): void
}

export interface SessionTransport {
  readonly sessionId: string
  readonly journalEpoch: JournalEpoch
  readonly lastSeq: number
  ping(): Promise<void>
  dispose(): Promise<void>
}

export interface OpenedSession {
  readonly baseline: SessionLoad
  readonly session: SessionTransport
}

export class DshGoTransportError extends Error {
  readonly code: string
  readonly hint: string
  readonly retryable: boolean
  readonly status: number
  readonly journalEpoch: JournalEpoch | undefined
  readonly lastSeq: number | undefined

  constructor(status: number, body: Record<string, unknown>, error: Record<string, unknown>) {
    super(error.message as string)
    this.name = 'DshGoTransportError'
    this.code = error.code as string
    this.hint = error.hint as string
    this.retryable = error.retryable as boolean
    this.status = status
    this.journalEpoch = typeof body.journalEpoch === 'string' ? body.journalEpoch : undefined
    this.lastSeq = typeof body.lastSeq === 'number' ? body.lastSeq : undefined
  }
}

interface LaunchReady {
  readonly url: string
  readonly token: string
}

function parseReadyLine(line: string): LaunchReady {
  if (!line.startsWith('ready ') || line.includes('\n') || line.includes('\r')) {
    throw new Error('dsh-go: expected one stdout line beginning with "ready "')
  }
  const value = asRecord(parseJson(line.slice('ready '.length)))
  if (typeof value.url !== 'string' || typeof value.token !== 'string' || value.token === '') {
    throw new Error('dsh-go: ready line needs non-empty url and token')
  }
  const url = new URL(value.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('dsh-go: ready url must use HTTP(S)')
  }
  return { url: value.url, token: value.token }
}

/** A one-shot ready/launch credential. stderr must never be passed to this parser. */
export class DshGoLaunch {
  readonly url: string
  private token: string | undefined

  constructor(stdoutLine: string) {
    const ready = parseReadyLine(stdoutLine)
    this.url = ready.url
    this.token = ready.token
  }

  async connect(options: TransportOptions = {}): Promise<DshGoTransport> {
    if (this.token === undefined) throw new Error('dsh-go: launch token already consumed')
    const token = this.token
    this.token = undefined
    return DshGoTransport.authenticate(this.url, token, options)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dsh-go: expected a JSON object')
  }
  return value as Record<string, unknown>
}

type JsonReviverContext = { readonly source?: string }
type JsonParse = (
  text: string,
  reviver: (key: string, value: unknown, context?: JsonReviverContext) => unknown,
) => unknown

/** JSON.parse source access preserves integer text before Number rounds it. */
function parseJson(text: string): unknown {
  return (JSON.parse as JsonParse)(text, (key, value, context) => {
    if (key === 'journalEpoch' && typeof value === 'number') {
      if (!Number.isInteger(value)) throw new Error('dsh-go: journalEpoch is not an integer')
      const source = context?.source
      if (source !== undefined && /^-?\d+$/u.test(source)) return source
      if (Number.isSafeInteger(value)) return String(value)
      throw new Error('dsh-go: cannot preserve the host journalEpoch on this Node runtime')
    }
    return value
  })
}

function epoch(value: unknown): JournalEpoch {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error('dsh-go: invalid journalEpoch')
  }
  return value
}

function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('dsh-go: invalid journal sequence')
  }
  return value
}

function serverFrame(value: unknown): ServerFrame {
  const frame = asRecord(value)
  if (typeof frame.type !== 'string' || frame.type === '') throw new Error('dsh-go: frame has no type')
  if (frame.seq !== undefined) sequence(frame.seq)
  if (frame.time !== undefined && (typeof frame.time !== 'number' || !Number.isFinite(frame.time))) {
    throw new Error('dsh-go: frame has invalid time')
  }
  return frame as unknown as ServerFrame
}

function sessionLoad(value: unknown): SessionLoad {
  const load = asRecord(value)
  epoch(load.journalEpoch)
  // The real host uses `lastSeq,omitempty`: an empty journal omits the key.
  // Only that exact empty-load case defaults to zero; malformed values still fail.
  const lastSeq = load.lastSeq === undefined ? 0 : sequence(load.lastSeq)
  return { ...load, lastSeq } as SessionLoad
}

function sessionHistory(value: unknown): SessionHistory {
  const history = asRecord(value)
  epoch(history.journalEpoch)
  sequence(history.lastSeq)
  if (!Array.isArray(history.frames)) throw new Error('dsh-go: history frames is not an array')
  return {
    ...history,
    frames: history.frames.map(serverFrame),
    journalEpoch: history.journalEpoch as JournalEpoch,
    lastSeq: history.lastSeq as number,
  }
}

async function responseJson(response: Response, allowEmpty = false): Promise<unknown> {
  const text = await response.text()
  if (text === '' && allowEmpty) return undefined
  try {
    return parseJson(text)
  } catch (error) {
    throw new Error(`dsh-go: invalid JSON response (${response.status})`, { cause: error })
  }
}

function responseError(status: number, value: unknown): DshGoTransportError | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const body = value as Record<string, unknown>
  const error = body.error
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return undefined
  const detail = error as Record<string, unknown>
  if (
    typeof detail.code !== 'string' || typeof detail.message !== 'string'
    || typeof detail.hint !== 'string' || typeof detail.retryable !== 'boolean'
  ) {
    throw new Error('dsh-go: malformed four-field error envelope')
  }
  return new DshGoTransportError(status, body, detail)
}

function withEpoch(params: Readonly<Record<string, unknown>>, journalEpoch: JournalEpoch): string {
  const checked = epoch(journalEpoch)
  const json = JSON.stringify(params)
  return `${json.slice(0, -1)},"journalEpoch":${checked}}`
}

function endpoint(base: string, path: string, websocket = false): string {
  const url = new URL(base)
  if (websocket) url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}${path}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** Thin authenticated DSH-GO Transport client; mutations are never replayed automatically. */
export class DshGoTransport {
  private readonly sessions = new Set<Session>()
  private readonly historyLimit: number
  private readonly reconnectInitialMs: number
  private readonly reconnectMaxMs: number

  private constructor(
    private readonly baseUrl: string,
    private readonly cookie: string,
    options: TransportOptions,
  ) {
    this.historyLimit = options.historyLimit ?? 256
    this.reconnectInitialMs = options.reconnectInitialMs ?? 100
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5_000
    if (!Number.isSafeInteger(this.historyLimit) || this.historyLimit <= 0) throw new Error('dsh-go: invalid historyLimit')
    if (this.reconnectInitialMs <= 0 || this.reconnectMaxMs < this.reconnectInitialMs) {
      throw new Error('dsh-go: invalid reconnect backoff')
    }
  }

  static async authenticate(baseUrl: string, token: string, options: TransportOptions): Promise<DshGoTransport> {
    const url = new URL(endpoint(baseUrl, '/connect'))
    url.searchParams.set('token', token)
    const response = await fetch(url, { redirect: 'manual' })
    const body = await responseJson(response, true)
    const error = responseError(response.status, body)
    if (error !== undefined) throw error
    if (response.status >= 400) throw new Error(`dsh-go: connect failed with HTTP ${response.status}`)
    const setCookie = response.headers.get('set-cookie') ?? ''
    const match = /(?:^|,\s*)dshd_session=([^;]+)/u.exec(setCookie)
    if (match?.[1] === undefined || match[1] === '') throw new Error('dsh-go: connect returned no dshd_session cookie')
    return new DshGoTransport(baseUrl, `dshd_session=${match[1]}`, options)
  }

  async call<T = unknown>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    if (!/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u.test(method)) throw new Error('dsh-go: invalid API method')
    const response = await fetch(endpoint(this.baseUrl, `/api/${method}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify(params),
      signal: options.signal,
    })
    const body = await responseJson(response)
    const error = responseError(response.status, body)
    if (error !== undefined) throw error
    if (!response.ok) throw new Error(`dsh-go: ${method} failed with HTTP ${response.status}`)
    const envelope = asRecord(body)
    if (!Object.hasOwn(envelope, 'result')) throw new Error('dsh-go: success envelope has no result')
    return envelope.result as T
  }

  /** One independent side runner call; no frame is forwarded to openSession. */
  async sideQuery(request: DshGoSideQueryRequest): Promise<string | null> {
    if (request.id === '' || request.requestId === '' || request.prompt === '') {
      throw new Error('dsh-go: side.query requires id, requestId and prompt')
    }
    const params = { id: request.id, requestId: request.requestId, prompt: request.prompt, stream: request.stream }
    if (!request.stream) {
      const result = await this.call<unknown>('side.query', params, { signal: request.signal })
      return dshGoSideQueryResult(result, request.requestId)
    }
    const response = await fetch(endpoint(this.baseUrl, '/api/side.query'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify(params),
      signal: request.signal,
    })
    if (!response.ok) {
      const body = await responseJson(response)
      const error = responseError(response.status, body)
      if (error !== undefined) throw error
      throw new Error(`dsh-go: side.query failed with HTTP ${response.status}`)
    }
    if (response.body === null) throw new Error('dsh-go: side.query stream has no body')
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/x-ndjson') {
      await response.body.cancel()
      throw new Error('dsh-go: side.query stream is not application/x-ndjson')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffered = ''
    let settled = false
    let answer: string | null | undefined
    let complete = false
    const accept = (rawLine: string): void => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line === '') return
      if (settled) throw new Error('dsh-go: side.query sent a frame after done')
      const frame = dshGoSideQueryFrame(parseJson(line), request.requestId)
      if (frame.type === 'text') {
        request.onText(frame.text)
      } else if (frame.type === 'error') {
        throw new DshGoTransportError(response.status, { error: frame.error }, frame.error)
      } else {
        answer = frame.answer
        settled = true
      }
    }
    const acceptBuffered = (): void => {
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        accept(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf('\n')
      }
    }
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        buffered += decoder.decode(next.value, { stream: true })
        acceptBuffered()
      }
      buffered += decoder.decode()
      if (buffered !== '') accept(buffered)
      complete = true
    } finally {
      if (!complete) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    if (!settled) throw new Error('dsh-go: side.query stream ended without done')
    return answer as string | null
  }

  async load(sessionId: string): Promise<SessionLoad> {
    return sessionLoad(await this.call<unknown>('session.load', { id: sessionId }))
  }

  async history(sessionId: string, sinceSeq: number, journalEpoch: JournalEpoch, limit = this.historyLimit): Promise<SessionHistory> {
    sequence(sinceSeq)
    const body = withEpoch({ id: sessionId, sinceSeq, limit }, journalEpoch)
    const response = await fetch(endpoint(this.baseUrl, '/api/session.history'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body,
    })
    const value = await responseJson(response)
    const error = responseError(response.status, value)
    if (error !== undefined) throw error
    if (!response.ok) throw new Error(`dsh-go: session.history failed with HTTP ${response.status}`)
    const envelope = asRecord(value)
    if (!Object.hasOwn(envelope, 'result')) throw new Error('dsh-go: history success envelope has no result')
    return sessionHistory(envelope.result)
  }

  async openSession(sessionId: string, callbacks: SessionCallbacks): Promise<OpenedSession> {
    if (sessionId === '') throw new Error('dsh-go: empty session id')
    const session = new Session(this, sessionId, callbacks, () => { this.sessions.delete(session) })
    this.sessions.add(session)
    try {
      const baseline = await session.start()
      return { baseline, session }
    } catch (error) {
      await session.dispose()
      throw error
    }
  }

  /** @internal Bounded exponential delay for one session-owned reconnect attempt. */
  reconnectDelay(attempt: number): number {
    return Math.min(this.reconnectMaxMs, this.reconnectInitialMs * 2 ** attempt)
  }

  /** @internal One configured socket; launch credentials are never retained here. */
  createSocket(): WebSocket {
    return new WebSocket(endpoint(this.baseUrl, '/ws', true), {
      headers: { cookie: this.cookie },
      perMessageDeflate: false,
      maxPayload: 1024 * 1024,
    })
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions].map(session => session.dispose()))
  }
}

interface PendingFrame {
  readonly connection: number
  readonly frame: ServerFrame
}

class Session implements SessionTransport {
  private socket: WebSocket | undefined
  private connecting = false
  private disposed = false
  private disposal: Promise<void> | undefined
  private rebasing = false
  private pumping = false
  private connection = 0
  private baselineVersion = 0
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | undefined
  private pending: PendingFrame[] = []
  private epoch: JournalEpoch = '0'
  private watermark = 0

  constructor(
    private readonly transport: DshGoTransport,
    readonly sessionId: string,
    private readonly callbacks: SessionCallbacks,
    private readonly onDispose: () => void,
  ) {}

  get journalEpoch(): JournalEpoch {
    return this.epoch
  }

  get lastSeq(): number {
    return this.watermark
  }

  async start(): Promise<SessionLoad> {
    const baseline = await this.transport.load(this.sessionId)
    this.applyBaseline(baseline)
    await this.connect()
    return baseline
  }

  async ping(): Promise<void> {
    const socket = this.openSocket()
    await this.send(socket, '{"t":"ping"}')
  }

  dispose(): Promise<void> {
    if (this.disposal === undefined) {
      this.disposal = this.disposeOnce().finally(() => { this.onDispose() })
    }
    return this.disposal
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.pending = []
    this.connection++
    const socket = this.socket
    this.socket = undefined
    this.connecting = false
    if (socket !== undefined) {
      await new Promise<void>(resolve => {
        let finished = false
        const finish = (): void => {
          if (finished) return
          finished = true
          resolve()
        }
        const timeout = setTimeout(() => {
          socket.terminate()
          finish()
        }, 1_000)
        timeout.unref()
        socket.once('close', () => {
          clearTimeout(timeout)
          finish()
        })
        if (socket.readyState === WebSocket.OPEN) {
          socket.send('{"t":"unsub","topic":' + JSON.stringify(`session:${this.sessionId}`) + '}', () => socket.close())
        } else {
          socket.terminate()
          clearTimeout(timeout)
          finish()
        }
      })
    }
  }

  private applyBaseline(baseline: SessionLoad): void {
    this.epoch = epoch(baseline.journalEpoch)
    this.watermark = sequence(baseline.lastSeq)
  }

  private async connect(): Promise<void> {
    if (this.disposed) throw new Error('dsh-go: session disposed')
    if (this.connecting || this.socket !== undefined) return
    this.connecting = true
    const connection = ++this.connection
    let socket: WebSocket
    try {
      socket = this.transport.createSocket()
      this.socket = socket
    } catch (error) {
      this.connecting = false
      this.scheduleReconnect()
      throw error
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const rejectOnce = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      socket.on('open', () => {
        if (this.disposed || connection !== this.connection) {
          socket.terminate()
          return
        }
        this.connecting = false
        this.reconnectAttempt = 0
        this.sendSubscription(socket)
        settled = true
        resolve()
      })
      socket.on('message', (data: RawData) => {
        if (this.disposed || this.rebasing || connection !== this.connection) return
        try {
          const frame = serverFrame(parseJson(data.toString()))
          this.pending.push({ connection, frame })
          void this.pump()
        } catch (error) {
          this.fail(error)
        }
      })
      socket.on('error', error => {
        if (this.disposed || connection !== this.connection) {
          rejectOnce(error)
          return
        }
        this.report(error)
        rejectOnce(error)
        this.invalidate(socket, connection)
        this.scheduleReconnect()
      })
      socket.on('close', () => {
        if (this.disposed || connection !== this.connection) {
          rejectOnce(new Error('dsh-go: WebSocket closed'))
          return
        }
        if (this.socket === socket) this.socket = undefined
        this.connecting = false
        rejectOnce(new Error('dsh-go: WebSocket closed'))
        this.scheduleReconnect()
      })
    })
  }

  private openSocket(): WebSocket {
    if (this.disposed) throw new Error('dsh-go: session disposed')
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) throw new Error('dsh-go: WebSocket is not open')
    return socket
  }

  private async send(socket: WebSocket, raw: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket.send(raw, error => {
        if (error == null) resolve()
        else reject(error)
      })
    })
  }

  private sendSubscription(socket: WebSocket): void {
    const raw = withEpoch({ t: 'sub', topic: `session:${this.sessionId}`, sinceSeq: this.watermark }, this.epoch)
    socket.send(raw, error => {
      if (error != null && !this.disposed) this.fail(error)
    })
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.rebasing || this.reconnectTimer !== undefined || this.connecting || this.socket !== undefined) return
    const delay = this.transport.reconnectDelay(this.reconnectAttempt)
    this.reconnectAttempt++
    this.callbacks.onReconnect?.(delay)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect().catch(() => undefined)
    }, delay)
    this.reconnectTimer.unref()
  }

  private invalidate(socket: WebSocket, connection: number): void {
    if (this.socket === socket) this.socket = undefined
    if (this.connection === connection) this.connection++
    this.connecting = false
    socket.terminate()
  }

  private fail(reason: unknown): void {
    if (this.disposed) return
    const error = reason instanceof Error ? reason : new Error(String(reason))
    this.report(error)
    this.pending = []
    if (this.socket !== undefined) this.invalidate(this.socket, this.connection)
    this.scheduleReconnect()
  }

  private report(error: Error): void {
    this.callbacks.onError?.(error)
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.disposed && this.pending.length > 0) {
        const next = this.pending.shift()!
        if (next.connection !== this.connection) continue
        await this.process(next)
      }
    } catch (error) {
      this.fail(error)
    } finally {
      this.pumping = false
    }
  }

  private async process(next: PendingFrame): Promise<void> {
    const { frame } = next
    if (frame.type === 'pong') return
    if (frame.type === 'session/reset') {
      await this.rebase('session/reset')
      return
    }
    const seq = sequence(frame.seq)
    if (seq === 0) {
      this.callbacks.onFrame(frame)
      return
    }
    if (seq <= this.watermark) return
    if (seq > this.watermark + 1) {
      const baseline = this.baselineVersion
      await this.fillGap(seq)
      if (baseline !== this.baselineVersion || this.disposed || next.connection !== this.connection) return
    }
    if (seq === this.watermark + 1) {
      this.callbacks.onFrame(frame)
      this.watermark = seq
    }
  }

  private async fillGap(target: number): Promise<void> {
    while (this.watermark < target - 1 && !this.disposed) {
      const before = this.watermark
      let history: SessionHistory
      try {
        history = await this.transport.history(this.sessionId, this.watermark, this.epoch)
      } catch (error) {
        if (error instanceof DshGoTransportError && error.code === 'stale_epoch') {
          await this.rebase('stale_epoch')
          return
        }
        throw error
      }
      if (this.disposed) return
      if (history.journalEpoch !== this.epoch) {
        await this.rebase('stale_epoch')
        return
      }
      if (history.frames.length === 0) {
        await this.rebase('invalid_history')
        return
      }
      for (const frame of history.frames) {
        if (this.disposed) return
        const seq = sequence(frame.seq)
        if (seq === 0) {
          this.callbacks.onFrame(frame)
        } else if (seq === this.watermark + 1) {
          this.callbacks.onFrame(frame)
          this.watermark = seq
        } else if (seq > this.watermark + 1) {
          await this.rebase('invalid_history')
          return
        }
      }
      if (this.watermark === before) {
        await this.rebase('invalid_history')
        return
      }
    }
  }

  private async rebase(trigger: ResetTrigger): Promise<void> {
    if (this.rebasing || this.disposed) return
    this.rebasing = true
    this.baselineVersion++
    this.pending = []
    try {
      const baseline = await this.transport.load(this.sessionId)
      if (this.disposed) return
      this.applyBaseline(baseline)
      this.callbacks.onReset?.(baseline, trigger)
    } finally {
      this.rebasing = false
    }
    const socket = this.socket
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) this.sendSubscription(socket)
    else this.scheduleReconnect()
  }
}
