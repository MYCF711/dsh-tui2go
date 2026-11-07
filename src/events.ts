/**
 * DSH-GO session.load / Transport frames to the backend-neutral AgentEvent
 * vocabulary. This is a pure, per-session mapper: network reconnect, history
 * fetching and permission responses belong to the session adapter.
 *
 * Three sequence domains stay separate: Transport seq fences delivery,
 * v4Seq/messageId dedupe durable messages, and AgentEvent.seq is allocated
 * here for the shared projector. No streaming attempt or tool presenter is
 * invented from settled DSH-GO records.
 */
import type {
  AgentEvent,
  AgentEventOf,
  ContentBlockView,
  PermissionOptionView,
  PermissionRequestView,
  TurnEndReason,
  UsageDelta,
} from './types/agent/events.js'
import { dshGoColorChange } from './color.js'
import { dshGoTitleChange } from './rename.js'
import { createDshGoStepStreamTranslator } from './step-stream.js'
import { dshGoLoadToolResult, withDshGoToolResultPresentation } from './view-spec.js'

/**
 * `NO_EVENTS` is a **runtime** export of the host's `agent/events.js`
 * (`Object.freeze([])`); the vendored `./types/agent/*` copy is `.d.ts`
 * only — importing the name from `./types/agent/events.js` typechecks and
 * then dies with `ERR_MODULE_NOT_FOUND` — so the frozen empty array is
 * declared and exported here (T2 handover). It is never identity compared —
 * it is only an immutable empty translation result.
 */
export const NO_EVENTS: readonly AgentEvent[] = Object.freeze([])

export interface DshGoContentBlock extends ContentBlockView {
  readonly [key: string]: unknown
}

export interface DshGoUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** The current session.load Message projection (not a raw tool event). */
export interface DshGoLoadMessage {
  readonly seq: number
  readonly role: string
  readonly text: string
  readonly tool?: string
  readonly args?: string
  readonly summary?: string
  readonly time?: number
  readonly usage?: DshGoUsage
  readonly view?: unknown
  readonly reasoning?: string
  readonly v4Seq?: number
  readonly messageId?: string
  readonly content?: readonly DshGoContentBlock[]
}

export type DshGoJournalEpoch = number | string

export interface DshGoLoadResult {
  readonly messages: readonly DshGoLoadMessage[]
  readonly total: number
  readonly truncated: boolean
  readonly model?: string
  readonly goal?: string
  readonly permission?: string
  readonly contentWidth?: number
  readonly usageTotal?: DshGoUsage
  readonly contextTokens?: number
  readonly contextWindow?: number
  readonly journalEpoch?: DshGoJournalEpoch
  readonly lastSeq?: number
  readonly cwd?: string
  readonly effort?: string
  readonly effortSelection?: string
}

/** Transport ServerFrame; data stays unknown until its event-specific guard. */
export interface DshGoServerFrame {
  readonly seq?: number
  readonly type: string
  readonly data?: unknown
  readonly time?: number
}

export interface DshGoTransportCursor {
  readonly journalEpoch: DshGoJournalEpoch
  readonly lastSeq: number
  /** A session/reset invalidates live delivery until translateLoad runs. */
  readonly requiresLoad: boolean
}

export interface DshGoEventTranslatorOptions {
  readonly sessionId: string
  /** Durable attachment facade factory owned by the bound session. */
  readonly images?: {
    transcript(content: unknown, idPrefix?: string): readonly import('./types/agent/events.js').ImageRef[]
  }
}

