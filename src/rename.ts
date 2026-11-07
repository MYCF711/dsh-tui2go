import type { SessionCapabilities } from './types/agent/capabilities.js'
import type { AgentEvent, AgentEventOf } from './types/agent/events.js'
import type { ServerFrame } from './transport.js'

/** The authenticated Transport surface used by session title metadata. */
export interface DshGoRenameTransport {
  call<T = unknown>(method: string, params?: Readonly<Record<string, unknown>>): Promise<T>
}

export interface DshGoRenameOptions {
  /** Live backend events; unbuffered host frames are returned by acceptFrame. */
  emit?(events: readonly AgentEvent[]): void
}

export type DshGoTitleEvent = AgentEventOf<'session.title'>

export interface DshGoTitleSnapshot {
  readonly title: string
  /** False for session.list's summary/(无标题) fallback, not an explicit title. */
  readonly explicit: boolean
  readonly source?: 'user' | 'auto'
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const invalid = (detail: string): Error => new Error(`dsh-go: ${detail}`)

function titleRow(value: unknown, sessionId: string): Record<string, unknown> {
  const result = record(value)
  if (result === undefined || !Array.isArray(result.sessions)) throw invalid('session.list returned no sessions array')
  const matches = result.sessions.filter(raw => record(raw)?.id === sessionId)
  if (matches.length !== 1) throw invalid(`session.list returned ${matches.length} rows for session ${JSON.stringify(sessionId)}`)
  const row = record(matches[0])!
  if (typeof row.title !== 'string') throw invalid(`session.list returned no string title for session ${JSON.stringify(sessionId)}`)
  return row
}

/** Preserve the distinction between an explicit title and a list fallback. */
export function dshGoTitleSnapshotFromList(value: unknown, sessionId: string): DshGoTitleSnapshot {
  const row = titleRow(value, sessionId)
  if (row.titleExplicit !== undefined && typeof row.titleExplicit !== 'boolean') {
    throw invalid('session.list returned a non-boolean titleExplicit')
  }
  const explicit = row.titleExplicit === true
  if (!explicit) {
    if (row.titleSource !== undefined) throw invalid('session.list returned titleSource for a fallback title')
    return { title: row.title as string, explicit: false }
  }
  if (row.titleSource !== 'user' && row.titleSource !== 'auto') {
    throw invalid('session.list returned an explicit title without titleSource user/auto')
  }
  return { title: row.title as string, explicit: true, source: row.titleSource }
}

export function dshGoTitleFromList(value: unknown, sessionId: string): string {
  return dshGoTitleSnapshotFromList(value, sessionId).title
}

export async function readDshGoTitleSnapshot(
  transport: DshGoRenameTransport,
  sessionId: string,
): Promise<DshGoTitleSnapshot> {
  if (sessionId === '') throw invalid('session.list title lookup requires a session id')
  return dshGoTitleSnapshotFromList(await transport.call<unknown>('session.list', {}), sessionId)
}

export async function readDshGoTitle(
  transport: DshGoRenameTransport,
  sessionId: string,
): Promise<string> {
  return (await readDshGoTitleSnapshot(transport, sessionId)).title
}

/**
 * Persist through the additive host RPC, then require the canonical list to
 * prove the exact explicit user title. Long titles and whitespace are preserved.
 */
export async function runDshGoRename(
  transport: DshGoRenameTransport,
  sessionId: string,
  title: string,
): Promise<string> {
  if (sessionId === '') throw invalid('session.rename requires a session id')
  if (title.trim() === '') throw invalid('session.rename title must not be empty')
  await transport.call('session.rename', { id: sessionId, title })
  const persisted = await readDshGoTitleSnapshot(transport, sessionId)
  if (persisted.title !== title) {
    throw invalid(`session.rename readback mismatch: requested ${JSON.stringify(title)}, session.list returned ${JSON.stringify(persisted.title)}`)
  }
  if (!persisted.explicit || persisted.source !== 'user') {
    throw invalid('session.rename readback did not prove an explicit user session/title record')
  }
  return persisted.title
}

/** Translate only a real host session/title frame, including W145 source data. */
export function dshGoTitleChange(frame: ServerFrame): DshGoTitleEvent | undefined {
  if (frame.type !== 'session/title') return undefined
  const data = record(frame.data)
  if (data === undefined || typeof data.title !== 'string') return undefined
  const source = data.source === 'user' || data.source === 'auto'
    ? data.source
    : record(data.source)?.kind
  if (source !== 'user' && source !== 'auto') return undefined
  return { type: 'session.title', title: data.title, source }
}

export function createDshGoRename(
  transport: DshGoRenameTransport,
  sessionId: string,
  options: DshGoRenameOptions = {},
) {
  const listeners = new Set<(event: DshGoTitleEvent) => void>()
  let current: DshGoTitleSnapshot | undefined
  let disposed = false
  let queue: Promise<void> = Promise.resolve()
  let revision = 0
  let mutating = false
  let buffered: ServerFrame[] = []

  const notify = (event: DshGoTitleEvent, local: boolean): void => {
    // Observers cannot turn an already-verified host mutation into a rejected
    // operation or stop later queued work.
    if (local) {
      try { options.emit?.([event]) } catch { /* backend observer isolation */ }
    }
    for (const listener of [...listeners]) {
      try { listener(event) } catch { /* subscriber isolation */ }
    }
  }

  const adopt = (event: DshGoTitleEvent, local: boolean): DshGoTitleEvent | undefined => {
    if (disposed || (current?.explicit === true && current.title === event.title && current.source === event.source)) return undefined
    current = { title: event.title, explicit: true, source: event.source }
    revision++
    notify(event, local)
    return event
  }

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  const capability: NonNullable<SessionCapabilities['rename']> = {
    rename(title: string): Promise<void> {
      if (disposed) return Promise.reject(invalid('session.rename is disposed'))
      if (title.trim() === '') return Promise.reject(invalid('session.rename title must not be empty'))
      return enqueue(async () => {
        if (disposed) throw invalid('session.rename is disposed')
        mutating = true
        buffered = []
        let verified = false
        try {
          const persisted = await runDshGoRename(transport, sessionId, title)
          adopt({ type: 'session.title', title: persisted, source: 'user' }, true)
          verified = true
        } finally {
          mutating = false
          const pending = buffered
          buffered = []
          // An early local echo is releasable only after durable readback. On
          // failure/mismatch it is dropped, never shown as verified success.
          if (verified && !disposed) {
            for (const frame of pending) {
              const event = dshGoTitleChange(frame)
              if (event !== undefined) adopt(event, true)
            }
          }
        }
      })
    },
  }

  return {
    capability,
    current: (): string | undefined => current?.title,
    /** A replay/seed event only for an explicit title, never a list fallback. */
    seed(): DshGoTitleEvent | undefined {
      return current?.explicit === true && current.source !== undefined && !disposed
        ? { type: 'session.title', title: current.title, source: current.source }
        : undefined
    },
    /** Wait for serialized rename calls before the backend closes Transport. */
    idle(): Promise<void> { return queue },
    /** Refresh in mutation order; an intervening host change wins over stale I/O. */
    refresh(): Promise<string> {
      if (disposed) return Promise.reject(invalid('session.rename is disposed'))
      return enqueue(async () => {
        if (disposed) throw invalid('session.rename is disposed')
        const started = revision
        const persisted = await readDshGoTitleSnapshot(transport, sessionId)
        if (!disposed && revision === started) current = persisted
        return persisted.title
      })
    },
    /** The backend emits an unbuffered return value; subscribers are called here. */
    acceptFrame(frame: ServerFrame): DshGoTitleEvent | undefined {
      const event = dshGoTitleChange(frame)
      if (event === undefined || disposed) return undefined
      if (mutating) {
        buffered.push(frame)
        return undefined
      }
      return adopt(event, false)
    },
    subscribe(listener: (event: DshGoTitleEvent) => void): () => void {
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
