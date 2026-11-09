/**
 * DSH-GO 的 `AgentBackend` 工厂与会话实现。
 *
 * **逐字节移植** 0.18 `src/dsh-go/backend.ts`（1041 行），唯一改动是类型 import 的
 * 落点：`../agent/*.js` → 本包 vendor 的 `./types/agent/*.js`（`../agent/index.js`
 * 的 `PreviewEntry`/`SessionSummary` 改从 `./types/agent/channel-session.js` 取，
 * 因为 T2 刻意没有 vendor `agent/index` 那个 barrel——它会把 `adapter/ports/*`
 * 拖进来）。同目录的 17 个能力模块、`./transport.js`、`./events.js`、`./refs.js`
 * 都是本仓自己的运行时实现，import 原样不动。
 *
 * 移植时的硬约束（见 `T4-RESULT.md`）：
 * - `capabilities` 的键集必须 ⊆ `manifest.capabilities`（`backend-manifest.d.ts`
 *   的注释要求声明**覆盖**运行时实际服务的集合）；
 * - resume 失败从 `session.load` 一路抛出去，**没有** `session.create` 回落；
 * - 只有 `'turn'` 能开回合；其余落点原样上网，被拒时如实 `dropped=true`；
 * - `cancel` 只在真拿到 `cancelled:true` + `outcome:'confirmed'` 的回执时说 confirmed。
 */
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, normalize, resolve } from 'node:path'
import type {
  AgentBackend,
  BackendDetection,
  BackendHost,
  BackendSessionPrefs,
  OpenTarget,
  SessionCatalog,
  SessionListScope,
} from './types/agent/backend.js'
import type { ModelOption, ModelRef, ModelSwitchOutcome, PermissionDecision } from './types/agent/capabilities.js'
import type { AgentEvent, PermissionOutcome, PermissionRequestView } from './types/agent/events.js'
import type { PreviewEntry, SessionSummary } from './types/agent/channel-session.js'
import type { AgentSessionRef } from './types/agent/refs.js'
import type {
  AgentInput,
  AgentSession,
  AgentSessionStatus,
  CancelCause,
  CancelReceipt,
  SubmitPlacement,
} from './types/agent/session.js'
import { createDshGoAuth } from './auth.js'
import { createDshGoColor, dshGoColorChange } from './color.js'
import { createDshGoCompactCapability } from './compact.js'
import { createDshGoContextCapability } from './context.js'
import { createDshGoEffort } from './effort.js'
import { createDshGoEventTranslator, type DshGoLoadResult } from './events.js'
import { createDshGoGoals } from './goals.js'
import { createDshGoImages } from './images.js'
import { createDshGoInitCapability } from './init.js'
import { createDshGoMcpCapability } from './mcp.js'
import { createDshGoModes } from './modes.js'
import { createDshGoWorkspacePort, installDshGoWorkspacePort, type DshGoWorkspacePort } from './workspace.js'
import { createDshGoPlacement, type DshGoPlacement } from './placement.js'
import { createDshGoRename, dshGoTitleChange } from './rename.js'
import { createDshGoIndependentSideQueryRunner, createDshGoSideQuery } from './side-query.js'
import {
  createDshGoForkCapability,
  createDshGoRewindCapability,
  createDshGoTranscriptCapability,
} from './session-operations.js'
import { createDshGoSubagents } from './subagents.js'
import { createDshGoTasks } from './tasks.js'
import { readDshGoTranscriptPages } from './trajectory-history.js'
import { DshGoLaunch, DshGoTransport, debugLog, type ServerFrame, type SessionLoad, type SessionTransport } from './transport.js'

export const DSH_GO_BACKEND_ID = 'dsh-go'
export const DSH_GO_BACKEND_LABEL = 'DSH-GO'

/** One authenticated, cwd-owned dshd supervisor. */
export interface DshGoSupervisor {
  readonly transport: DshGoTransport
  readonly broken?: boolean
  onExit?(listener: (error: Error) => void): () => void
  close(): Promise<void>
  killSync(): void
}

/** Test seams replace process launch and detection, not the backend/session plumbing. */
export interface DshGoBackendOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly readyTimeoutMs?: number
  launch?(cwd: string, host: BackendHost): Promise<DshGoSupervisor>
  detect?(host: BackendHost): Promise<BackendDetection>
}

interface SupervisorLease {
  readonly transport: DshGoTransport
  onBroken(listener: (error: Error) => void): () => void
  release(): Promise<void>
}

interface SupervisorRuntime {
  readonly supervisor: DshGoSupervisor
  readonly brokenListeners: Set<(error: Error) => void>
  refs: number
  broken: boolean
  brokenError?: Error
  unsubscribeExit?: () => void
  closePromise?: Promise<void>
}

interface PrefsData {
  readonly lastSession?: string
  readonly lastUsed: Readonly<Record<string, number>>
}

