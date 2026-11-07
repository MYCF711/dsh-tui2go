import type { AgentEvent, AgentEventOf } from './types/agent/events.js'

/** The real jobs.list row, scoped to the session that owns this translator. */
export interface DshGoTaskJob {
  readonly id: string
  readonly sessionId: string
  readonly command: string
  readonly done: boolean
  readonly exitCode: number
  readonly bytes: number
}

interface TaskEntry {
  readonly job: DshGoTaskJob
  readonly stopped: boolean
}

const sameLiveSet = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false
  const wanted = new Set(left)
  return right.every(id => wanted.has(id))
}

const taskEnd = (job: DshGoTaskJob, stopped: boolean, time: number): AgentEventOf<'task.end'> => ({
  type: 'task.end',
  taskId: job.id,
  status: stopped ? 'stopped' : job.exitCode === 0 ? 'completed' : 'failed',
  summary: `exit code: ${job.exitCode}`,
  time,
})

/**
 * Project authoritative jobs.list snapshots into the official live-task event
 * vocabulary. Completed rows stay visible through their start/end events;
 * tasks.snapshot itself contains live ids only, as the shared projector expects.
 */
export function createDshGoTaskEventTranslator(now: () => number = Date.now) {
  let entries = new Map<string, TaskEntry>()
  let liveIds: readonly string[] = []
  let initialized = false

  const apply = (jobs: readonly DshGoTaskJob[]): readonly AgentEvent[] => {
    const time = now()
    const events: AgentEvent[] = []
    const next = new Map<string, TaskEntry>()
    for (const job of jobs) {
      if (next.has(job.id)) throw new Error(`dsh-go: duplicate job id ${JSON.stringify(job.id)}`)
      const previous = entries.get(job.id)
      if (previous?.job.done === true && !job.done) {
        throw new Error(`dsh-go: job ${JSON.stringify(job.id)} changed from done to running`)
      }
      const stopped = previous?.stopped === true
      next.set(job.id, { job, stopped })
      if (previous === undefined) {
        events.push({
          type: 'task.start',
          taskId: job.id,
          kind: 'shell',
          description: job.command || job.id,
          ...(job.command === '' ? {} : { command: job.command }),
          background: true,
          time,
        })
      } else if (previous.job.command !== job.command && !job.done) {
        events.push({ type: 'task.update', taskId: job.id, patch: { description: job.command || job.id } })
      }
      if (job.done && previous?.job.done !== true) events.push(taskEnd(job, stopped, time))
    }
    const nextLive = jobs.filter(job => !job.done).map(job => job.id)
    if (!initialized || !sameLiveSet(liveIds, nextLive)) {
      events.push({ type: 'tasks.snapshot', taskIds: nextLive })
    }
    entries = next
    liveIds = nextLive
    initialized = true
    return events
  }

  return {
    apply,
    /** A confirmed jobs.stop receipt, not an optimistic local cancellation. */
    stop(job: DshGoTaskJob): readonly AgentEvent[] {
      const previous = entries.get(job.id)
      if (previous === undefined || previous.job.done) return []
      const stopped = { ...job, done: true }
      entries.set(job.id, { job: stopped, stopped: true })
      const nextLive = liveIds.filter(id => id !== job.id)
      const events: AgentEvent[] = [taskEnd(stopped, true, now())]
      if (!sameLiveSet(liveIds, nextLive)) events.push({ type: 'tasks.snapshot', taskIds: nextLive })
      liveIds = nextLive
      return events
    },
    reset(): void {
      entries = new Map()
      liveIds = []
      initialized = false
    },
  }
}

export const DSH_GO_SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork'])

function subagentDescription(argsJson: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(argsJson)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const description = (parsed as Record<string, unknown>).description
      if (typeof description === 'string' && description.trim() !== '') return description.trim()
    }
  } catch {
    // The real tool call remains visible even when its arguments are malformed.
  }
  return fallback
}

/** Derive only the lifecycle proved by DSH-GO's synchronous delegation tools. */
export function createDshGoSubagentEventTranslator() {
  const active = new Set<string>()
  return {
    accept(event: AgentEvent): readonly AgentEvent[] {
      if (event.type === 'tool.call' && DSH_GO_SUBAGENT_TOOLS.has(event.name)) {
        if (active.has(event.callId)) return []
        if (active.size >= 200) {
          const oldest = active.values().next().value
          if (typeof oldest === 'string') active.delete(oldest)
        }
        active.add(event.callId)
        return [{
          type: 'subagent.start',
          agentId: event.callId,
          parentCallId: event.callId,
          description: subagentDescription(event.argsJson, event.name),
          kind: event.name,
          background: false,
          depth: 1,
          time: event.time,
        }]
      }
      if (event.type === 'tool.result' && active.delete(event.callId)) {
        const summary = event.isError ? event.errorText ?? event.text : event.text
        return [{
          type: 'subagent.end',
          agentId: event.callId,
          status: event.isError ? 'failed' : 'completed',
          ...(summary === '' ? {} : { summary }),
          time: event.time,
        }]
      }
      return []
    },
    reset(): void { active.clear() },
  }
}

/**
 * Return only the proven appended suffix of two bounded output tails. Undefined
 * means the texts diverged and an append-only task.output would fabricate or
 * duplicate content; callers can still serve the new tail through readOutput.
 */
export function dshGoAppendedOutput(previous: string | undefined, next: string): string | undefined {
  if (previous === undefined) return next
  if (next === previous) return ''
  if (next.startsWith(previous)) return next.slice(previous.length)

  // Longest suffix(previous) that is prefix(next), in linear time. This also
  // recognizes a sliding bounded tail without splitting Unicode code points.
  const prefix = new Uint32Array(next.length)
  for (let index = 1, matched = 0; index < next.length; index += 1) {
    while (matched > 0 && next[index] !== next[matched]) matched = prefix[matched - 1]!
    if (next[index] === next[matched]) matched += 1
    prefix[index] = matched
  }
  let overlap = 0
  for (let index = 0; index < previous.length; index += 1) {
    while (overlap > 0 && previous[index] !== next[overlap]) overlap = prefix[overlap - 1]!
    if (previous[index] === next[overlap]) overlap += 1
    if (overlap === next.length) break
  }
  return overlap === 0 ? undefined : next.slice(overlap)
}
