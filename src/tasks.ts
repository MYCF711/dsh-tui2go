import type { SessionCapabilities } from './types/agent/capabilities.js'
import type { AgentEvent } from './types/agent/events.js'
import {
  createDshGoTaskEventTranslator,
  dshGoAppendedOutput,
  type DshGoTaskJob,
} from './task-events.js'
import type { ServerFrame } from './transport.js'

export const DSH_GO_JOB_OUTPUT_TAIL = 64 * 1024

/** Only the authenticated Transport surface used by background jobs. */
export interface DshGoTasksTransport {
  call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T>
}

export interface DshGoJobOutputTail {
  readonly id: string
  readonly sessionId: string
  readonly output: string
  readonly done: boolean
  readonly exitCode: number
  readonly cursor: number
  readonly nextCursor: number
  readonly total: number
  readonly truncated: boolean
}

interface ParsedJobs {
  readonly jobs: readonly DshGoTaskJob[]
  /** Empty global inventory or a list containing this session is authoritative. */
  readonly authoritative: boolean
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
const nonNegative = (value: unknown): value is number => integer(value) && value >= 0
const runeCount = (text: string): number => Array.from(text).length
const invalid = (method: string, detail = 'returned an invalid result'): Error => new Error(`dsh-go: ${method} ${detail}`)

function parseJobs(value: unknown, sessionId: string): ParsedJobs {
  const result = record(value)
  if (result === undefined || !Array.isArray(result.jobs)) throw invalid('jobs.list', 'returned no jobs array')
  const jobs: DshGoTaskJob[] = []
  let authoritative = result.jobs.length === 0
  for (const [index, raw] of result.jobs.entries()) {
    const row = record(raw)
    if (
      row === undefined || typeof row.id !== 'string' || row.id === ''
      || typeof row.command !== 'string' || typeof row.done !== 'boolean'
      || !integer(row.exit_code) || !nonNegative(row.bytes)
      || (row.sessionId !== undefined && (typeof row.sessionId !== 'string' || row.sessionId === ''))
    ) throw invalid('jobs.list', `returned an invalid row at index ${index}`)
    if (row.sessionId === sessionId) authoritative = true
    // A missing/other session id is not evidence about this session. Never
    // borrow a globally unique-looking id for a cross-session stop or output.
    if (row.sessionId !== sessionId) continue
    jobs.push({
      id: row.id,
      sessionId,
      command: row.command,
      done: row.done,
      exitCode: row.exit_code,
      bytes: row.bytes,
    })
  }
  return { jobs, authoritative }
}

function parseOutputPage(
  value: unknown,
  sessionId: string,
  id: string,
  cursor: number,
  limit: number,
): DshGoJobOutputTail & { readonly hasMore: boolean } {
  const row = record(value)
  if (
    row === undefined || row.id !== id || row.sessionId !== sessionId
    || typeof row.output !== 'string' || typeof row.done !== 'boolean' || !integer(row.exit_code)
    || !nonNegative(row.cursor) || row.cursor !== cursor
    || !nonNegative(row.nextCursor) || !nonNegative(row.total)
    || typeof row.hasMore !== 'boolean'
    || (row.truncated !== undefined && typeof row.truncated !== 'boolean')
  ) throw invalid('jobs.output')
  const count = runeCount(row.output)
  if (
    count > limit || row.nextCursor !== cursor + count || row.nextCursor > row.total
    || row.hasMore !== (row.nextCursor < row.total)
  ) throw invalid('jobs.output', 'returned an inconsistent rune page')
  return {
    id,
    sessionId,
    output: row.output,
    done: row.done,
    exitCode: row.exit_code,
    cursor: row.cursor,
    nextCursor: row.nextCursor,
    total: row.total,
    truncated: row.truncated === true,
    hasMore: row.hasMore,
  }
}

/**
 * Read the actual output tail in at most two bounded RPCs. The one-rune probe
 * discovers the host's current rune total; the second read selects the suffix.
 * truncated describes the host's dropped prefix and is never hidden or replaced
 * with fabricated output text.
 */
export async function readDshGoJobOutputTail(
  transport: DshGoTasksTransport,
  sessionId: string,
  id: string,
  tailRunes = DSH_GO_JOB_OUTPUT_TAIL,
): Promise<DshGoJobOutputTail> {
  if (sessionId === '' || id === '') throw new Error('dsh-go: jobs.output requires sessionId and id')
  if (!Number.isSafeInteger(tailRunes) || tailRunes <= 0 || tailRunes > DSH_GO_JOB_OUTPUT_TAIL) {
    throw new Error(`dsh-go: jobs.output tailRunes must be within 1..${DSH_GO_JOB_OUTPUT_TAIL}`)
  }
  const probe = parseOutputPage(
    await transport.call<unknown>('jobs.output', { sessionId, id, cursor: 0, limit: 1 }),
    sessionId,
    id,
    0,
    1,
  )
  if (!probe.hasMore) return probe
  const cursor = Math.max(0, probe.total - tailRunes)
  const tail = parseOutputPage(
    await transport.call<unknown>('jobs.output', { sessionId, id, cursor, limit: tailRunes }),
    sessionId,
    id,
    cursor,
    tailRunes,
  )
  if (tail.hasMore) {
    throw new Error('dsh-go: jobs.output advanced beyond the requested tail; retry the read')
  }
  return { ...tail, truncated: probe.truncated || tail.truncated }
}

function stopResult(value: unknown, sessionId: string, id: string, command: string, bytes: number): DshGoTaskJob {
  const row = record(value)
  if (
    row === undefined || row.id !== id || row.sessionId !== sessionId
    || row.stopped !== true || row.done !== true || !integer(row.exit_code)
  ) throw invalid('jobs.stop', 'did not confirm stopped=true and done=true')
  return { id, sessionId, command, done: true, exitCode: row.exit_code, bytes }
}

export interface DshGoTasksOptions {
  readonly now?: () => number
  readonly tailRunes?: number
}

/**
 * Session-scoped jobs capability. WS/journal tool and turn frames trigger a
 * real jobs.list/output refresh; they are not relabelled as native task events.
 */
export function createDshGoTasks(
  transport: DshGoTasksTransport,
  sessionId: string,
  options: DshGoTasksOptions = {},
) {
  if (sessionId === '') throw new Error('dsh-go: tasks require a session id')
  const now = options.now ?? Date.now
  const tailRunes = options.tailRunes ?? DSH_GO_JOB_OUTPUT_TAIL
  if (!Number.isSafeInteger(tailRunes) || tailRunes <= 0 || tailRunes > DSH_GO_JOB_OUTPUT_TAIL) {
    throw new Error(`dsh-go: jobs.output tailRunes must be within 1..${DSH_GO_JOB_OUTPUT_TAIL}`)
  }
  const translator = createDshGoTaskEventTranslator(now)
  const listeners = new Set<(events: readonly AgentEvent[]) => void>()
  const outputs = new Map<string, string>()
  let jobs = new Map<string, DshGoTaskJob>()
  let refreshing: Promise<readonly AgentEvent[]> | undefined
  let generation = 0
  let disposed = false

  const publish = (events: readonly AgentEvent[]): readonly AgentEvent[] => {
    if (events.length === 0 || disposed) return events
    for (const listener of [...listeners]) listener(events)
    return events
  }

  const readTail = async (id: string): Promise<DshGoJobOutputTail> => {
    if (disposed) throw new Error('dsh-go: tasks are disposed')
    const result = await readDshGoJobOutputTail(transport, sessionId, id, tailRunes)
    if (disposed) throw new Error('dsh-go: tasks are disposed')
    return result
  }

  const refresh = (): Promise<readonly AgentEvent[]> => {
    if (disposed) return Promise.resolve([])
    if (refreshing !== undefined) return refreshing
    const epoch = generation
    const request = (async (): Promise<readonly AgentEvent[]> => {
      const parsed = parseJobs(await transport.call<unknown>('jobs.list', {}), sessionId)
      if (disposed || epoch !== generation) return []
      if (!parsed.authoritative) return []
      const nextJobs = new Map(parsed.jobs.map(job => [job.id, job]))
      const nextOutputs = new Map<string, string>()
      const outputEvents: AgentEvent[] = []
      // Read only new/changed output. All reads succeed before any list/event
      // state advances, so an HTTP or shape error cannot look like an empty list.
      for (const job of parsed.jobs) {
        const previousJob = jobs.get(job.id)
        const previousOutput = outputs.get(job.id)
        if (previousJob?.bytes === job.bytes && previousJob.done === job.done && previousOutput !== undefined) {
          nextOutputs.set(job.id, previousOutput)
          continue
        }
        if (job.bytes === 0) {
          nextOutputs.set(job.id, previousOutput ?? '')
          continue
        }
        const page = await readDshGoJobOutputTail(transport, sessionId, job.id, tailRunes)
        if (disposed || epoch !== generation) return []
        if (page.done !== job.done || page.exitCode !== job.exitCode) {
          throw new Error(`dsh-go: jobs.output status disagrees with jobs.list for ${JSON.stringify(job.id)}`)
        }
        nextOutputs.set(job.id, page.output)
        const appended = dshGoAppendedOutput(previousOutput, page.output)
        if (appended !== undefined && appended !== '') {
          outputEvents.push({ type: 'task.output', taskId: job.id, text: appended, time: now() })
        }
      }
      const events = [...translator.apply(parsed.jobs), ...outputEvents]
      if (disposed || epoch !== generation) return []
      jobs = nextJobs
      outputs.clear()
      for (const [id, output] of nextOutputs) outputs.set(id, output)
      return publish(events)
    })()
    refreshing = request
    void request.finally(() => { if (refreshing === request) refreshing = undefined }).catch(() => undefined)
    return request
  }

  const capability: NonNullable<SessionCapabilities['tasks']> = {
    async stop(id): Promise<boolean> {
      const job = jobs.get(id)
      if (disposed || job === undefined || job.done) return false
      const epoch = generation
      const result = stopResult(
        await transport.call<unknown>('jobs.stop', { sessionId, id }),
        sessionId,
        id,
        job.command,
        job.bytes,
      )
      if (disposed || epoch !== generation) return false
      jobs.set(id, result)
      publish(translator.stop(result))
      return true
    },
    readOutput: async id => (await readTail(id)).output,
  }

  return {
    capability,
    refresh,
    readOutputTail: readTail,
    /** A real journal frame is only a refresh trigger. */
    async acceptFrame(frame: ServerFrame): Promise<boolean> {
      if (disposed || !['tool/result', 'turn/end', 'turn/done', 'turn/error'].includes(frame.type)) return false
      await refresh()
      return true
    },
    subscribe(listener: (events: readonly AgentEvent[]) => void): () => void {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    reset(): void {
      generation += 1
      refreshing = undefined
      jobs = new Map()
      outputs.clear()
      translator.reset()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      generation += 1
      refreshing = undefined
      jobs = new Map()
      outputs.clear()
      translator.reset()
      listeners.clear()
    },
  }
}