const EMPTY_PREFS: PrefsData = { lastUsed: {} }
let prefsTemporarySequence = 0

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function cwdKey(cwd: string): string {
  const normalized = normalize(resolve(cwd))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function sameCwd(left: string, right: string): boolean {
  return left !== '' && right !== '' && cwdKey(left) === cwdKey(right)
}

function loadResult(value: unknown): DshGoLoadResult {
  const load = record(value)
  if (load === undefined || !Array.isArray(load.messages) || typeof load.total !== 'number' || typeof load.truncated !== 'boolean') {
    throw new Error('dsh-go: session.load returned an invalid projection')
  }
  if ((typeof load.journalEpoch !== 'string' && typeof load.journalEpoch !== 'number') || typeof load.lastSeq !== 'number') {
    throw new Error('dsh-go: session.load returned no journal baseline')
  }
  return load as unknown as DshGoLoadResult
}

function defaultModelFromCatalog(value: unknown): string {
  const catalog = record(value)
  if (catalog === undefined || !Array.isArray(catalog.models)) {
    throw new Error('dsh-go: models.catalog.list returned an invalid default model catalog')
  }
  const active = record(catalog.active)
  const model = typeof active?.id === 'string' ? active.id : ''
  if (model === '') throw new Error('dsh-go: session.load has no model and models.catalog.list has no active default model')
  if (!catalog.models.some(row => record(row)?.id === model)) {
    throw new Error(`dsh-go: catalog active default model ${JSON.stringify(model)} is not present in the catalog`)
  }
  return model
}

function sessionSummary(value: unknown): SessionSummary | undefined {
  const row = record(value)
  if (row === undefined) return undefined
  const id = row.id
  if (typeof id !== 'string' || id === '') return undefined
  const cwd = typeof row.cwd === 'string' ? row.cwd : ''
  const listedTitle = typeof row.title === 'string' ? row.title : ''
  const explicitSource = row.titleExplicit === true && (row.titleSource === 'user' || row.titleSource === 'auto')
    ? row.titleSource
    : undefined
  const nativeTitle = explicitSource === undefined ? listedTitle.trim() : listedTitle
  const updatedAt = typeof row.updatedAt === 'string' ? Date.parse(row.updatedAt) : 0
  return {
    id,
    backendId: DSH_GO_BACKEND_ID,
    kind: { kind: 'root' },
    title: explicitSource !== undefined
      ? { text: nativeTitle, source: explicitSource === 'user' ? 'renamed' : 'auto' }
      : nativeTitle !== '' && nativeTitle !== '(无标题)'
        ? { text: nativeTitle, source: 'prompt' }
        : { text: basename(cwd) || id, source: 'fallback' },
    cwd,
    createdAt: 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    bytes: undefined,
    // session.list does not prove the absence of a prompt; keep the row visible.
    hasPrompt: true,
    agentPreset: undefined,
    model: undefined,
    label: undefined,
    branch: undefined,
    childCount: 0,
  }
}

function parsePrefs(value: unknown): PrefsData {
  const parsed = record(value)
  const lastUsed: Record<string, number> = {}
  const used = record(parsed?.lastUsed)
  for (const [id, at] of Object.entries(used ?? {})) {
    if (typeof at === 'number' && Number.isFinite(at)) lastUsed[id] = at
  }
  return {
    ...(typeof parsed?.lastSession === 'string' && parsed.lastSession !== '' ? { lastSession: parsed.lastSession } : {}),
    lastUsed,
  }
}

function createPrefs(host: BackendHost, volatile: { data: PrefsData }): BackendSessionPrefs & { read(): PrefsData } {
  const path = host.dataDir === undefined ? undefined : resolve(host.dataDir, 'prefs.json')
  const read = (): PrefsData => {
    if (path === undefined) return { ...volatile.data, lastUsed: { ...volatile.data.lastUsed } }
    try {
      return parsePrefs(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      return EMPTY_PREFS
    }
  }
  const write = (next: PrefsData): void => {
    if (path === undefined) {
      volatile.data = next
      return
    }
    const temporary = `${path}.${process.pid}.${Date.now()}.${prefsTemporarySequence++}.tmp`
    try {
      mkdirSync(host.dataDir!, { recursive: true })
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      renameSync(temporary, path)
    } catch (error) {
      try { rmSync(temporary, { force: true }) } catch { /* The old prefs remain intact. */ }
      host.debug(`dsh-go: prefs write failed (${messageOf(error)})`)
    }
  }
  const patch = (lastSession: string | null): void => {
    const current = read()
    write({ ...current, ...(lastSession === null ? {} : { lastSession }) })
  }
  return {
    read,
    lastSession: () => read().lastSession,
    setLastSession: sessionId => { patch(sessionId) },
    touch: sessionId => {
      const current = read()
      const lastUsed = Object.fromEntries(Object.entries({ ...current.lastUsed, [sessionId]: Date.now() }).sort((a, b) => b[1] - a[1]).slice(0, 200))
      write({ ...current, lastUsed })
    },
    forget: sessionId => {
      const current = read()
      const lastUsed = { ...current.lastUsed }
      delete lastUsed[sessionId]
      write({ ...(current.lastSession === sessionId ? {} : { lastSession: current.lastSession }), lastUsed })
    },
  }
}

async function terminate(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolveExit => { child.once('exit', () => resolveExit()) })
  child.kill()
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<void>(resolveExpired => {
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      resolveExpired()
    }, 2_000)
    timer.unref()
  })
  await Promise.race([exited, expired])
  if (timer !== undefined) clearTimeout(timer)
}

/** dshd 的启动播报是信息，不是界面错误；其余 stderr 仍走 host.stderr。 */
export function isDshdInfoLine(line: string): boolean {
  const text = line.trim()
  if (text === '') return false
  if (/^工具表[：:]\s*(?:compact|full|merged|lazy)(?:\s|$)/u.test(text)) return true
  if (/^工具\s+\d+\s+个，\d+\s+字节（形态\s+(?:compact|full|merged|lazy)）/u.test(text)) return true
  if (/^policy\s+(?:allow|ask|deny)(?:\s|（|$)/u.test(text)) return true
  return false
}

export function forwardDshdStderr(line: string, host: Pick<BackendHost, 'debug' | 'stderr'>): void {
  if (isDshdInfoLine(line)) host.debug(`dsh-go: dshd info (${line})`)
  else host.stderr?.(line)
}

/**
 * `dshd serve` 的 argv。
 *
 * **策略属于宿主，不属于插件。** 宿主的产品默认是 `allow`（`cmd/dshd/serve.go`，
 * 用户在 2026-11-04 明确要求默认完全权限），所以这里在 `DSH_GO_POLICY` 未设时
 * **一个 `--policy` 都不传**，让那个默认原样生效。
 *
 * 反面教材（t12 修的回归）：本函数以前写 `env.DSH_GO_POLICY?.trim() || 'ask'` 并且
 * 无条件 append，于是"没配"就等于插件替宿主把 `allow` 覆盖成 `ask`——launcher 里
 * 删不删那行都没用，属于脆耦合（宿主改默认也得跟着改插件）。
 *
 * 显式值（`deny` / `ask` / `allow`）仍然原样透传：测试与受控环境要能钉死档位，
 * 只是"未设"不再等于"ask"。空串/纯空白按未设处理，非法值 refuse 而不是静默降级。
 *
 * @param home - `DSH_GO_HOME`（必填，调用方已校验）。
 * @param env - 启动环境。
 * @returns 传给 `dshd` 的参数数组（不含可执行文件本身）。
 * @throws 当 `DSH_GO_POLICY` 既非空也不在 `allow|ask|deny` 内。
 */
export function dshdServeArgs(home: string, env: NodeJS.ProcessEnv): string[] {
  const args = ['serve', '--home', home, '--addr', '127.0.0.1:0']
  const policy = env.DSH_GO_POLICY?.trim()
  if (policy !== undefined && policy !== '') {
    if (!['allow', 'ask', 'deny'].includes(policy)) throw new Error(`dsh-go: unsupported DSH_GO_POLICY ${JSON.stringify(policy)}`)
    args.push('--policy', policy)
  }
  const model = env.DSH_GO_MODEL?.trim()
  if (model !== undefined && model !== '') args.push('--model', model)
  return args
}

