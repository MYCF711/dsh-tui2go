import type { SessionCapabilities } from './types/agent/capabilities.js'
import type { AgentEvent, AgentEventOf } from './types/agent/events.js'
import type { ServerFrame } from './transport.js'

/** The additive host-owned, durable per-session accent store. */
export interface DshGoColorTransport {
  call<T = unknown>(method: string, params?: Readonly<Record<string, unknown>>): Promise<T>
}

export interface DshGoColorOptions {
  /** Required for set(): live events and asynchronous failure notices. */
  emit?(events: readonly AgentEvent[]): void
}

export type DshGoColorEvent = AgentEventOf<'session.color'>

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const invalid = (detail: string): Error => new Error(`dsh-go: ${detail}`)
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

function colorFromGet(value: unknown): string {
  const result = record(value)
  if (result === undefined || typeof result.color !== 'string') throw invalid('session.color.get returned no string color')
  return result.color
}

/** Read the durable host value; an empty string is the host's default accent. */
export async function readDshGoColor(
  transport: DshGoColorTransport,
  sessionId: string,
): Promise<string> {
  if (sessionId === '') throw invalid('session.color.get requires a session id')
  return colorFromGet(await transport.call<unknown>('session.color.get', { id: sessionId }))
}

/** Persist remotely and prove the exact value with a subsequent host read. */
export async function runDshGoColor(
  transport: DshGoColorTransport,
  sessionId: string,
  color: string,
): Promise<string> {
  if (sessionId === '') throw invalid('session.color.set requires a session id')
  await transport.call('session.color.set', { id: sessionId, color })
  const persisted = await readDshGoColor(transport, sessionId)
  if (persisted !== color) {
    throw invalid(`session.color.set readback mismatch: requested ${JSON.stringify(color)}, session.color.get returned ${JSON.stringify(persisted)}`)
  }
  return persisted
}

export function dshGoColorChange(frame: ServerFrame): DshGoColorEvent | undefined {
  if (frame.type !== 'session/color') return undefined
  const data = record(frame.data)
  return data !== undefined && typeof data.color === 'string'
    ? { type: 'session.color', color: data.color }
    : undefined
}

export function createDshGoColor(
  transport: DshGoColorTransport,
  sessionId: string,
  options: DshGoColorOptions = {},
) {
  const listeners = new Set<(event: DshGoColorEvent) => void>()
  let current = ''
  let disposed = false
  let queue: Promise<void> = Promise.resolve()
  let revision = 0
  let mutating = false
  let buffered: ServerFrame[] = []

  const emit = (events: readonly AgentEvent[]): void => {
    try { options.emit?.(events) } catch { /* backend observer isolation */ }
  }

  const adopt = (event: DshGoColorEvent, local: boolean): DshGoColorEvent | undefined => {
    if (disposed || current === event.color) return undefined
    current = event.color
    revision++
    if (local) emit([event])
    for (const listener of [...listeners]) {
      try { listener(event) } catch { /* subscriber isolation */ }
    }
    return event
  }

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  const persist = async (color: string): Promise<void> => {
    if (disposed) return
    mutating = true
    buffered = []
    let verified = false
    try {
      const persisted = await runDshGoColor(transport, sessionId, color)
      adopt({ type: 'session.color', color: persisted }, true)
      verified = true
    } catch (error) {
      // color.set is void: failure is an error notice, never a local success.
      if (!disposed) emit([{ type: 'notice', level: 'error', text: `dsh-go: session.color.set failed: ${errorText(error)}` }])
    } finally {
      mutating = false
      const pending = buffered
      buffered = []
      if (verified && !disposed) {
        for (const frame of pending) {
          const event = dshGoColorChange(frame)
          if (event !== undefined) adopt(event, true)
        }
      }
    }
  }

  const capability: NonNullable<SessionCapabilities['color']> = {
    current: () => current,
    set(color: string): void {
      if (disposed) throw invalid('session.color.set is disposed')
      if (typeof color !== 'string') throw invalid('session.color.set color must be a string')
      if (options.emit === undefined) throw invalid('session.color.set requires an event/error emitter')
      // The queue is fulfilled after either a verified value or an error notice;
      // observer exceptions are isolated and cannot poison subsequent writes.
      queue = queue.then(() => persist(color))
    },
  }

  return {
    capability,
    /** Seed a restored non-empty accent without calling it a new change. */
    seed(): DshGoColorEvent | undefined {
      return current !== '' && !disposed ? { type: 'session.color', color: current } : undefined
    },
    /** Refresh in set order; an intervening host frame wins over stale I/O. */
    refresh(): Promise<string> {
      if (disposed) return Promise.reject(invalid('session.color.get is disposed'))
      return enqueue(async () => {
        if (disposed) throw invalid('session.color.get is disposed')
        const started = revision
        const persisted = await readDshGoColor(transport, sessionId)
        if (!disposed && revision === started) current = persisted
        return persisted
      })
    },
    /** Resolve after all queued writes; inspect emitted events for each outcome. */
    idle(): Promise<void> { return queue },
    /** The backend emits an unbuffered return value; subscribers are called here. */
    acceptFrame(frame: ServerFrame): DshGoColorEvent | undefined {
      const event = dshGoColorChange(frame)
      if (event === undefined || disposed) return undefined
      if (mutating) {
        buffered.push(frame)
        return undefined
      }
      return adopt(event, false)
    },
    subscribe(listener: (event: DshGoColorEvent) => void): () => void {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose(): void {
      disposed = true
      buffered = []
      listeners.clear()
    },
  }
}
