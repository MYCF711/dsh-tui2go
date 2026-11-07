import type { AgentEvent, PendingItem } from './types/agent/events.js'
import type { AgentInput, CancelCause, CancelReceipt, SubmitPlacement } from './types/agent/session.js'
import { DshGoTransportError, type ServerFrame } from './transport.js'

export interface DshGoSubmitResult {
  readonly accepted: boolean
  readonly reason?: string
  readonly dropped?: boolean
}

export interface DshGoPlacementOptions {
  readonly sessionId: string
  call(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown>
  emit(events: readonly AgentEvent[]): void
}

type EntryStatus = 'awaiting' | 'active' | 'queued' | 'steered' | 'settled'

interface Entry {
  readonly id: string
  readonly text: string
  readonly requested: SubmitPlacement
  readonly busy: boolean
  readonly nowOwner: boolean
  readonly previousActiveId?: string
  ack: boolean
  turnId?: string
  status: EntryStatus
  claimed: boolean
  retracting: boolean
}

interface ParsedCancel {
  readonly cancelled: boolean
  readonly turnId?: string
  readonly cancelledQueued: readonly string[]
  readonly stillQueued: readonly string[]
  readonly outcome: CancelReceipt['outcome']
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

const stringArray = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every(id => typeof id === 'string') ? value as string[] : undefined

function parseCancel(value: unknown): ParsedCancel | undefined {
  const result = record(value)
  if (result === undefined || typeof result.cancelled !== 'boolean') return undefined
  const outcome = result.outcome
  if (outcome !== 'confirmed' && outcome !== 'unknown' && outcome !== 'failed') return undefined
  const stillQueued = stringArray(result.stillQueued)
  if (stillQueued === undefined) return undefined
  const cancelledQueued = result.cancelledQueued === undefined ? [] : stringArray(result.cancelledQueued)
  if (cancelledQueued === undefined) return undefined
  return {
    cancelled: result.cancelled,
    ...(typeof result.turnId === 'string' ? { turnId: result.turnId } : {}),
    cancelledQueued,
    stillQueued,
    outcome,
  }
}

/** DSH-GO placement and the client-id shadow of its turn-id-owned queue. */
export function createDshGoPlacement(options: DshGoPlacementOptions) {
  const entries = new Map<string, Entry>()
  const byTurn = new Map<string, string>()
  const finishedTurns = new Set<string>()
  let activeId: string | undefined
  let activeTurnId: string | undefined
  let turnOpen = false

  const pendingEntries = (): Entry[] => [...entries.values()].filter(entry => entry.status !== 'settled' && !entry.claimed)
  const pendingIds = (): string[] => pendingEntries().map(entry => entry.id)
  const items = (): PendingItem[] => pendingEntries().map(entry => ({
    id: entry.id,
    text: entry.text,
    placement: entry.requested === 'steer' ? 'steer' : 'followup',
  }))
  const changed = (change: { claimed?: readonly string[]; discarded?: readonly string[]; dropped?: readonly string[] }): AgentEvent =>
    ({ type: 'pending.changed', items: items(), ...change })
  const emitChange = (change: { claimed?: readonly string[]; discarded?: readonly string[]; dropped?: readonly string[] }): void => {
    options.emit([changed(change)])
  }
  const rememberFinished = (turnId: string): void => {
    finishedTurns.delete(turnId)
    finishedTurns.add(turnId)
    if (finishedTurns.size <= 256) return
    const oldest = finishedTurns.values().next().value
    if (oldest !== undefined) finishedTurns.delete(oldest)
  }
  const forget = (entry: Entry): void => {
    entry.status = 'settled'
    entries.delete(entry.id)
    if (entry.turnId !== undefined && byTurn.get(entry.turnId) === entry.id) byTurn.delete(entry.turnId)
    if (activeId === entry.id) {
      activeId = undefined
      activeTurnId = undefined
    }
  }
  const settle = (entry: Entry): void => {
    entry.status = 'settled'
    if (entry.turnId !== undefined) rememberFinished(entry.turnId)
    if (entry.ack) {
      forget(entry)
      return
    }
    if (activeId === entry.id) {
      activeId = undefined
      activeTurnId = undefined
    }
  }
  const retire = (retiring: readonly Entry[]): { claimed: string[]; discarded: string[] } => {
    const claimed: string[] = []
    const discarded: string[] = []
    for (const entry of retiring) {
      if (entry.status === 'settled') continue
      if (entry.claimed) claimed.push(entry.id)
      else discarded.push(entry.id)
      settle(entry)
    }
    return { claimed, discarded }
  }

  const promote = (): void => {
    if (activeId !== undefined) return
    const now = [...entries.values()].find(entry => entry.status !== 'settled' && entry.nowOwner
      && (entry.status === 'awaiting' || entry.status === 'queued'))
    const next = now ?? [...entries.values()].find(entry => entry.status === 'queued'
      || (entry.status === 'awaiting' && entry.busy && entry.requested === 'followup'))
    if (next === undefined) {
      activeTurnId = undefined
      return
    }
    next.status = 'active'
    activeId = next.id
    activeTurnId = next.turnId
  }

  const discardQueuedForNow = (owner: Entry): void => {
    const dropped = [...entries.values()].filter(entry => entry.id !== owner.id && !entry.claimed && entry.status !== 'settled'
      && (entry.status === 'queued' || (entry.status === 'awaiting' && entry.busy && entry.requested === 'followup')))
    const retired = retire(dropped)
    if (retired.discarded.length > 0) emitChange({ discarded: retired.discarded })
  }

  const submit = async (input: AgentInput, placement: SubmitPlacement): Promise<DshGoSubmitResult> => {
    const busy = activeId !== undefined || turnOpen || [...entries.values()].some(entry => entry.status === 'awaiting' && !entry.busy)
    const nowOwner = placement === 'now' && busy && ![...entries.values()].some(entry => entry.status !== 'settled' && entry.nowOwner)
    const entry: Entry = {
      id: input.clientMessageId,
      text: input.text,
      requested: placement,
      busy,
      nowOwner,
      ...(activeId === undefined ? {} : { previousActiveId: activeId }),
      ack: false,
      status: 'awaiting',
      claimed: false,
      retracting: false,
    }
    entries.set(entry.id, entry)
    const params: Record<string, unknown> = input.blocks === undefined
      ? { sessionId: options.sessionId, text: input.text, placement }
      : { sessionId: options.sessionId, content: input.blocks.map(block => ({ ...block })), placement }
    try {
      const result = record(await options.call('session.prompt', params))
      if (result?.accepted === false) {
        forget(entry)
        promote()
        return { accepted: false, reason: 'dsh-go: session.prompt refused the input' }
      }
      if (result?.accepted !== true || typeof result.turnId !== 'string' || result.turnId === '') {
        throw new Error('dsh-go: session.prompt returned an invalid receipt')
      }
      const turnId = result.turnId
      const previousOwner = byTurn.get(turnId)
      const joinsActiveTurn = placement === 'steer' && activeTurnId === turnId && previousOwner === activeId
      if (previousOwner !== undefined && previousOwner !== entry.id && !joinsActiveTurn) throw new Error('dsh-go: session.prompt reused a live turnId')
      entry.ack = true
      entry.turnId = turnId
      // A steer receipt names the run it joins, not a new queue owner. Keep
      // the active client id as the cancel/retraction owner for that run.
      if (!joinsActiveTurn) byTurn.set(turnId, entry.id)
      if (entry.status === 'settled') {
        rememberFinished(turnId)
        forget(entry)
        return { accepted: true }
      }
      if (entry.nowOwner) discardQueuedForNow(entry)
      if (!entry.busy) {
        entry.status = 'active'
        activeId = entry.id
        activeTurnId = turnId
      } else if (placement === 'steer') {
        entry.status = 'steered'
      } else if (placement === 'now') {
        entry.status = 'active'
        activeId = entry.id
        activeTurnId = turnId
      } else if (activeId !== entry.id) {
        entry.status = 'queued'
      } else {
        entry.status = 'active'
        activeTurnId = turnId
      }
      if (entry.busy && placement !== 'now') emitChange({})
      return { accepted: true }
    } catch (error) {
      if (!(error instanceof DshGoTransportError) || error.status <= 0) throw error
      if (entry.nowOwner && error.status === 409) discardQueuedForNow(entry)
      const previous = entry.previousActiveId === undefined ? undefined : entries.get(entry.previousActiveId)
      const wasActive = activeId === entry.id
      forget(entry)
      if (entry.nowOwner && wasActive && previous !== undefined && previous.status !== 'settled') {
        activeId = previous.id
        activeTurnId = previous.turnId
      }
      promote()
      return { accepted: false, reason: error.message, dropped: true }
    }
  }

  const finish = (turnId: string | undefined, failed: boolean): readonly AgentEvent[] => {
    if (turnId !== undefined && finishedTurns.has(turnId)) return []
    if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) return []
    if (turnId !== undefined) {
      const owner = byTurn.get(turnId)
      if (owner !== undefined && owner !== activeId && entries.get(owner)?.status === 'settled') {
        rememberFinished(turnId)
        return []
      }
    }
    const current = activeId === undefined ? undefined : entries.get(activeId)
    if (current === undefined) {
      turnOpen = false
      if (turnId !== undefined) rememberFinished(turnId)
      return []
    }
    const retiring = [current]
    for (const entry of entries.values()) {
      if (entry.status !== 'steered') continue
      if (turnId !== undefined ? entry.turnId === turnId : entry.busy) retiring.push(entry)
    }
    const claimed: string[] = []
    const discarded: string[] = []
    for (const entry of retiring) {
      if (entry.status === 'settled') continue
      if (entry.status === 'steered' && !failed && !entry.claimed) {
        entry.claimed = true
        claimed.push(entry.id)
      } else if (!entry.claimed) {
        discarded.push(entry.id)
      }
      settle(entry)
    }
    turnOpen = false
    if (turnId !== undefined) rememberFinished(turnId)
    promote()
    return claimed.length === 0 && discarded.length === 0 ? [] : [changed({ ...(claimed.length > 0 ? { claimed } : {}), ...(discarded.length > 0 ? { discarded } : {}) })]
  }