async function launchDshd(cwd: string, host: BackendHost, options: DshGoBackendOptions): Promise<DshGoSupervisor> {
  const env = options.env ?? process.env
  const home = env.DSH_GO_HOME?.trim()
  if (home === undefined || home === '') throw new Error('dsh-go: DSH_GO_HOME is required')
  const executable = env.DSH_GO_DSHD?.trim() || 'dshd'
  const args = dshdServeArgs(home, env)
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.on('error', error => { host.debug(`dsh-go: dshd process error (${messageOf(error)})`) })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
    const lines = stderr.split(/\r?\n/u)
    stderr = lines.pop() ?? ''
    for (const line of lines) if (line !== '') forwardDshdStderr(line, host)
  })
  const readyLine = await new Promise<string>((resolveReady, reject) => {
    let stdout = ''
    const timeout = setTimeout(() => { reject(new Error('dsh-go: timed out waiting for the dshd ready line')) }, options.readyTimeoutMs ?? 10_000)
    const finish = (error?: Error, line?: string): void => {
      clearTimeout(timeout)
      if (error !== undefined) reject(error)
      else resolveReady(line!)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const newline = stdout.indexOf('\n')
      if (newline >= 0) finish(undefined, stdout.slice(0, newline).replace(/\r$/u, ''))
    })
    child.once('error', error => { finish(new Error(`dsh-go: could not start dshd (${messageOf(error)})`, { cause: error })) })
    child.once('exit', (code, signal) => { finish(new Error(`dsh-go: dshd exited before ready (code=${String(code)}, signal=${String(signal)})`)) })
  }).catch(async error => {
    await terminate(child)
    throw error
  })
  try {
    const launch = new DshGoLaunch(readyLine)
    const transport = await launch.connect()
    let closed = false
    let broken = false
    const exitListeners = new Set<(error: Error) => void>()
    child.once('exit', (code, signal) => {
      if (closed) return
      closed = true
      broken = true
      const error = new Error(`dsh-go: dshd exited (code=${String(code)}, signal=${String(signal)})`)
      for (const listener of exitListeners) listener(error)
      void transport.close().catch(closeError => { host.debug(`dsh-go: transport close after exit failed (${messageOf(closeError)})`) })
    })
    return {
      transport,
      get broken() { return broken },
      onExit: listener => {
        exitListeners.add(listener)
        if (broken) queueMicrotask(() => { if (exitListeners.has(listener)) listener(new Error('dsh-go: dshd is not running')) })
        return () => { exitListeners.delete(listener) }
      },
      close: async () => {
        if (closed) return
        closed = true
        await transport.close()
        await terminate(child)
      },
      killSync: () => {
        if (closed) return
        closed = true
        child.kill()
      },
    }
  } catch (error) {
    await terminate(child)
    throw error
  }
}

async function detectDshd(host: BackendHost, options: DshGoBackendOptions): Promise<BackendDetection> {
  const env = options.env ?? process.env
  const executable = env.DSH_GO_DSHD?.trim() || 'dshd'
  try {
    const stdout = await new Promise<string>((resolveDetect, reject) => {
      execFile(executable, ['--version'], { env, timeout: 3_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, output) => {
        if (error !== null) reject(error)
        else resolveDetect(output)
      })
    })
    return {
      installed: true,
      auth: 'unknown',
      ...(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u.exec(stdout)?.[0] === undefined ? {} : { version: /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u.exec(stdout)![0] }),
      ...(env.DSH_GO_HOME?.trim() ? {} : { hint: host.locale() === 'zh' ? '设置 DSH_GO_HOME 后启动 DSH-GO。' : 'Set DSH_GO_HOME before opening DSH-GO.' }),
    }
  } catch (error) {
    host.debug(`dsh-go: detection failed (${messageOf(error)})`)
    return { installed: false, hint: host.locale() === 'zh' ? '未找到 dshd；安装 DSH-GO 或设置 DSH_GO_DSHD。' : 'dshd was not found; install DSH-GO or set DSH_GO_DSHD.' }
  }
}

const traceQuit = (message: string): void => {
  if (process.env.DSH_GO_QUIT_TRACE !== '1') return
  process.stderr.write(`[quit-trace ${Date.now()}] ${message}
`)
}

class DshGoSession implements AgentSession {
  readonly ref: AgentSessionRef
  readonly capabilities: AgentSession['capabilities']
  cwd: string
  private state: 'starting' | 'idle' | 'disposed' = 'starting'
  private turnOpen = false
  private disposed = false
  /** 当前模型 id（`session.load` 的 model，切模型后跟着变）。 */
  private currentModel = ''
  private transportSession: SessionTransport | undefined
  private translator: ReturnType<typeof createDshGoEventTranslator>
  private replayHistory: readonly AgentEvent[] | undefined
  private readonly backlog: { events: readonly AgentEvent[]; replay: boolean; seed?: readonly AgentEvent[] }[] = []
  private backlogScheduled = false
  private readonly listeners = new Set<(batch: readonly AgentEvent[], meta: { replay: boolean }) => void>()
  private readonly unsubscribeBroken: () => void
  private readonly pending = new Map<string, PermissionRequestView>()
  private readonly settledPermissions = new Set<string>()
  private readonly placement: DshGoPlacement
  private readonly images: ReturnType<typeof createDshGoImages>
  private readonly effort: ReturnType<typeof createDshGoEffort>
  private readonly modes: ReturnType<typeof createDshGoModes>
  private readonly goals: ReturnType<typeof createDshGoGoals>
  private readonly tasks: ReturnType<typeof createDshGoTasks>
  private readonly subagents: ReturnType<typeof createDshGoSubagents>
  private readonly auth: ReturnType<typeof createDshGoAuth>
  private sideQuery: ReturnType<typeof createDshGoSideQuery>
  private readonly titles: ReturnType<typeof createDshGoRename>
  private readonly colors: ReturnType<typeof createDshGoColor>
  private readonly initCapability: ReturnType<typeof createDshGoInitCapability>
  private readonly workspacePort: DshGoWorkspacePort
  private readonly unsubscribeTasks: () => void
  private readonly unsubscribeGoals: () => void
  private transcriptGeneration = 0
  private resetFrames: (() => void)[] | undefined

