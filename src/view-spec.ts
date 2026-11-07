import type { AgentEvent, AgentEventOf, ContentBlockView } from './types/agent/events.js'
import type { ToolResultPresentation } from './types/agent/presentation.js'
import type { DshGoLoadMessage } from './events.js'

/** The host-owned ViewSpec; no tool-name presenter is inferred without it. */
export interface DshGoViewSpec {
  readonly kind: 'card' | 'table' | 'plain'
  readonly title?: string
  readonly badge?: string
  readonly fields?: readonly { readonly key: string; readonly value: string }[]
  readonly columns?: readonly string[]
  readonly rows?: readonly (readonly string[])[]
  readonly body?: string
}

export interface DshGoLoadToolMessage extends DshGoLoadMessage {
  readonly callId?: string
  readonly toolCallId?: string
  readonly turn?: number
  readonly step?: number
  readonly isError?: boolean
  readonly error?: unknown
  readonly meta?: unknown
  readonly structured?: unknown
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const time = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
const position = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : undefined
}

function parseView(value: unknown): DshGoViewSpec | undefined {
  const row = rec(value)
  if (row === undefined || !['card', 'table', 'plain'].includes(text(row.kind) ?? '')) return undefined
  let fields: DshGoViewSpec['fields'] | undefined
  if (row.fields !== undefined) {
    if (!Array.isArray(row.fields)) return undefined
    const parsed = row.fields.map(field => {
      const item = rec(field)
      const key = text(item?.key)
      const fieldValue = text(item?.value)
      return key === undefined || fieldValue === undefined ? undefined : { key, value: fieldValue }
    })
    if (parsed.some(field => field === undefined)) return undefined
    fields = parsed as NonNullable<DshGoViewSpec['fields']>
  }
  const columns = row.columns === undefined ? undefined : strings(row.columns)
  if (columns === undefined && row.columns !== undefined) return undefined
  let rows: DshGoViewSpec['rows'] | undefined
  if (row.rows !== undefined) {
    if (!Array.isArray(row.rows)) return undefined
    const parsed = row.rows.map(strings)
    if (parsed.some(row => row === undefined)) return undefined
    rows = parsed as NonNullable<DshGoViewSpec['rows']>
  }
  for (const key of ['title', 'badge', 'body'] as const) {
    if (row[key] !== undefined && typeof row[key] !== 'string') return undefined
  }
  return {
    kind: row.kind as DshGoViewSpec['kind'],
    ...(row.title === undefined ? {} : { title: row.title as string }),
    ...(row.badge === undefined ? {} : { badge: row.badge as string }),
    ...(fields === undefined ? {} : { fields: fields as NonNullable<DshGoViewSpec['fields']> }),
    ...(columns === undefined ? {} : { columns }),
    ...(rows === undefined ? {} : { rows: rows as NonNullable<DshGoViewSpec['rows']> }),
    ...(row.body === undefined ? {} : { body: row.body as string }),
  }
}

const escapeCell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', '<br>')

function tableText(view: DshGoViewSpec): string {
  const columns = view.columns ?? []
  const lines = [
    `| ${columns.map(escapeCell).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...(view.rows ?? []).map(row => `| ${row.map(escapeCell).join(' | ')} |`),
  ]
  return lines.join('\n')
}

/**
 * Map an actual DSH-GO ViewSpec to the existing generic result card. The
 * upstream has no table-specific ToolResultView, so table text is explicit
 * Markdown rather than a fabricated terminal/read/search presentation.
 */
export function dshGoViewSpecPresentation(value: unknown): ToolResultPresentation | undefined {
  const view = parseView(value)
  if (view === undefined) return undefined
  const content: { type: string; text: string }[] = []
  if (view.badge !== undefined && view.badge !== '') content.push({ type: 'text', text: view.badge })
  if (view.kind === 'card') {
    const fields = (view.fields ?? []).map(field => `${field.key}: ${field.value}`).join('\n')
    if (fields !== '') content.push({ type: 'text', text: fields })
    if (view.body !== undefined && view.body !== '') content.push({ type: 'text', text: view.body })
  } else if (view.kind === 'table') {
    content.push({ type: 'text', text: tableText(view) })
    if (view.body !== undefined && view.body !== '') content.push({ type: 'text', text: view.body })
  } else if (view.body !== undefined) {
    content.push({ type: 'text', text: view.body })
  }
  return {
    card: 'generic',
    ...(view.title === undefined || view.title === '' ? {} : { title: view.title }),
    ...(content.length === 0 ? {} : { content }),
  }
}

/** Decorate only real translator output; absent/malformed views keep the raw fallback. */
export function withDshGoToolResultPresentation(
  events: readonly AgentEvent[],
  view: unknown,
): readonly AgentEvent[] {
  const presentation = dshGoViewSpecPresentation(view)
  if (presentation === undefined) return events
  return events.map(event => event.type === 'tool.result' ? { ...event, presentation } : event)
}

function blocks(message: DshGoLoadToolMessage): readonly ContentBlockView[] {
  if (Array.isArray(message.content)) {
    return message.content.flatMap(block => {
      const row = rec(block)
      const type = text(row?.type)
      if (row === undefined || type === undefined) return []
      const value = text(row.text)
      return [{ ...row, type, ...(value === undefined ? {} : { text: value }) }]
    })
  }
  return message.text === '' ? [] : [{ type: 'text', text: message.text }]
}

/**
 * Restore a load/transcript.page tool result only when the durable message
 * itself carries all three association fields. No call, timestamp or identity
 * is reconstructed from tool/args/summary; full tool cards still need raw frames.
 */
export function dshGoLoadToolResult(
  message: DshGoLoadToolMessage,
  seq: number,
): AgentEventOf<'tool.result'> | undefined {
  if (message.role !== 'tool') return undefined
  const callId = text(message.callId) ?? text(message.toolCallId)
  const turn = position(message.turn)
  const step = position(message.step)
  if (callId === undefined || callId === '' || turn === undefined || step === undefined) return undefined
  const content = blocks(message)
  const resultText = content.map(block => block.type === 'text' ? block.text ?? '' : '').join('')
  const isError = message.isError === true || message.error !== undefined
  const error = rec(message.error)
  const presentation = dshGoViewSpecPresentation(message.view)
  return {
    type: 'tool.result',
    seq,
    turn,
    step,
    callId,
    isError,
    time: time(message.time),
    content,
    text: resultText,
    ...(isError ? { errorText: resultText !== '' ? resultText : text(error?.message) ?? text(message.error) ?? '' } : {}),
    ...(message.meta === undefined ? {} : { meta: message.meta }),
    ...(message.structured === undefined ? {} : { structured: message.structured }),
    ...(presentation === undefined ? {} : { presentation }),
  }
}