  const observe = (frame: ServerFrame): readonly AgentEvent[] => {
    if (frame.type === 'turn/start') {
      turnOpen = true
      if (activeId === undefined) promote()
      if (activeId === undefined) {
        const candidate = [...entries.values()].find(entry => entry.status === 'awaiting' && !entry.busy)
        if (candidate !== undefined) {
          candidate.status = 'active'
          activeId = candidate.id
          activeTurnId = candidate.turnId
        }
      }
      const current = activeId === undefined ? undefined : entries.get(activeId)
      if (current === undefined || current.claimed || current.status === 'settled') return []
      current.claimed = true
      return [changed({ claimed: [current.id] })]
    }
    if (frame.type === 'user/message') {
      const current = activeId === undefined ? undefined : entries.get(activeId)
      if (current === undefined || current.claimed || current.status === 'settled') return []
      current.claimed = true
      return [changed({ claimed: [current.id] })]
    }
    const data = record(frame.data)
    if (frame.type === 'turn/end') return finish(undefined, false)
    if (frame.type === 'turn/done') return finish(typeof data?.turnId === 'string' ? data.turnId : undefined, false)
    if (frame.type === 'turn/error') return finish(typeof data?.turnId === 'string' ? data.turnId : undefined, true)
    return []
  }

  const requestCancel = async (cause: CancelCause, turnId?: string): Promise<{ receipt: CancelReceipt; error?: unknown }> => {
    const covered = pendingIds()
    try {
      const parsed = parseCancel(await options.call('session.cancel', {
        sessionId: options.sessionId,
        cause,
        ...(turnId === undefined ? {} : { turnId }),
      }))
      if (parsed === undefined) return { receipt: { stillQueued: covered, outcome: 'unknown' } }
      if (parsed.outcome !== 'confirmed') return { receipt: { stillQueued: covered, outcome: parsed.outcome } }
      if (!parsed.cancelled) return { receipt: { stillQueued: covered, outcome: 'unknown' } }
      const stillQueued: string[] = []
      for (const id of parsed.stillQueued) {
        const clientId = byTurn.get(id)
        if (clientId === undefined) return { receipt: { stillQueued: covered, outcome: 'unknown' } }
        stillQueued.push(clientId)
      }
      const withdrawing = parsed.cancelledQueued.flatMap(id => {
        const clientId = byTurn.get(id)
        const entry = clientId === undefined ? undefined : entries.get(clientId)
        return entry === undefined || entry.claimed || entry.status === 'settled' ? [] : [entry]
      })
      const retired = retire(withdrawing)
      if (retired.discarded.length > 0) emitChange({ discarded: retired.discarded })
      return { receipt: { stillQueued, outcome: 'confirmed' } }
    } catch (error) {
      return { receipt: { stillQueued: covered, outcome: 'failed' }, error }
    }
  }