  constructor(
    private readonly transport: DshGoTransport,
    private readonly sessionId: string,
    requestedCwd: string,
    private readonly release: () => Promise<void>,
    onBroken: (listener: (error: Error) => void) => () => void,
    private readonly debug: (message: string) => void,
    private readonly locale: BackendHost['locale'],
    private readonly explicitModel: string,
  ) {
    this.ref = { backendId: DSH_GO_BACKEND_ID, sessionId }
    this.cwd = requestedCwd
    this.images = createDshGoImages(this.transport)
    this.translator = createDshGoEventTranslator({ sessionId, images: this.images })
    this.unsubscribeBroken = onBroken(error => { this.onSupervisorBroken(error) })
    this.placement = createDshGoPlacement({
      sessionId,
      call: (method, params) => this.transport.call(method, params),
      emit: events => { this.emit(events, false) },
    })
    const emit = (events: readonly AgentEvent[]): void => { this.emit(events, false) }
    // Effort and permission labels are DSH-GO's own copy, written in the
    // language the host is showing (backend contract, `locale()`). Passing the
    // live accessor — not a snapshot — is what makes `/lang` reach them.
    this.effort = createDshGoEffort(this.transport, this.sessionId, { emit, locale: () => this.locale() })
    this.modes = createDshGoModes(this.transport, this.sessionId, { emit, locale: () => this.locale() })
    this.goals = createDshGoGoals(this.transport, this.sessionId)
    this.tasks = createDshGoTasks(this.transport, this.sessionId)
    this.subagents = createDshGoSubagents()
    this.auth = createDshGoAuth(this.transport, this.sessionId, {
      model: () => this.currentModel,
      locale: this.locale,
      emit,
    })
    this.sideQuery = createDshGoSideQuery(this.sessionId, createDshGoIndependentSideQueryRunner(this.transport))
    this.titles = createDshGoRename(this.transport, this.sessionId, { emit })
    this.colors = createDshGoColor(this.transport, this.sessionId, { emit })
    this.initCapability = createDshGoInitCapability(this.transport, requestedCwd)
    this.workspacePort = createDshGoWorkspacePort(this.transport, this.sessionId, requestedCwd)
    installDshGoWorkspacePort(this.workspacePort)
    this.unsubscribeTasks = this.tasks.subscribe(emit)
    this.unsubscribeGoals = this.goals.subscribe(event => { emit([event]) })
    this.capabilities = {
      native: {
        get dsh() {
          debugLog({ event: 'dshgo.native.dsh.get', backendId: DSH_GO_BACKEND_ID })
          return undefined
        },
      },
      pendingRetraction: { remove: clientMessageId => this.placement.retract(clientMessageId) },
      permissions: {
        respond: (requestId, decision) => { this.respondPermission(requestId, decision) },
        pending: () => [...this.pending.values()],
      },
      questions: {
        respond: (requestId, answers) => {
          if (!this.auth.respondQuestion(requestId, answers)) throw new Error(`dsh-go: question request ${JSON.stringify(requestId)} is not pending`)
        },
        cancel: requestId => {
          if (!this.auth.cancelQuestion(requestId)) throw new Error(`dsh-go: question request ${JSON.stringify(requestId)} is not pending`)
        },
      },
      // 模型选择：dshd 侧本来就有 models.list 与 session.setModel，这里只是把
      // 它接到 TUI 的能力面上——不声明就等于告诉界面"这个内核不支持切模型"，
      // 于是 `/model` 被门控挡掉，而底层明明能用。
      models: {
        list: () => this.listModels(),
        current: () => ({ model: this.currentModel }),
        set: ref => this.setModel(ref),
      },
      effort: this.effort.capability,
      modes: this.modes.capability,
      goals: this.goals.capability,
      compact: createDshGoCompactCapability(this.transport, this.sessionId),
      fork: createDshGoForkCapability(this.transport, this.sessionId),
      rewind: createDshGoRewindCapability(this.transport, this.sessionId),
      tasks: this.tasks.capability,
      subagents: this.subagents.capability,
      images: this.images.capability,
      context: createDshGoContextCapability(this.transport, this.sessionId),
      mcp: createDshGoMcpCapability(this.transport, this.sessionId),
      sideQuery: this.sideQuery.capability,
      auth: this.auth.capability,
      rename: this.titles.capability,
      color: this.colors.capability,
      init: this.initCapability,
    }
    // The non-DSH workspace port is a real session capability. Expose the
    // object itself (not a boolean flag): the TUI core reads these methods
    // through the session capability, across the host-entry IPC boundary.
    Object.assign(this.capabilities, { workspace: this.workspacePort })
  }

  get status(): AgentSessionStatus {
    if (this.disposed) return 'disposed'
    if (this.pending.size > 0) return 'requires-action'
    if (this.turnOpen) return 'running'
    return this.state
  }

  async start(): Promise<void> {
    const queued: (() => void)[] = []
    let opening = true
    const opened = await this.transport.openSession(this.sessionId, {
      onFrame: frame => {
        if (opening) queued.push(() => { this.onFrame(frame) })
        else this.onFrame(frame)
      },
      onReset: (baseline, trigger) => {
        if (opening) queued.push(() => { this.onReset(baseline, trigger) })
        else this.onReset(baseline, trigger)
      },
      onError: error => { this.debug(`dsh-go: session ${this.sessionId} transport (${messageOf(error)})`) },
    })
    this.transportSession = opened.session
    const baseline = loadResult(opened.baseline)
    const initial = this.translateBaseline(opened.baseline)
    const defaultModel = await this.defaultModel(baseline)
    if (defaultModel !== undefined) {
      this.currentModel = defaultModel
      this.effort.noteModel(defaultModel)
    }
    // Populate the real command/registry cache once the IPC session is open;
    // /workspace remove|resolve must not race an empty cache.
    await this.workspacePort.refreshCommands().catch(error => {
      this.debug(`dsh-go: workspace commands refresh failed (${messageOf(error)})`)
    })
    const goalStatePromise = this.goals.get().catch(error => {
      this.debug(`dsh-go: initial goal read failed (${messageOf(error)})`)
      return undefined
    })
    await Promise.all([
      this.effort.refresh().catch(error => { this.debug(`dsh-go: effort catalog refresh failed (${messageOf(error)})`) }),
      this.refreshMetadata(),
    ])
    const goalState = await goalStatePromise
    const title = this.titles.seed()
    const color = this.colors.seed()
    const seeded = initial.map((event): AgentEvent => event.type === 'session.ready'
      ? { ...event, model: this.currentModel, ...(title === undefined ? {} : { title: title.title }) }
      : event)
    if (goalState !== undefined) {
      seeded.push({
        type: 'goal.change', operation: 'snapshot', goal: goalState.goal,
        ...(goalState.roundsStarted === undefined ? {} : { roundsStarted: goalState.roundsStarted }),
      })
    }
    if (title !== undefined) seeded.push(title)
    if (color !== undefined) seeded.push(color)
    this.prepareTranscript(baseline)
    this.replayHistory = seeded
    this.emit(seeded, true, true)
    opening = false
    for (const deliver of queued) deliver()
    this.state = 'idle'
    await this.refreshTasks()
  }

  history(): Promise<readonly AgentEvent[]> {
    const events = this.replayHistory ?? []
    this.replayHistory = undefined
    // Startup's pre-read and the pre-subscribe replay seed are two views of
    // the same baseline; never deliver both.
    for (let index = this.backlog.length - 1; index >= 0; index--) {
      if (this.backlog[index]?.seed !== undefined) this.backlog.splice(index, 1)
    }
    return Promise.resolve(events)
  }

