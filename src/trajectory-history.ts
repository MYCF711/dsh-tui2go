import type { AgentEvent } from './types/agent/events.js'
import { createDshGoEventTranslator, type DshGoJournalEpoch, type DshGoLoadMessage, type DshGoServerFrame } from './events.js'
import { createDshGoStepStreamTranslator, type DshGoStepTiming } from './step-stream.js'
import type { SessionHistory } from './transport.js'
import { withDshGoToolResultPresentation } from './view-spec.js'

export interface DshGoTranscriptPageTransport {
  call(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>
}

export interface DshGoRawHistoryTransport {
  history(sessionId: string, sinceSeq: number, journalEpoch: string, limit?: number): Promise<SessionHistory>
}

export interface DshGoTranscriptPageOptions {
  readonly cursor?: string
  readonly limit?: number
  readonly maxMessages?: number
}

export interface DshGoTranscriptHistory {
  readonly status: 'complete' | 'degraded'
  readonly messages: readonly DshGoLoadMessage[]
  readonly pages: readonly (readonly DshGoLoadMessage[])[]
  readonly cursor?: string
  readonly reason?: string
}

export interface DshGoRawHistoryOptions {
  readonly journalEpoch: DshGoJournalEpoch
  readonly sinceSeq?: number
  readonly limit?: number
  readonly maxFrames?: number
  readonly maxPages?: number
}

export interface DshGoRawHistoryCursor {
  readonly journalEpoch: DshGoJournalEpoch
  readonly sinceSeq: number
}

export interface DshGoRawTrajectoryHistory {
  readonly status: 'complete' | 'degraded' | 'error'
  readonly frames: readonly DshGoServerFrame[]
  readonly events: readonly AgentEvent[]
  readonly timings: readonly DshGoStepTiming[]
  readonly cursor: DshGoRawHistoryCursor
  readonly reason?: string
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const sequence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

function pageMessage(value: unknown, index: number): DshGoLoadMessage {
  const row = rec(value)
  if (row === undefined || !sequence(row.seq) || typeof row.role !== 'string' || typeof row.text !== 'string') {
    throw new Error(`dsh-go: session.transcript.page returned an invalid message at index ${index}`)
  }
  return value as DshGoLoadMessage
}

/** Read W145 durable pages newest-to-oldest, returning one oldest-first record. */
export async function readDshGoTranscriptPages(
  transport: DshGoTranscriptPageTransport,
  sessionId: string,
  options: DshGoTranscriptPageOptions = {},
): Promise<DshGoTranscriptHistory> {
  const limit = options.limit ?? 50
  const maxMessages = options.maxMessages ?? 4096
  if (!positiveInteger(limit) || limit > 200 || !positiveInteger(maxMessages)) {
    throw new Error('dsh-go: transcript.page requires limit in 1..200 and a positive maxMessages')
  }
  let cursor = options.cursor
  let messages: readonly DshGoLoadMessage[] = []
  const pages: (readonly DshGoLoadMessage[])[] = []
  for (;;) {
    const requestedCursor = cursor
    const value = await transport.call('session.transcript.page', {
      id: sessionId,
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    })
    const row = rec(value)
    if (row === undefined || !Array.isArray(row.messages) || typeof row.hasOlder !== 'boolean') {
      throw new Error('dsh-go: session.transcript.page returned an invalid page')
    }
    const nextCursor = row.nextCursor
    if (nextCursor !== undefined && (typeof nextCursor !== 'string' || nextCursor === '')) {
      throw new Error('dsh-go: session.transcript.page returned an invalid nextCursor')
    }
    const page = row.messages.map(pageMessage)
    pages.push(page)
    messages = [...page, ...messages]
    cursor = nextCursor as string | undefined
    if (messages.length > maxMessages) {
      return { status: 'degraded', messages, pages, ...(cursor === undefined ? {} : { cursor }), reason: `durable transcript exceeds maxMessages=${maxMessages}` }
    }
    if (!row.hasOlder) return { status: 'complete', messages, pages, ...(cursor === undefined ? {} : { cursor }) }
    if (cursor === undefined || cursor === requestedCursor) {
      throw new Error('dsh-go: session.transcript.page hasOlder without an advancing nextCursor')
    }
  }
}

function rawResult(
  status: DshGoRawTrajectoryHistory['status'],
  frames: readonly DshGoServerFrame[],
  events: readonly AgentEvent[],
  timings: readonly DshGoStepTiming[],
  cursor: DshGoRawHistoryCursor,
  reason?: string,
): DshGoRawTrajectoryHistory {
  return { status, frames, events, timings, cursor, ...(reason === undefined ? {} : { reason }) }
}

/**
 * Replay the real bounded Transport journal through an independent translator.
 * A stale epoch, empty non-caught-up page, gap or transport failure is explicit;
 * partial output is never labelled a complete raw v4 history.
 */
export async function readDshGoRawTrajectoryHistory(
  transport: DshGoRawHistoryTransport,
  sessionId: string,
  options: DshGoRawHistoryOptions,
): Promise<DshGoRawTrajectoryHistory> {
  const initial = options.sinceSeq ?? 0
  const limit = options.limit ?? 256
  const maxFrames = options.maxFrames ?? 4096
  const maxPages = options.maxPages ?? 64
  if (!sequence(initial) || !positiveInteger(limit) || !positiveInteger(maxFrames) || !positiveInteger(maxPages)) {
    throw new Error('dsh-go: raw history requires non-negative sinceSeq and positive limit/maxFrames/maxPages')
  }
  const epoch = String(options.journalEpoch)
  const translator = createDshGoEventTranslator({ sessionId })
  const stream = createDshGoStepStreamTranslator()
  translator.translateLoad({ messages: [], total: 0, truncated: false, journalEpoch: options.journalEpoch, lastSeq: initial })
  const frames: DshGoServerFrame[] = []
  const events: AgentEvent[] = []
  let cursor = initial
  const snapshot = (status: DshGoRawTrajectoryHistory['status'], reason?: string): DshGoRawTrajectoryHistory =>
    rawResult(status, frames, events, stream.timings(), { journalEpoch: options.journalEpoch, sinceSeq: cursor }, reason)

  try {
    for (let page = 0; page < maxPages; page++) {
      const history = await transport.history(sessionId, cursor, epoch, limit)
      if (history.journalEpoch !== epoch) return snapshot('degraded', `stale_epoch: expected ${epoch}, received ${history.journalEpoch}`)
      if (!sequence(history.lastSeq) || history.lastSeq < cursor || !Array.isArray(history.frames)) {
        return snapshot('degraded', 'invalid_history: malformed page watermark or frames')
      }
      if (history.frames.length === 0) {
        return cursor === history.lastSeq
          ? snapshot('complete')
          : snapshot('degraded', 'invalid_history: empty page did not advance to lastSeq')
      }
      for (const frame of history.frames) {
        if (!positiveInteger(frame.seq) || frame.seq !== cursor + 1) {
          return snapshot('degraded', `invalid_history: expected seq=${cursor + 1}, received ${String(frame.seq)}`)
        }
        if (frames.length >= maxFrames) return snapshot('degraded', `raw history exceeds maxFrames=${maxFrames}`)
        const translated = translator.translateFrame(frame)
        const streamed = stream.translateFrame(frame)
        const mapped = streamed !== undefined && streamed.length > 0
          ? streamed
          : withDshGoToolResultPresentation(translated, rec(frame.data)?.view)
        frames.push(frame)
        events.push(...mapped)
        cursor = frame.seq
      }
      if (cursor >= history.lastSeq) return snapshot('complete')
    }
    return snapshot('degraded', `raw history exceeds maxPages=${maxPages}`)
  } catch (error) {
    return snapshot('error', messageOf(error))
  }
}
