import type { SessionCapabilities } from './types/agent/capabilities.js'
import type { AgentEventOf, GoalSnapshot } from './types/agent/events.js'
import type { ServerFrame } from './transport.js'

/** Existing goal mutations plus the additive read/pause/resume host methods. */
export interface DshGoGoalsTransport {
  call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T>
}

export interface DshGoGoalState {
  readonly goal: GoalSnapshot
  readonly roundsStarted?: number
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const nonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const text = (value: unknown): value is string => typeof value === 'string'

function goalSnapshot(value: unknown): GoalSnapshot | undefined {
  const goal = record(value)
  if (
    goal === undefined || text(goal.id) === false || goal.id === ''
    || !nonNegative(goal.revision) || !text(goal.objective)
    || !nonNegative(goal.maxGoalRounds)
    || (goal.phase !== 'active' && goal.phase !== 'paused' && goal.phase !== 'blocked' && goal.phase !== 'complete')
  ) return undefined

  let blockedReason: GoalSnapshot['blockedReason']
  if (goal.phase === 'blocked') {
    const reason = record(goal.blockedReason)
    if (reason === undefined || !text(reason.code) || !text(reason.message)) return undefined
    blockedReason = { code: reason.code, message: reason.message }
  } else if (goal.blockedReason !== undefined) return undefined

  let budget: GoalSnapshot['budget']
  if (goal.budget !== undefined) {
    const raw = record(goal.budget)
    if (
      raw === undefined || !nonNegative(raw.tokensUsed) || !nonNegative(raw.timeUsedSeconds)
      || (raw.tokenBudget !== null && !nonNegative(raw.tokenBudget))
    ) return undefined
    budget = {
      tokensUsed: raw.tokensUsed,
      tokenBudget: raw.tokenBudget as number | null,
      timeUsedSeconds: raw.timeUsedSeconds,
    }
  }

  return {
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    maxGoalRounds: goal.maxGoalRounds,
    ...(blockedReason === undefined ? {} : { blockedReason }),
    ...(budget === undefined ? {} : { budget }),
  }
}

/** Parse a real host goal.get result; no snapshot is synthesized from text. */
export function dshGoGoalState(value: unknown): DshGoGoalState | undefined {
  const result = record(value)
  if (result === undefined || !Object.hasOwn(result, 'goal') || result.goal === null) return undefined
  const goal = goalSnapshot(result.goal)
  if (goal === undefined) return undefined
  if (result.roundsStarted !== undefined && !nonNegative(result.roundsStarted)) return undefined
  return { goal, ...(result.roundsStarted === undefined ? {} : { roundsStarted: result.roundsStarted as number }) }
}

/**
 * Translate only an actual Transport goal/change frame. Mutation RPC responses
 * deliberately never come through this function and never create goal events.
 */
export function dshGoGoalChange(frame: ServerFrame): AgentEventOf<'goal.change'> | undefined {
  if (frame.type !== 'goal/change') return undefined
  const change = record(frame.data)
  if (
    change === undefined || change.kind !== 'goal/change' || !nonNegative(change.version)
    || !text(change.operation) || change.operation === ''
    || (change.roundsStarted !== undefined && !nonNegative(change.roundsStarted))
  ) return undefined
  if (change.operation === 'clear') {
    if (change.goal !== undefined && change.goal !== null) return undefined
    return {
      type: 'goal.change', operation: change.operation,
      ...(change.roundsStarted === undefined ? {} : { roundsStarted: change.roundsStarted as number }),
    }
  }
  if (change.operation === 'round') {
    if (!nonNegative(change.round) || (change.goal !== undefined && change.goal !== null)) return undefined
    return { type: 'goal.change', operation: 'round', round: change.round }
  }
  const goal = goalSnapshot(change.goal)
  if (goal === undefined) return undefined
  return {
    type: 'goal.change', operation: change.operation, goal,
    ...(change.roundsStarted === undefined ? {} : { roundsStarted: change.roundsStarted as number }),
  }
}

export function createDshGoGoals(transport: DshGoGoalsTransport, sessionId: string) {
  const listeners = new Set<(event: AgentEventOf<'goal.change'>) => void>()
  let disposed = false

  const capability: NonNullable<SessionCapabilities['goals']> = {
    async set(objective, options) {
      if (objective.trim() === '') throw new Error('dsh-go: goal objective is empty')
      if (options?.tokenBudget !== undefined) {
        throw new Error('dsh-go: token-budgeted goals are unsupported by session.setGoal')
      }
      await transport.call('session.setGoal', { id: sessionId, goal: objective })
    },
    pause: () => transport.call('session.goal.pause', { id: sessionId }),
    resume: () => transport.call('session.goal.resume', { id: sessionId }),
    clear: async () => {
      await transport.call('session.setGoal', { id: sessionId, goal: '' })
    },
  }

  return {
    capability,
    /** Read the authoritative snapshot; reading never emits goal.change. */
    async get(): Promise<DshGoGoalState | undefined> {
      const result = await transport.call<unknown>('session.goal.get', { id: sessionId })
      if (record(result)?.goal === null) return undefined
      const state = dshGoGoalState(result)
      if (state === undefined) throw new Error('dsh-go: session.goal.get returned an invalid goal snapshot')
      return state
    },
    /**
     * Feed one real session WS/history frame. Subscribers run only for a valid
     * host-originated goal/change; other and malformed frames return undefined.
     */
    acceptFrame(frame: ServerFrame): AgentEventOf<'goal.change'> | undefined {
      if (disposed || frame.type !== 'goal/change') return undefined
      const event = dshGoGoalChange(frame)
      if (event === undefined) return undefined
      for (const listener of [...listeners]) listener(event)
      return event
    },
    subscribe(listener: (event: AgentEventOf<'goal.change'>) => void): () => void {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose(): void {
      disposed = true
      listeners.clear()
    },
  }
}