  subscribe(listener: (batch: readonly AgentEvent[], meta: { replay: boolean }) => void): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    this.scheduleBacklog(listener)
    return () => { this.listeners.delete(listener) }
  }

  async submit(input: AgentInput, placement: SubmitPlacement): Promise<{ accepted: boolean; reason?: string; dropped?: boolean }> {
    if (this.disposed) return { accepted: false, reason: 'dsh-go: session is disposed', dropped: true }
    // Validate every block and read every new image before the first upload;
    // placement receives only durable attachment ids in their original order.
    const content = await this.images.content(input)
    return this.placement.submit(content === undefined ? input : { ...input, blocks: content, images: undefined }, placement)
  }

  async cancel(cause: CancelCause): Promise<CancelReceipt> {
    if (this.disposed) return { stillQueued: [], outcome: 'failed' }
    return this.placement.cancel(cause)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    traceQuit('backend.dispose:start')
    this.disposed = true
    this.state = 'disposed'
    installDshGoWorkspacePort(undefined)
    Reflect.deleteProperty(this.capabilities, 'workspace')
    traceQuit('backend.dispose:workspace-port-cleared')
    this.transcriptGeneration += 1
    this.resetFrames = undefined
    this.unsubscribeTasks()
    this.unsubscribeGoals()
    this.tasks.dispose()
    this.subagents.dispose()
    this.goals.dispose()
    this.auth.dispose()
    this.titles.dispose()
    this.colors.dispose()
    this.placement.close()
    const session = this.transportSession
    this.transportSession = undefined
    const sideClose = session === undefined ? Promise.resolve() : this.sideQuery.close().catch(error => {
      this.debug(`dsh-go: side.close during dispose failed (${messageOf(error)})`)
    })
    try {
      traceQuit('backend.dispose:await-side-titles-colors')
      await Promise.all([sideClose, this.titles.idle(), this.colors.idle()])
      traceQuit('backend.dispose:await-session')
      await session?.dispose()
      traceQuit('backend.dispose:session-done')
    } finally {
      this.unsubscribeBroken()
      this.listeners.clear()
      this.backlog.length = 0
      this.replayHistory = undefined
      this.pending.clear()
      traceQuit('backend.dispose:await-release')
      await this.release()
      traceQuit('backend.dispose:end')
    }
  }

  private expandEvents(events: readonly AgentEvent[]): AgentEvent[] {
    const expanded: AgentEvent[] = []
    for (const event of events) expanded.push(event, ...this.subagents.acceptEvent(event))
    return expanded
  }

  private withTranscriptImages(events: readonly AgentEvent[]): readonly AgentEvent[] {
    return events.map(event => {
      if (event.type !== 'user.message' && event.type !== 'assistant.message' && event.type !== 'tool.result') return event
      if (event.images !== undefined) return event
      const content = event.type === 'tool.result' ? event.content : event.blocks
      const idPrefix = event.type === 'user.message' ? event.id : event.type === 'tool.result' ? event.callId : event.attemptId
      const images = this.images.transcript(content, idPrefix)
      return images.length === 0 ? event : { ...event, images }
    })
  }

  private transcriptFromLoad(load: DshGoLoadResult, initialMessages: number): NonNullable<AgentSession['capabilities']['transcript']> {
    const transcript = createDshGoTranscriptCapability(this.sessionId, load, { initialMessages })
    return {
      record: () => {
        const events = transcript.record()
        return events === undefined ? undefined : this.withTranscriptImages(events)
      },
      hasOlder: () => transcript.hasOlder(),
      older: () => this.withTranscriptImages(transcript.older()),
    }
  }

  private prepareTranscript(baseline: DshGoLoadResult): void {
    const generation = ++this.transcriptGeneration
    Reflect.deleteProperty(this.capabilities, 'transcript')
    const initialMessages = baseline.messages.length
    if (!baseline.truncated && baseline.total === baseline.messages.length) {
      try {
        Object.assign(this.capabilities, { transcript: this.transcriptFromLoad(baseline, initialMessages) })
      } catch (error) {
        this.debug(`dsh-go: transcript initialization failed (${messageOf(error)})`)
      }
      return
    }
    // The official capability is synchronous: prefetch every durable page
    // before exposing it, and never turn a partial tail into a full record.
    void readDshGoTranscriptPages(this.transport, this.sessionId).then(history => {
      if (history.status !== 'complete') throw new Error(history.reason ?? 'durable transcript is incomplete')
      const transcript = this.transcriptFromLoad({
        ...baseline,
        messages: history.messages,
        total: history.messages.length,
        truncated: false,
      }, initialMessages)
      if (!this.disposed && generation === this.transcriptGeneration) Object.assign(this.capabilities, { transcript })
    }).catch(error => {
      if (!this.disposed && generation === this.transcriptGeneration) this.debug(`dsh-go: transcript.page initialization failed (${messageOf(error)})`)
    })
  }

  private async refreshMetadata(): Promise<void> {
    const [title, color] = await Promise.allSettled([this.titles.refresh(), this.colors.refresh()])
    if (title.status === 'rejected') this.debug(`dsh-go: title refresh failed (${messageOf(title.reason)})`)
    if (color.status === 'rejected') this.debug(`dsh-go: color refresh failed (${messageOf(color.reason)})`)
  }

  private async refreshTasks(): Promise<void> {
    try {
      await this.tasks.refresh()
    } catch (error) {
      if (!this.disposed) this.debug(`dsh-go: jobs refresh failed (${messageOf(error)})`)
    }
  }

  private translateBaseline(baseline: SessionLoad): readonly AgentEvent[] {
    const load = loadResult(baseline)
    if (typeof load.cwd === 'string' && load.cwd !== '') this.cwd = load.cwd
    // 模型 id 跟着 load 走：切会话/重开/重连之后 `/model` 显示的必须是这一份。
    this.currentModel = typeof load.model === 'string' ? load.model : ''
    this.effort.seed(load)
    this.modes.seed(load)
    return this.expandEvents(this.translator.translateLoad(load))
  }

  private async defaultModel(load: DshGoLoadResult): Promise<string | undefined> {
    if (typeof load.model === 'string' && load.model !== '') return undefined
    if (this.explicitModel !== '') return this.explicitModel
    return defaultModelFromCatalog(await this.transport.call('models.catalog.list', {}))
  }

  /** `/model` 的模型目录：dshd 的 models.list。网关故障原样抛，不吞成空列表。 */
  private async listModels(): Promise<readonly ModelOption[]> {
    const result = record(await this.transport.call('models.list'))
    const rows = Array.isArray(result?.models) ? result.models : []
    const out: ModelOption[] = []
    for (const row of rows) {
      const entry = record(row)
      const id = typeof entry?.ID === 'string' ? entry.ID : typeof entry?.id === 'string' ? entry.id : ''
      if (id === '') continue
      const owner = typeof entry?.OwnedBy === 'string' ? entry.OwnedBy : typeof entry?.ownedBy === 'string' ? entry.ownedBy : typeof entry?.owned_by === 'string' ? entry.owned_by : undefined
      out.push(owner === undefined || owner === '' ? { id, label: id } : { id, label: id, provider: owner })
    }
    return out
  }

  /** 切下一轮用哪个模型；空串 = 清掉覆盖、回到默认。 */
  private async setModel(ref: ModelRef): Promise<ModelSwitchOutcome> {
    const model = typeof ref?.model === 'string' ? ref.model.trim() : ''
    await this.transport.call('session.setModel', { id: this.sessionId, model })
    this.currentModel = model
    this.effort.noteModel(model)
    await this.effort.refresh().catch(error => { this.debug(`dsh-go: effort refresh after model switch failed (${messageOf(error)})`) })
    return { kind: 'switched' }
  }

  private onReset(baseline: SessionLoad, trigger: string): void {
    if (this.disposed) return
    this.settledPermissions.clear()
    const settlements = [...this.pending.keys()].map((requestId): AgentEvent => ({ type: 'permission.settled', requestId, outcome: 'cancelled' }))
    this.turnOpen = false
    this.state = 'idle'
    this.transcriptGeneration += 1
    Reflect.deleteProperty(this.capabilities, 'transcript')
    this.tasks.reset()
    this.subagents.reset()
    const previousSideQuery = this.sideQuery
    const sideClose = previousSideQuery.close()
    this.sideQuery = createDshGoSideQuery(this.sessionId, createDshGoIndependentSideQueryRunner(this.transport))
    Object.assign(this.capabilities, { sideQuery: this.sideQuery.capability })
    void sideClose.catch(error => { this.debug(`dsh-go: side.close during reset failed (${messageOf(error)})`) })
    // A live reset is what makes Channel retire old rows, usage, trajectory
    // and interaction state. The replacement baseline is a separate replay.
    this.emit([...settlements, { type: 'session.reset', trigger: `dsh-go/${trigger}` }], false)
    this.pending.clear()
    const queued: (() => void)[] = []
    this.resetFrames = queued
    // Same-epoch invalid-history rebases must clear dedupe and durable state too.
    this.translator = createDshGoEventTranslator({ sessionId: this.sessionId, images: this.images })
    const replay = this.translateBaseline(baseline)
    this.prepareTranscript(loadResult(baseline))
    const generation = this.transcriptGeneration
    void (async () => {
      const defaultModel = await this.defaultModel(loadResult(baseline))
      if (this.disposed || generation !== this.transcriptGeneration || this.resetFrames !== queued) return
      if (defaultModel !== undefined) {
        this.currentModel = defaultModel
        this.effort.noteModel(defaultModel)
      }
      await Promise.all([
        this.effort.refresh().catch(error => { this.debug(`dsh-go: effort refresh after reset failed (${messageOf(error)})`) }),
        this.refreshMetadata(),
      ])
      if (this.disposed || generation !== this.transcriptGeneration || this.resetFrames !== queued) return
      const title = this.titles.seed()
      const color = this.colors.seed()
      const seeded = replay.map((event): AgentEvent => event.type === 'session.ready'
        ? { ...event, model: this.currentModel, ...(title === undefined ? {} : { title: title.title }) }
        : event)
      if (title !== undefined) seeded.push(title)
      if (color !== undefined) seeded.push(color)
      this.replayHistory = seeded
      this.emit(seeded, true, true)
      this.resetFrames = undefined
      for (const deliver of queued) deliver()
      await this.refreshTasks()
    })().catch(error => {
      if (this.disposed || generation !== this.transcriptGeneration || this.resetFrames !== queued) return
      this.resetFrames = undefined
      this.debug(`dsh-go: baseline default model resolution failed (${messageOf(error)})`)
      this.emit([{ type: 'notice', level: 'error', text: `dsh-go: session reset failed (${messageOf(error)})` }], false)
      for (const deliver of queued) deliver()
    })
  }

  private onFrame(frame: ServerFrame): void {
    if (this.resetFrames !== undefined) {
      this.resetFrames.push(() => { this.onFrame(frame) })
      return
    }
    const title = this.titles.acceptFrame(frame)
    const color = this.colors.acceptFrame(frame)
    this.goals.acceptFrame(frame)
    const events: AgentEvent[] = [...this.placement.observe(frame)]
    if (title !== undefined) events.push(title)
    if (color !== undefined) events.push(color)
    // Valid host metadata/goal frames have their own owner. Malformed frames
    // still take the translator's explicit custom fallback.
    const consumed = frame.type === 'goal/change' || dshGoTitleChange(frame) !== undefined || dshGoColorChange(frame) !== undefined
    const translated = this.translator.translateFrame(frame)
    if (!consumed) events.push(...translated)
    this.emit(this.expandEvents(events), false)
    void this.tasks.acceptFrame(frame).catch(error => {
      if (!this.disposed) this.debug(`dsh-go: jobs refresh after ${frame.type} failed (${messageOf(error)})`)
    })
  }

  private onSupervisorBroken(error: Error): void {
    if (this.disposed) return
    this.settledPermissions.clear()
    const settlements = [...this.pending.keys()].map((requestId): AgentEvent => ({ type: 'permission.settled', requestId, outcome: 'cancelled' }))
    this.turnOpen = false
    this.state = 'idle'
    this.transcriptGeneration += 1
    Reflect.deleteProperty(this.capabilities, 'transcript')
    this.tasks.reset()
    this.subagents.reset()
    this.auth.withdrawAll()
    const dropped = this.placement.close()
    this.emit([...dropped, ...settlements, { type: 'notice', level: 'error', text: `dsh-go: supervisor exited (${messageOf(error)})` }], false)
    this.pending.clear()
  }

  private emit(events: readonly AgentEvent[], replay: boolean, seed = false): void {
    if (this.disposed) return
    const delivered = events.filter(event => event.type !== 'permission.settled' || !this.settledPermissions.has(event.requestId))
    for (const event of delivered) {
      if (event.type === 'permission.request') this.pending.set(event.request.requestId, event.request)
      if (event.type === 'permission.settled') this.pending.delete(event.requestId)
      if (event.type === 'turn.start') this.turnOpen = true
      if (event.type === 'turn.end') this.turnOpen = false
    }
    if (delivered.length === 0) return
    if (this.listeners.size === 0 || this.backlogScheduled) {
      this.backlog.push({ events: delivered, replay, ...(seed ? { seed: events } : {}) })
      return
    }
    for (const listener of this.listeners) this.dispatch(listener, delivered, replay)
  }

  private scheduleBacklog(listener: (batch: readonly AgentEvent[], meta: { replay: boolean }) => void): void {
    if (this.backlogScheduled || this.backlog.length === 0) return
    this.backlogScheduled = true
    queueMicrotask(() => {
      if (this.disposed || !this.listeners.has(listener)) {
        this.backlogScheduled = false
        return
      }
      const entries = this.backlog.splice(0)
      for (const entry of entries) {
        if (entry.seed !== undefined && this.replayHistory === entry.seed) this.replayHistory = undefined
        this.dispatch(listener, entry.events, entry.replay)
      }
      this.backlogScheduled = false
      if (this.backlog.length > 0) this.scheduleBacklog(listener)
    })
  }

  private dispatch(listener: (batch: readonly AgentEvent[], meta: { replay: boolean }) => void, events: readonly AgentEvent[], replay: boolean): void {
    try { listener(events, { replay }) } catch (error) { this.debug(`dsh-go: subscriber failed (${messageOf(error)})`) }
  }

  private respondPermission(requestId: string, decision: PermissionDecision): void {
    const request = this.pending.get(requestId)
    if (request === undefined || this.disposed) throw new Error(`dsh-go: permission request ${JSON.stringify(requestId)} is not pending`)
    const wanted = decision.kind
    const option = decision.kind === 'allow-always' && decision.optionId !== undefined
      ? request.options.find(candidate => candidate.id === decision.optionId && candidate.kind === 'allow-always')
      : request.options.find(candidate => candidate.kind === wanted)
    if (option === undefined) throw new Error(`dsh-go: permission request ${JSON.stringify(requestId)} has no ${wanted} option`)
    if (decision.kind === 'reject' && decision.message !== undefined && decision.message !== '') {
      this.emit([{ type: 'notice', level: 'warning', text: 'dsh-go: rejection feedback text is not transported; the rejection itself will be sent.' }], false)
    }
    void this.transport.call('session.approve', { requestId, optionId: option.id }).then(result => {
      const answer = record(result)
      if (answer?.accepted !== true || answer.optionId !== option.id) throw new Error('dsh-go: session.approve returned an invalid receipt')
      if (!this.pending.delete(requestId) || this.disposed) return
      const outcome: PermissionOutcome = decision.kind === 'reject' ? 'rejected' : decision.kind
      this.emit([{ type: 'permission.settled', requestId, outcome }], false)
      this.settledPermissions.add(requestId)
    }).catch(error => {
      this.emit([{ type: 'notice', level: 'error', text: `dsh-go: approval response failed (${messageOf(error)})` }], false)
    })
  }
}

