import type { RewindOutcome, RewindPreview, SessionCapabilities } from './types/agent/capabilities.js'
import type { AgentEvent } from './types/agent/events.js'
import type { AgentSessionRef } from './types/agent/refs.js'
import { createDshGoEventTranslator, type DshGoLoadMessage, type DshGoLoadResult } from './events.js'

const BACKEND_ID = 'dsh-go'

type RewindMode = 'conversation' | 'files' | 'both'

/** Only the authenticated Transport surface used by these operations. */
export interface DshGoSessionOperationsTransport {
  call<T = unknown>(method: string, params?: Readonly<Record<string, unknown>>): Promise<T>
}

export interface DshGoTranscriptOptions {
  /** Native messages already replayed from the newest end of the record. */
  readonly initialMessages?: number
  /** Native messages returned by each synchronous older() call. */
  readonly pageMessages?: number
  /** Fail instead of retaining an unbounded durable record. */
  readonly maxMessages?: number
}

interface ResolvedTranscriptOptions {
  readonly initialMessages: number
  readonly pageMessages: number
  readonly maxMessages: number
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const ownRef = (sessionId: string): AgentSessionRef => ({ backendId: BACKEND_ID, sessionId })

const invalid = (method: string, detail = 'returned an invalid result'): Error =>
  new Error(`dsh-go: ${method} ${detail}`)

const sessionIdOf = (value: unknown, method: string): string => {
  const id = rec(value)?.sessionId
  if (typeof id !== 'string' || id === '') throw invalid(method, 'returned no sessionId')
  return id
}

const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function previewOf(value: unknown, method: string): RewindPreview {
  const row = rec(value)
  if (row === undefined || !Array.isArray(row.filesChanged) || row.filesChanged.some(path => typeof path !== 'string')) {
    throw invalid(method, 'returned no valid filesChanged array')
  }
  if ((row.insertions !== undefined && !integer(row.insertions)) || (row.deletions !== undefined && !integer(row.deletions))) {
    throw invalid(method, 'returned invalid file-change counts')
  }
  return {
    filesChanged: [...row.filesChanged] as string[],
    ...(row.insertions === undefined ? {} : { insertions: row.insertions as number }),
    ...(row.deletions === undefined ? {} : { deletions: row.deletions as number }),
  }
}

/**
 * Call the native whole-session fork. Anchor and title are not best-effort:
 * old hosts accept unknown request keys but ignore them, so the additive
 * response echoes are mandatory whenever either option was requested.
 */
export async function runDshGoFork(
  transport: DshGoSessionOperationsTransport,
  sessionId: string,
  anchor?: string,
  title?: string,
): Promise<AgentSessionRef> {
  if (sessionId === '') throw new Error('dsh-go: session.fork requires a session id')
  if (anchor === '') throw new Error('dsh-go: session.fork anchor must not be empty')
  const result = await transport.call<unknown>('session.fork', {
    id: sessionId,
    ...(anchor === undefined ? {} : { anchor }),
    ...(title === undefined ? {} : { title }),
  })
  const forkedId = sessionIdOf(result, 'session.fork')
  if (forkedId === sessionId) throw invalid('session.fork', 'returned the source session id')
  const row = rec(result)!
  if (anchor !== undefined && row.anchor !== anchor) {
    throw new Error(`dsh-go: session.fork created ${JSON.stringify(forkedId)} but did not confirm anchor ${JSON.stringify(anchor)}; the copy is not reported as the requested anchored fork`)
  }
  if (title !== undefined && row.title !== title) {
    throw new Error(`dsh-go: session.fork created ${JSON.stringify(forkedId)} but did not confirm title ${JSON.stringify(title)}; the copy is not reported as the requested titled fork`)
  }
  return ownRef(forkedId)
}

export function createDshGoForkCapability(
  transport: DshGoSessionOperationsTransport,
  sessionId: string,
): NonNullable<SessionCapabilities['fork']> {
  return { fork: (anchor, title) => runDshGoFork(transport, sessionId, anchor, title) }
}

/** Preview the real checkpoint restore; an absent host method rejects loudly. */
export async function previewDshGoRewind(
  transport: DshGoSessionOperationsTransport,
  sessionId: string,
  anchor: string,
): Promise<RewindPreview> {
  if (anchor === '') throw new Error('dsh-go: session.rewind.preview anchor must not be empty')
  const result = await transport.call<unknown>('session.rewind.preview', { id: sessionId, anchor })
  return previewOf(result, 'session.rewind.preview')
}

/**
 * Apply the native rewind result without inventing success. The host owns the
 * cut-before-anchor and files-first semantics. A both rewind may legitimately
 * restore files and then fail the conversation half; preserve that partial
 * outcome with the bound session instead of demanding or fabricating a fork.
 */
export async function runDshGoRewind(
  transport: DshGoSessionOperationsTransport,
  sessionId: string,
  anchor: string,
  mode: RewindMode,
): Promise<RewindOutcome> {
  if (anchor === '') throw new Error('dsh-go: session.rewind.apply anchor must not be empty')
  if (mode !== 'conversation' && mode !== 'files' && mode !== 'both') {
    throw new Error(`dsh-go: session.rewind.apply received invalid mode ${JSON.stringify(mode)}`)
  }
  const result = await transport.call<unknown>('session.rewind.apply', { id: sessionId, anchor, mode })
  const row = rec(result)
  if (row === undefined) throw invalid('session.rewind.apply')
  if (row.kind === 'refused') {
    if (typeof row.reason !== 'string' || row.reason === '') throw invalid('session.rewind.apply', 'refused without a reason')
    return { kind: 'refused', reason: row.reason }
  }
  if (row.kind !== 'rewound') throw invalid('session.rewind.apply')
  const files = row.files === undefined ? undefined : previewOf(row.files, 'session.rewind.apply')
  if (row.conversationError !== undefined && (typeof row.conversationError !== 'string' || row.conversationError === '')) {
    throw invalid('session.rewind.apply', 'returned an invalid conversationError')
  }
  const conversationError = row.conversationError as string | undefined
  if (mode === 'conversation' && files !== undefined) {
    throw invalid('session.rewind.apply', 'reported file restoration for conversation-only mode')
  }
  if (conversationError !== undefined) {
    if (mode !== 'both' || files === undefined) {
      throw invalid('session.rewind.apply', 'reported a partial outcome without both restored files and both mode')
    }
    return { kind: 'rewound', session: ownRef(sessionId), files, conversationError }
  }
  if (mode === 'files') {
    if (row.sessionId !== undefined && row.sessionId !== sessionId) {
      throw invalid('session.rewind.apply', 'created another session for files-only mode')
    }
    return { kind: 'rewound', session: ownRef(sessionId), ...(files === undefined ? {} : { files }) }
  }
  const forkedId = sessionIdOf(result, 'session.rewind.apply')
  if (forkedId === sessionId) throw invalid('session.rewind.apply', 'returned the bound session for a conversation rewind')
  return { kind: 'rewound', session: ownRef(forkedId), ...(files === undefined ? {} : { files }) }
}

export function createDshGoRewindCapability(
  transport: DshGoSessionOperationsTransport,
  sessionId: string,
): NonNullable<SessionCapabilities['rewind']> {
  return {
    preview: anchor => previewDshGoRewind(transport, sessionId, anchor),
    rewind: (anchor, mode) => runDshGoRewind(transport, sessionId, anchor, mode),
  }
}

function transcriptOptions(options: DshGoTranscriptOptions): ResolvedTranscriptOptions {
  const resolved = {
    initialMessages: options.initialMessages ?? 50,
    pageMessages: options.pageMessages ?? 50,
    maxMessages: options.maxMessages ?? 4096,
  }
  if (!integer(resolved.initialMessages) || !integer(resolved.pageMessages) || resolved.pageMessages === 0 || !integer(resolved.maxMessages) || resolved.maxMessages === 0) {
    throw new Error('dsh-go: transcript options require non-negative initialMessages and positive pageMessages/maxMessages')
  }
  return resolved
}

function loadOf(value: unknown): DshGoLoadResult {
  const row = rec(value)
  if (row === undefined || !Array.isArray(row.messages) || !integer(row.total) || typeof row.truncated !== 'boolean') {
    throw invalid('session.load', 'returned an invalid transcript projection')
  }
  const messages = row.messages.map((message, index) => {
    const item = rec(message)
    if (item === undefined || typeof item.role !== 'string' || item.role === '' || typeof item.text !== 'string' || !integer(item.seq)) {
      throw invalid('session.load', `returned an invalid message at index ${index}`)
    }
    if ((item.v4Seq !== undefined && !integer(item.v4Seq)) || (item.messageId !== undefined && typeof item.messageId !== 'string')) {
      throw invalid('session.load', `returned an invalid message identity at index ${index}`)
    }
    return message as DshGoLoadMessage
  })
  return { ...row, messages, total: row.total, truncated: row.truncated } as DshGoLoadResult
}

function completeLoad(value: unknown, options: ResolvedTranscriptOptions): DshGoLoadResult {
  const load = loadOf(value)
  if (load.messages.length > options.maxMessages) {
    throw new Error(`dsh-go: durable transcript exceeds maxMessages=${options.maxMessages}; session.transcript.page is required`)
  }
  if (load.truncated || load.total !== load.messages.length) {
    throw new Error(`dsh-go: session.load did not provide the complete durable transcript (total=${load.total}, messages=${load.messages.length}, truncated=${load.truncated}); session.transcript.page is required`)
  }
  return load
}

/**
 * Make the official synchronous transcript surface over one verified complete
 * durable load. session.history is deliberately not used: it pages the recent
 * in-memory transport journal after sinceSeq, not durable messages before the
 * resumed baseline. Large/truncated logs fail above until the host adds the
 * documented session.transcript.page method.
 */
export function createDshGoTranscriptCapability(
  sessionId: string,
  value: unknown,
  options: DshGoTranscriptOptions = {},
): NonNullable<SessionCapabilities['transcript']> {
  const resolved = transcriptOptions(options)
  const load = completeLoad(value, resolved)
  let cursor = Math.max(0, load.messages.length - resolved.initialMessages)
  let fullRecord: readonly AgentEvent[] | undefined
  const replay = (messages: readonly DshGoLoadMessage[]): readonly AgentEvent[] => {
    const events = createDshGoEventTranslator({ sessionId }).translateLoad({
      ...load,
      messages,
      total: messages.length,
      truncated: false,
    })
    // session.ready/reset describe the adapter baseline, not persisted rows.
    return events.filter(event => event.type !== 'session.ready' && event.type !== 'session.reset')
  }
  return {
    record() {
      fullRecord ??= replay(load.messages)
      return fullRecord
    },
    hasOlder: () => cursor > 0,
    older() {
      if (cursor === 0) return []
      const start = Math.max(0, cursor - resolved.pageMessages)
      const page = replay(load.messages.slice(start, cursor))
      cursor = start
      return page
    },
  }
}

/** Prefetch and verify a bounded complete record through the existing RPC. */
export async function loadDshGoTranscriptCapability(
  transport: DshGoSessionOperationsTransport,
  sessionId: string,
  options: DshGoTranscriptOptions = {},
): Promise<NonNullable<SessionCapabilities['transcript']>> {
  const resolved = transcriptOptions(options)
  const result = await transport.call<unknown>('session.load', { id: sessionId, tailMessages: resolved.maxMessages })
  return createDshGoTranscriptCapability(sessionId, result, resolved)
}