  return {
    submit,
    observe,
    async cancel(cause: CancelCause): Promise<CancelReceipt> {
      return (await requestCancel(cause)).receipt
    },
    /** Start a targeted withdrawal; the boolean is the sync capability's admission result. */
    retract(clientMessageId: string): boolean {
      const entry = entries.get(clientMessageId)
      if (entry === undefined || entry.status !== 'queued' || !entry.ack || entry.turnId === undefined || entry.claimed || entry.retracting) return false
      entry.retracting = true
      const turnId = entry.turnId
      void requestCancel('interrupt', turnId).then(({ receipt, error }) => {
        entry.retracting = false
        if (error !== undefined) {
          options.emit([{ type: 'notice', level: 'error', text: messageOf(error) }])
          return
        }
        if (receipt.outcome !== 'confirmed' || entries.get(clientMessageId) !== undefined) {
          options.emit([{ type: 'notice', level: 'error', text: 'dsh-go: pending retraction was not confirmed' }])
        }
      })
      return true
    },
    close(): readonly AgentEvent[] {
      const dropped = pendingIds()
      for (const entry of entries.values()) entry.status = 'settled'
      entries.clear()
      byTurn.clear()
      finishedTurns.clear()
      activeId = undefined
      activeTurnId = undefined
      turnOpen = false
      return dropped.length === 0 ? [] : [{ type: 'pending.changed', items: [], dropped }]
    },
  }
}

export type DshGoPlacement = ReturnType<typeof createDshGoPlacement>