export function dshGoResumeCommand(sessionId: string): string {
  return `dsh-tui --backend dsh-go --resume ${sessionId}`
}

/** Create an independently owned backend; the default export is the bundle handler. */
async function ensureWorkspaceBinding(transport: { call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> }, cwd: string): Promise<void> {
  try {
    const resolved = record(await transport.call<unknown>('workspace.resolve', { uri: cwd }))
    if (record(record(resolved)?.workspace)?.workspaceId !== undefined) return
  } catch {
    // An unregistered path is the create case; workspace.create below decides.
  }
  try {
    await transport.call('workspace.create', { request: { path: cwd } })
  } catch (error) {
    throw new Error(`dsh-go: workspace binding failed for ${JSON.stringify(cwd)}: ${messageOf(error)}`, { cause: error })
  }
}

export function createDshGoBackend(options: DshGoBackendOptions = {}): AgentBackend {
  let catalogHost: BackendHost | undefined
  const volatile = { data: EMPTY_PREFS as PrefsData }
  const runtimes = new Map<string, Promise<SupervisorRuntime>>()
  const liveRuntimes = new Set<SupervisorRuntime>()
  process.once('exit', () => { for (const runtime of liveRuntimes) { try { runtime.supervisor.killSync() } catch { /* process already exiting */ } } })
  const launch = options.launch ?? ((cwd: string, host: BackendHost) => launchDshd(cwd, host, options))
  const remember = (host: BackendHost): void => { catalogHost = host }
  const fallbackHost = (): BackendHost => catalogHost ?? {
    cwd: process.cwd(), locale: () => 'en' as const, debug: () => undefined, warn: () => undefined,
  }

  const withWorkspace = async <T>(cwd: string, run: (port: DshGoWorkspacePort) => Promise<T>): Promise<T> => {
    const host = fallbackHost()
    const lease = await acquire(cwd, host)
    try {
      return await run(createDshGoWorkspacePort(lease.transport, '', cwd))
    } finally {
      await lease.release()
    }
  }
  let workspaceCommands: readonly import('./workspace.js').DshGoWorkspaceCommand[] = []
  const workspace: DshGoWorkspacePort = {
    list: async cwd => withWorkspace(cwd, port => port.list(cwd)),
    listRegistry: async () => withWorkspace(fallbackHost().cwd, port => port.listRegistry()),
    resolve: async (uri, cwd = fallbackHost().cwd) => withWorkspace(cwd, port => port.resolve(uri)),
    switch: async (target, cwd = target.cwd) => withWorkspace(cwd, port => port.switch(target)),
    renameAt: async (cwd, title) => withWorkspace(cwd, port => port.renameAt(cwd, title)),
    rename: async (title, cwd = fallbackHost().cwd) => withWorkspace(cwd, port => port.rename(title)),
    remove: async cwd => withWorkspace(cwd, port => port.remove(cwd)),
    commands: () => workspaceCommands,
    refreshCommands: async () => undefined,
    runCommand: async (name, input, cwd = fallbackHost().cwd) => withWorkspace(cwd, port => port.runCommand(name, input, cwd)),
  }
  const closeRuntime = (runtime: SupervisorRuntime): Promise<void> => {
    liveRuntimes.delete(runtime)
    runtime.closePromise ??= runtime.supervisor.close()
    return runtime.closePromise
  }

  const acquire = async (cwd: string, host: BackendHost): Promise<SupervisorLease> => {
    const key = cwdKey(cwd)
    for (;;) {
      let pending = runtimes.get(key)
      let reused = true
      if (pending === undefined) {
        reused = false
        pending = launch(cwd, host).then(supervisor => {
          const runtime: SupervisorRuntime = { supervisor, refs: 0, broken: false, brokenListeners: new Set() }
          liveRuntimes.add(runtime)
          runtime.unsubscribeExit = supervisor.onExit?.(error => {
            if (runtime.broken) return
            runtime.broken = true
            runtime.brokenError = error
            if (runtimes.get(key) === pending) runtimes.delete(key)
            const listeners = [...runtime.brokenListeners]
            runtime.brokenListeners.clear()
            for (const listener of listeners) listener(error)
            runtime.unsubscribeExit?.()
            void closeRuntime(runtime).catch(closeError => { host.debug(`dsh-go: broken supervisor close failed (${messageOf(closeError)})`) })
          })
          return runtime
        })
        runtimes.set(key, pending)
      }
      let runtime: SupervisorRuntime
      try {
        runtime = await pending
      } catch (error) {
        if (runtimes.get(key) === pending) runtimes.delete(key)
        throw error
      }
      if (runtime.broken || runtime.supervisor.broken === true) {
        runtime.broken = true
        runtime.brokenError ??= new Error('dsh-go: supervisor is not running')
        if (runtimes.get(key) === pending) runtimes.delete(key)
        runtime.unsubscribeExit?.()
        await closeRuntime(runtime)
        if (reused) continue
        throw runtime.brokenError
      }
      runtime.refs++
      let released = false
      return {
        transport: runtime.supervisor.transport,
        onBroken: listener => {
          runtime.brokenListeners.add(listener)
          if (runtime.broken) {
            queueMicrotask(() => {
              if (runtime.brokenListeners.delete(listener)) listener(runtime.brokenError ?? new Error('dsh-go: supervisor is not running'))
            })
          }
          return () => { runtime.brokenListeners.delete(listener) }
        },
        release: async () => {
          if (released) return
          released = true
          runtime.refs--
          if (runtime.refs > 0) return
          if (runtimes.get(key) === pending) runtimes.delete(key)
          runtime.unsubscribeExit?.()
          await closeRuntime(runtime)
        },
      }
    }
  }

  const open = async (target: OpenTarget, host: BackendHost): Promise<AgentSession> => {
    remember(host)
    const cwd = target.cwd ?? host.cwd
    const explicitModel = (options.env ?? process.env).DSH_GO_MODEL?.trim() ?? ''
    const lease = await acquire(cwd, host)
    let session: DshGoSession | undefined
    try {
      let sessionId: string
      if (target.kind === 'create') {
        const created = record(await lease.transport.call('session.create', { mode: 'default' }))
        if (typeof created?.sessionId !== 'string' || created.sessionId === '') throw new Error('dsh-go: session.create returned no sessionId')
        sessionId = created.sessionId
      } else {
        sessionId = target.sessionId
      }
      // A resume failure propagates from session.load; there is no create fallback.
      session = new DshGoSession(lease.transport, sessionId, cwd, lease.release, lease.onBroken, host.debug, host.locale, explicitModel)
      await session.start()
      await ensureWorkspaceBinding(lease.transport, cwd)
      return session
    } catch (error) {
      debugLog({
        event: 'backend.open.error',
        target,
        cwd,
        explicitModel,
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack, ...(Object.hasOwn(error, 'code') ? { code: (error as { code?: unknown }).code } : {}), ...(Object.hasOwn(error, 'hint') ? { hint: (error as { hint?: unknown }).hint } : {}), ...(Object.hasOwn(error, 'status') ? { status: (error as { status?: unknown }).status } : {}), ...(Object.hasOwn(error, 'retryable') ? { retryable: (error as { retryable?: unknown }).retryable } : {}) }
          : String(error),
      })
      if (session !== undefined) await session.dispose()
      else await lease.release()
      throw error
    }
  }

  const catalog: SessionCatalog = {
    snapshotKey: () => {
      const home = (options.env ?? process.env).DSH_GO_HOME?.trim()
      return home === undefined || home === '' ? undefined : `dsh-go:${cwdKey(home)}`
    },
    async list(scope: SessionListScope = {}, onPartial?: (rows: readonly SessionSummary[]) => void): Promise<readonly SessionSummary[]> {
      const host = fallbackHost()
      const lease = await acquire(scope.allProjects === true ? host.cwd : scope.cwd ?? host.cwd, host)
      try {
        const answer = record(await lease.transport.call('session.list', {}))
        if (!Array.isArray(answer?.sessions)) throw new Error('dsh-go: session.list returned no sessions array')
        const scopeCwd = scope.allProjects === true ? undefined : scope.cwd ?? host.cwd
        const lastUsed = createPrefs(host, volatile).read().lastUsed
        const rows = answer.sessions.map(sessionSummary).filter((row): row is SessionSummary => row !== undefined)
          .filter(row => scopeCwd === undefined || sameCwd(row.cwd, scopeCwd))
          .map(row => {
            const used = lastUsed[row.id]
            return used === undefined ? row : { ...row, updatedAt: Math.max(row.updatedAt, used) }
          })
          .sort((a, b) => b.updatedAt - a.updatedAt)
        onPartial?.(rows)
        return rows
      } finally {
        await lease.release()
      }
    },
    async info(sessionId: string, cwd?: string): Promise<SessionSummary | undefined> {
      const rows = await catalog.list!({ ...(cwd === undefined ? { allProjects: true } : { cwd }) })
      return rows.find(row => row.id === sessionId)
    },
    async preview(sessionId: string, previewOptions: { cwd?: string; limit?: number } = {}): Promise<readonly PreviewEntry[]> {
      const limit = Math.max(0, Math.min(20, previewOptions.limit ?? 6))
      if (limit === 0) return []
      const host = fallbackHost()
      const lease = await acquire(previewOptions.cwd ?? host.cwd, host)
      try {
        const load = loadResult(await lease.transport.call('session.load', { id: sessionId, tailMessages: limit }))
        return load.messages.filter(message => message.role === 'user' || message.role === 'assistant').slice(-limit).map(message => ({
          role: message.role as 'user' | 'assistant', text: message.text, at: message.time,
        }))
      } finally {
        await lease.release()
      }
    },
    async delete(sessionId: string, cwd?: string): Promise<void> {
      const host = fallbackHost()
      const lease = await acquire(cwd ?? host.cwd, host)
      try {
        await lease.transport.call('session.delete', { id: sessionId })
        createPrefs(host, volatile).forget(sessionId)
      } finally {
        await lease.release()
      }
    },
  }

  return {
    id: DSH_GO_BACKEND_ID,
    descriptor: { label: DSH_GO_BACKEND_LABEL },
    detect: async host => {
      remember(host)
      try {
        return options.detect === undefined ? await detectDshd(host, options) : await options.detect(host)
      } catch (error) {
        host.debug(`dsh-go: detection failed (${messageOf(error)})`)
        return { installed: false }
      }
    },
    open,
    catalog,
    workspace,
    launch: {
      sessionPrefs: host => {
        remember(host)
        return createPrefs(host, volatile)
      },
      resumeCommand: dshGoResumeCommand,
    },
  } as AgentBackend & { workspace: DshGoWorkspacePort }
}

export const backend: AgentBackend = createDshGoBackend()