type DshGoUserSource = AgentEventOf<'user.message'>['source']
type MessageIdentity = {
  readonly role: 'user' | 'assistant'
  readonly v4Seq?: number
  readonly messageId?: string
  readonly fallbackId: string
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const sequence = (value: unknown): number | undefined => {
  const n = num(value)
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined
}

const epochOf = (value: unknown): DshGoJournalEpoch | undefined => {
  if (typeof value === 'string') return value === '' ? undefined : value
  return sequence(value)
}

const timeOf = (value: unknown): number => num(value) ?? 0

const blocksOf = (value: unknown): readonly ContentBlockView[] | undefined => {
  if (!Array.isArray(value)) return undefined
  return value.flatMap(item => {
    const block = rec(item)
    const type = str(block?.type)
    if (block === undefined || type === undefined) return []
    const text = str(block.text)
    return [{ ...block, type, ...(text === undefined ? {} : { text }) }]
  })
}

const textOf = (blocks: readonly ContentBlockView[]): string =>
  blocks.map(block => block.type === 'text' ? block.text ?? '' : '').join('')

const firstTextOf = (blocks: readonly ContentBlockView[]): string =>
  blocks.find(block => block.type === 'text')?.text ?? ''

const fallbackBlocks = (text: unknown, reasoning: unknown): readonly ContentBlockView[] => {
  const blocks: ContentBlockView[] = []
  const body = str(text)
  const thought = str(reasoning)
  if (body !== undefined && body !== '') blocks.push({ type: 'text', text: body })
  if (thought !== undefined && thought !== '') blocks.push({ type: 'reasoning', text: thought })
  return blocks
}

const usageOf = (value: unknown): UsageDelta | undefined => {
  const usage = rec(value)
  if (usage === undefined) return undefined
  return {
    input: num(usage.inputTokens),
    output: num(usage.outputTokens),
    cacheRead: num(usage.cacheReadTokens),
    cacheWrite: num(usage.cacheWriteTokens),
  }
}

const custom = (nativeType: string, data: unknown): readonly AgentEvent[] => [{ type: 'custom', nativeType, data }]

export interface DshGoSideQueryError {
  readonly [key: string]: unknown
  readonly code: string
  readonly message: string
  readonly hint: string
  readonly retryable: boolean
}

/** Independent HTTP side.query wire frames never enter the session journal. */
export type DshGoSideQueryFrame =
  | { readonly type: 'text'; readonly requestId: string; readonly text: string }
  | { readonly type: 'done'; readonly requestId: string; readonly answer: string | null; readonly cancelled?: true }
  | { readonly type: 'error'; readonly requestId: string; readonly error: DshGoSideQueryError }

const invalidSideQuery = (): Error => new Error('dsh-go: side.query returned an invalid result')

export function dshGoSideQueryResult(value: unknown, requestId: string): string | null {
  const result = rec(value)
  if (result === undefined || result.requestId !== requestId) throw invalidSideQuery()
  if (typeof result.answer === 'string') return result.answer
  if (result.answer === null && result.cancelled === true) return null
  throw invalidSideQuery()
}

export function dshGoSideQueryFrame(value: unknown, requestId: string): DshGoSideQueryFrame {
  const frame = rec(value)
  if (frame === undefined || frame.requestId !== requestId) throw invalidSideQuery()
  if (frame.type === 'text' && typeof frame.text === 'string') {
    return { type: 'text', requestId, text: frame.text }
  }
  if (frame.type === 'done') {
    const answer = dshGoSideQueryResult(frame, requestId)
    return { type: 'done', requestId, answer, ...(answer === null ? { cancelled: true as const } : {}) }
  }
  const detail = rec(frame.error)
  if (frame.type === 'error' && detail !== undefined
    && typeof detail.code === 'string' && typeof detail.message === 'string'
    && typeof detail.hint === 'string' && typeof detail.retryable === 'boolean') {
    return {
      type: 'error', requestId,
      error: { code: detail.code, message: detail.message, hint: detail.hint, retryable: detail.retryable },
    }
  }
  throw invalidSideQuery()
}

const durableKey = (identity: MessageIdentity): string => {
  if (identity.v4Seq !== undefined) return `${identity.role}:v4:${identity.v4Seq}`
  if (identity.messageId !== undefined && identity.messageId !== '') return `${identity.role}:id:${identity.messageId}`
  return ''
}

const durableAnchor = (identity: MessageIdentity): string => {
  if (identity.v4Seq !== undefined) return String(identity.v4Seq)
  return identity.messageId ?? ''
}

const messageIdOf = (data: Record<string, unknown>): string | undefined => {
  const message = rec(data.message)
  return str(data.messageId) ?? str(data.id) ?? str(message?.messageId) ?? str(message?.id)
}

const permissionOption = (value: unknown): PermissionOptionView | undefined => {
  const option = rec(value)
  const id = str(option?.optionId)
  const kind = str(option?.kind)
  if (option === undefined || id === undefined || kind === undefined) return undefined
  const neutralKind = kind === 'allow_once'
    ? 'allow-once'
    : kind === 'allow_always'
      ? 'allow-always'
      : kind === 'reject_once'
        ? 'reject'
        : undefined
  if (neutralKind === undefined) return undefined
  const label = str(option.name)
  return { id, kind: neutralKind, ...(label === undefined ? {} : { label }) }
}

const turnReason = (value: unknown): TurnEndReason | undefined => {
  const reason = rec(value)
  const kind = str(reason?.kind)
  if (reason === undefined || kind === undefined) return undefined
  switch (kind) {
    case 'completed':
    case 'interrupted':
      return { kind }
    case 'aborted': {
      const nested = rec(reason.reason)
      return nested?.kind === 'disposed' ? { kind, cause: 'disposed' } : { kind }
    }
    case 'blocked': {
      const detail = str(reason.detail)
      return detail === undefined ? { kind } : { kind, detail }
    }
    case 'error': {
      const message = str(rec(reason.error)?.message) ?? str(reason.error) ?? ''
      return { kind, message }
    }
    default:
      return { kind: 'other', label: kind }
  }
}

/** Create the mapper for exactly one DSH-GO session and one reset generation. */
export function createDshGoEventTranslator(options: DshGoEventTranslatorOptions) {
  let journalEpoch: DshGoJournalEpoch = 0
  let lastSeq = 0
  let requiresLoad = false
  let loaded = false
  let bridgeSeq = 0
  let lastTurn: number | undefined
  let lastTurnClosed = false
  let deferredTurnEnd: AgentEventOf<'turn.end'> | undefined
  const seenDurable = new Set<string>()
  const pending = new Map<string, PermissionRequestView>()
  const settledPermissions = new Set<string>()
  const stepStream = createDshGoStepStreamTranslator()

  const transport = (): DshGoTransportCursor => ({ journalEpoch, lastSeq, requiresLoad })
  const pendingPermissions = (): readonly PermissionRequestView[] => [...pending.values()]
  const nextSeq = (): number => ++bridgeSeq

  const clearProjection = (): void => {
    bridgeSeq = 0
    lastTurn = undefined
    lastTurnClosed = false
    deferredTurnEnd = undefined
    seenDurable.clear()
    pending.clear()
    settledPermissions.clear()
    stepStream.reset()
  }

  const admitDurable = (identity: MessageIdentity): boolean => {
    const key = durableKey(identity)
    if (key === '') return true
    if (seenDurable.has(key)) return false
    seenDurable.add(key)
    return true
  }

  const userMessage = (
    identity: MessageIdentity,
    source: DshGoUserSource,
    content: readonly ContentBlockView[],
    time: number,
    turn?: number,
  ): readonly AgentEvent[] => {
    if (!admitDurable(identity)) return NO_EVENTS
    const images = options.images?.transcript(content, identity.fallbackId) ?? []
    return [{
      type: 'user.message',
      id: identity.messageId ?? identity.fallbackId,
      anchor: durableAnchor(identity),
      seq: nextSeq(),
      ...(turn === undefined ? {} : { turn }),
      time,
      source,
      text: firstTextOf(content),
      blocks: content,
      ...(images.length === 0 ? {} : { images }),
    }]
  }

  const assistantMessage = (
    identity: MessageIdentity,
    content: readonly ContentBlockView[],
    canonical: boolean,
    time: number,
    turn?: number,
    step?: number,
    usage?: UsageDelta,
  ): readonly AgentEvent[] => {
    if (!admitDurable(identity)) return NO_EVENTS
    const key = durableKey(identity) || `${identity.role}:${identity.fallbackId}`
    const images = options.images?.transcript(content, identity.fallbackId) ?? []
    return [{
      type: 'assistant.message',
      seq: nextSeq(),
      anchor: durableAnchor(identity),
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
      // Required projection key only: no assistant.attempt.* lifecycle is emitted.
      attemptId: `dsh-go:${key}`,
      time,
      blocks: content,
      ...(images.length === 0 ? {} : { images }),
      ...(usage === undefined ? {} : { usage }),
      canonical,
    }]
  }

  const translateLoad = (load: DshGoLoadResult): readonly AgentEvent[] => {
    const out: AgentEvent[] = []
    const nextEpoch = epochOf(load.journalEpoch) ?? journalEpoch
    const epochChanged = loaded && nextEpoch !== journalEpoch
    if (epochChanged) {
      clearProjection()
      out.push({ type: 'session.reset', trigger: 'dsh-go/load-epoch-change' })
    }
    journalEpoch = nextEpoch
    const loadWaterline = sequence(load.lastSeq) ?? 0
    lastSeq = requiresLoad || epochChanged || !loaded ? loadWaterline : Math.max(lastSeq, loadWaterline)
    requiresLoad = false
    loaded = true
    const effort = str(load.effortSelection) || str(load.effort)
    const permissionMode = str(load.permission)
    out.push({
      type: 'session.ready',
      sessionId: options.sessionId,
      cwd: load.cwd ?? '',
      model: load.model ?? '',
      ...(permissionMode === undefined || permissionMode === '' ? {} : { permissionMode }),
      ...(effort === undefined || effort === '' ? {} : { effort }),
      ...(load.contextWindow !== undefined && load.contextWindow > 0 ? { contextWindow: load.contextWindow } : {}),
    })
    for (const [index, message] of load.messages.entries()) {
      const v4Seq = sequence(message.v4Seq)
      const messageId = str(message.messageId)
      const fallbackId = messageId ?? (v4Seq === undefined ? `load:${message.seq}:${index}` : `v4:${v4Seq}`)
      const content = blocksOf(message.content) ?? fallbackBlocks(message.text, message.reasoning)
      if (message.role === 'user') {
        out.push(...userMessage({ role: 'user', v4Seq, messageId, fallbackId }, 'user', content, timeOf(message.time)))
      } else if (message.role === 'assistant') {
        out.push(...assistantMessage({ role: 'assistant', v4Seq, messageId, fallbackId }, content, false, timeOf(message.time), undefined, undefined, usageOf(message.usage)))
      } else if (message.role === 'tool') {
        // Only a durable message carrying the full association becomes a tool
        // result. Missing callId/turn/step remains an intentional no-event.
        const result = dshGoLoadToolResult(message, bridgeSeq + 1)
        if (result !== undefined) {
          bridgeSeq += 1
          const images = options.images?.transcript(result.content, result.callId) ?? []
          out.push(images.length === 0 ? result : { ...result, images })
        }
      }
    }
    return out
  }

  const translateUserFrame = (frame: DshGoServerFrame, data: Record<string, unknown>): readonly AgentEvent[] => {
    const v4Seq = sequence(data.v4Seq)
    const messageId = messageIdOf(data)
    const fallbackId = messageId ?? (v4Seq === undefined ? `transport:${journalEpoch}:${frame.seq}` : `v4:${v4Seq}`)
    const content = blocksOf(data.content) ?? blocksOf(rec(data.message)?.content) ?? fallbackBlocks(data.text, undefined)
    const sourceKind = str(rec(data.source)?.kind)
    const namedSources: readonly DshGoUserSource[] = ['goal', 'compaction', 'command-output', 'notification', 'team-message']
    const source: DshGoUserSource = sourceKind === 'user'
      ? 'user'
      : namedSources.includes(sourceKind as DshGoUserSource)
        ? sourceKind as DshGoUserSource
        : 'injected'
    return userMessage({ role: 'user', v4Seq, messageId, fallbackId }, source, content, timeOf(frame.time), num(data.turn))
  }

  const translateAssistantFrame = (frame: DshGoServerFrame, data: Record<string, unknown>): readonly AgentEvent[] => {
    const v4Seq = sequence(data.v4Seq)
    const messageId = messageIdOf(data)
    const fallbackId = messageId ?? (v4Seq === undefined ? `transport:${journalEpoch}:${frame.seq}` : `v4:${v4Seq}`)
    const message = rec(data.message)
    const content = blocksOf(message?.content) ?? blocksOf(data.content) ?? fallbackBlocks(data.text, data.reasoning)
    return assistantMessage(
      { role: 'assistant', v4Seq, messageId, fallbackId },
      content,
      Array.isArray(data.stream),
      timeOf(frame.time),
      num(data.turn),
      num(data.step),
      usageOf(data.usage),
    )
  }

  const translateToolCall = (frame: DshGoServerFrame, data: Record<string, unknown>): readonly AgentEvent[] => {
    const turn = num(data.turn)
    const step = num(data.step)
    const callId = str(data.callId)
    const name = str(data.name)
    const argsJson = str(data.arguments)
    if (turn === undefined || step === undefined || callId === undefined || name === undefined || argsJson === undefined) return custom(frame.type, frame.data)
    return [{
      type: 'tool.call',
      seq: nextSeq(),
      turn,
      step,
      callId,
      name,
      argsJson,
      time: timeOf(frame.time),
    }]
  }

  const translateToolResult = (frame: DshGoServerFrame, data: Record<string, unknown>): readonly AgentEvent[] => {
    const turn = num(data.turn)
    const step = num(data.step)
    const message = rec(data.message)
    const callId = str(message?.toolCallId) ?? str(rec(message?.source)?.callId)
    if (turn === undefined || step === undefined || callId === undefined) return custom(frame.type, frame.data)
    const content = blocksOf(message?.content) ?? blocksOf(data.content) ?? fallbackBlocks(data.text, undefined)
    const text = textOf(content)
    const isError = message?.isError === true || data.error !== undefined
    const errorText = text !== ''
      ? text
      : str(rec(data.error)?.message) ?? str(data.error) ?? ''
    const images = options.images?.transcript(content, callId) ?? []
    const result: AgentEventOf<'tool.result'> = {
      type: 'tool.result',
      seq: nextSeq(),
      turn,
      step,
      callId,
      isError,
      time: timeOf(frame.time),
      content,
      text,
      ...(isError ? { errorText } : {}),
      ...(images.length === 0 ? {} : { images }),
      ...(data.meta === undefined ? {} : { meta: data.meta }),
      ...(data.structured === undefined ? {} : { structured: data.structured }),
    }
    return withDshGoToolResultPresentation([result], data.view)
  }

  const translatePermissionRequest = (data: Record<string, unknown>): readonly AgentEvent[] => {
    const requestId = str(data.requestId)
    if (requestId === undefined || requestId === '') return custom('approval/request', data)
    if (pending.has(requestId) || settledPermissions.has(requestId)) return NO_EVENTS
    const rawOptions = Array.isArray(data.options) ? data.options : []
    const options = rawOptions.map(permissionOption).filter(option => option !== undefined)
    if (options.length === 0) return custom('approval/request', data)
    const toolCall = rec(data.toolCall)
    const rawInput = toolCall?.rawInput
    let input: Readonly<Record<string, unknown>> | undefined = rec(rawInput)
    let command = str(rec(rawInput)?.command)
    if (typeof rawInput === 'string') {
      try {
        input = rec(JSON.parse(rawInput))
      } catch {
        input = undefined
      }
      // PermissionRequestView.input cannot hold malformed JSON; command keeps
      // the original text visible without claiming it was parsed.
      if (input === undefined) command = rawInput
    }
    const request: PermissionRequestView = {
      requestId,
      toolName: str(data.tool) ?? '',
      ...(str(toolCall?.toolCallId) === undefined ? {} : { callId: str(toolCall?.toolCallId) }),
      ...(input === undefined ? {} : { input }),
      ...(str(toolCall?.title) === undefined ? {} : { title: str(toolCall?.title) }),
      ...(command === undefined ? {} : { command }),
      options,
    }
    pending.set(requestId, request)
    return [{ type: 'permission.request', request }]
  }

  const translatePermissionSettled = (data: Record<string, unknown>): readonly AgentEvent[] => {
    const requestId = str(data.requestId)
    if (requestId === undefined || requestId === '') return NO_EVENTS
    if (settledPermissions.has(requestId)) return NO_EVENTS
    settledPermissions.add(requestId)
    pending.delete(requestId)
    return [{ type: 'permission.settled', requestId, outcome: 'cancelled' }]
  }

  const translateTurnStart = (frame: DshGoServerFrame, data: Record<string, unknown>): readonly AgentEvent[] => {
    const turn = num(data.turn)
    if (turn === undefined) return custom(frame.type, frame.data)
    lastTurn = turn
    lastTurnClosed = false
    const userMessageId = str(data.userMessageId)
    return [{
      type: 'turn.start',
      turn,
      origin: 'user',
      ...(userMessageId === undefined ? {} : { userMessageId }),
      time: timeOf(frame.time),
    }]
  }

  const turnEnd = (frame: DshGoServerFrame, turn: number, reason: TurnEndReason): AgentEventOf<'turn.end'> | undefined => {
    if (lastTurn === turn && lastTurnClosed) return undefined
    lastTurn = turn
    lastTurnClosed = true
    return { type: 'turn.end', turn, reason, time: timeOf(frame.time) }
  }

  const closeTurn = (frame: DshGoServerFrame, turn: number, reason: TurnEndReason): readonly AgentEvent[] => {
    const event = turnEnd(frame, turn, reason)
    return event === undefined ? NO_EVENTS : [event]
  }

  const translateTurnEnd = (frame: DshGoServerFrame, data: Record<string, unknown>): readonly AgentEvent[] => {
    const turn = num(data.turn)
    const reason = turnReason(data.reason)
    if (turn === undefined || reason === undefined) return custom(frame.type, frame.data)
    const event = turnEnd(frame, turn, reason)
    if (event === undefined) return NO_EVENTS
    // v4 closes its transcript before dshd accepts another turn. Keep the
    // public close (and therefore idle) behind the host's terminal outcome.
    deferredTurnEnd = event
    return NO_EVENTS
  }

  const translateTurnOutcome = (frame: DshGoServerFrame, data: Record<string, unknown>): readonly AgentEvent[] => {
    // turnId is a host-process correlation id, not the durable numeric v4
    // turn. Only an observed turn/start/end may supply AgentEvent.turn.
    const turn = num(data.turn) ?? lastTurn
    if (turn === undefined) return custom(frame.type, frame.data)
    if (deferredTurnEnd?.turn === turn) {
      const event = deferredTurnEnd
      deferredTurnEnd = undefined
      return [event]
    }
    if (frame.type === 'turn/error') return closeTurn(frame, turn, { kind: 'error', message: str(data.error) ?? '' })
    return closeTurn(frame, turn, { kind: 'completed' })
  }

  const translateReset = (data: Record<string, unknown> | undefined): readonly AgentEvent[] => {
    clearProjection()
    journalEpoch = epochOf(data?.journalEpoch) ?? journalEpoch
    lastSeq = sequence(data?.lastSeq) ?? 0
    requiresLoad = true
    return [{ type: 'session.reset', trigger: 'dsh-go/session/reset' }]
  }

  const translateFrame = (frame: DshGoServerFrame): readonly AgentEvent[] => {
    if (frame.type === 'pong') return NO_EVENTS
    if (frame.type === 'session/reset') return translateReset(rec(frame.data))
    if (requiresLoad) return NO_EVENTS

    const data = rec(frame.data)
    if (frame.seq === 0) {
      // Only pending approval state may be replayed outside the journal.
      return frame.type === 'approval/request' && data !== undefined ? translatePermissionRequest(data) : NO_EVENTS
    }
    const seq = sequence(frame.seq)
    if (seq === undefined || seq === 0 || seq <= lastSeq || seq !== lastSeq + 1) return NO_EVENTS
    // The caller can observe the unchanged cursor on a gap and fill it with
    // session.history; this mapper never reorders or fabricates missing frames.
    lastSeq = seq
    const streamed = stepStream.translateFrame(frame)
    if (streamed !== undefined) return streamed
    if (data === undefined && frame.type !== 'turn/done') return custom(frame.type, frame.data)

    switch (frame.type) {
      case 'session/title': {
        const event = dshGoTitleChange(frame)
        return event === undefined ? custom(frame.type, frame.data) : [event]
      }
      case 'session/color': {
        const event = dshGoColorChange(frame)
        return event === undefined ? custom(frame.type, frame.data) : [event]
      }
      case 'user/message':
        return translateUserFrame(frame, data ?? {})
      case 'assistant/message':
        return translateAssistantFrame(frame, data ?? {})
      case 'tool/call':
        return translateToolCall(frame, data ?? {})
      case 'tool/result':
        return translateToolResult(frame, data ?? {})
      case 'approval/request':
        return translatePermissionRequest(data ?? {})
      case 'approval/timeout':
      case 'approval/cancel':
        return translatePermissionSettled(data ?? {})
      case 'turn/start':
        return translateTurnStart(frame, data ?? {})
      case 'turn/end':
        return translateTurnEnd(frame, data ?? {})
      case 'turn/done':
      case 'turn/error':
        return translateTurnOutcome(frame, data ?? {})
      default:
        return custom(frame.type, frame.data)
    }
  }

  return { translateLoad, translateFrame, transport, pendingPermissions, timings: stepStream.timings }
}

export type DshGoEventTranslator = ReturnType<typeof createDshGoEventTranslator>
