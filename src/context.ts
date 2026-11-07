import type { ContextItemView, ContextUsageView, SessionCapabilities } from './types/agent/capabilities.js'

/** Only the authenticated Transport surface used by context reports. */
export interface DshGoContextTransport {
  call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T>
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const tokens = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const text = (value: unknown): value is string => typeof value === 'string' && value !== ''

function invalid(method: string, detail = 'returned an invalid context usage result'): Error {
  return new Error(`dsh-go: ${method} ${detail}`)
}

function item(value: unknown, method: string): ContextItemView {
  const row = record(value)
  if (row === undefined || !text(row.name) || !tokens(row.tokens)) throw invalid(method)
  return { name: row.name, tokens: row.tokens }
}

function items(value: unknown, method: string): ContextItemView[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw invalid(method)
  return value.map(row => item(row, method))
}

/**
 * Project the existing session.load counters. `context` is one aggregate used
 * category, not an invented per-section breakdown. A missing counter is not 0.
 */
export function dshGoContextSummary(value: unknown): ContextUsageView {
  const load = record(value)
  if (load === undefined || !Object.hasOwn(load, 'contextTokens') || !tokens(load.contextTokens)) {
    throw invalid('session.load', 'returned no valid contextTokens measurement')
  }
  if (load.contextWindow !== undefined && !tokens(load.contextWindow)) {
    throw invalid('session.load', 'returned an invalid contextWindow')
  }
  const used = load.contextTokens
  const max = load.contextWindow === undefined || load.contextWindow === 0 ? undefined : load.contextWindow
  return {
    used,
    ...(max === undefined ? {} : { max }),
    categories: [{ name: 'context', tokens: used, kind: 'used' }],
  }
}

/** Validate the additive host's full report without filling in missing facts. */
export function dshGoContextUsageView(value: unknown): ContextUsageView {
  const method = 'context.usage'
  const usage = record(value)
  if (usage === undefined || !tokens(usage.used) || !Array.isArray(usage.categories)) throw invalid(method)
  if (usage.max !== undefined && (!tokens(usage.max) || usage.max === 0)) throw invalid(method)
  const categories = usage.categories.map(raw => {
    const row = record(raw)
    if (row === undefined || !text(row.name) || !tokens(row.tokens) || !text(row.kind)) throw invalid(method)
    return { name: row.name, tokens: row.tokens, kind: row.kind }
  })
  const sections = items(usage.sections, method)
  const skills = items(usage.skills, method)
  let files: ContextUsageView['files']
  if (usage.files !== undefined) {
    if (!Array.isArray(usage.files)) throw invalid(method)
    files = usage.files.map(raw => {
      const row = record(raw)
      if (row === undefined || !text(row.path) || !tokens(row.tokens)) throw invalid(method)
      return { path: row.path, tokens: row.tokens }
    })
  }
  let tools: ContextUsageView['tools']
  if (usage.tools !== undefined) {
    if (!Array.isArray(usage.tools)) throw invalid(method)
    tools = usage.tools.map(raw => {
      const row = record(raw)
      if (row === undefined || !text(row.name) || !tokens(row.tokens)
        || (row.server !== undefined && !text(row.server))) throw invalid(method)
      return { name: row.name, tokens: row.tokens, ...(row.server === undefined ? {} : { server: row.server }) }
    })
  }
  return {
    used: usage.used,
    ...(usage.max === undefined ? {} : { max: usage.max }),
    categories,
    ...(sections === undefined ? {} : { sections }),
    ...(files === undefined ? {} : { files }),
    ...(skills === undefined ? {} : { skills }),
    ...(tools === undefined ? {} : { tools }),
  }
}

export async function loadDshGoContextUsage(
  transport: DshGoContextTransport,
  sessionId: string,
  detail: 'summary' | 'full',
): Promise<ContextUsageView> {
  if (sessionId === '') throw new Error('dsh-go: context usage requires a session id')
  if (detail === 'summary') {
    return dshGoContextSummary(await transport.call<unknown>('session.load', { id: sessionId, tailMessages: 1 }))
  }
  if (detail !== 'full') throw new Error(`dsh-go: unsupported context detail ${JSON.stringify(detail)}`)
  return dshGoContextUsageView(await transport.call<unknown>('context.usage', { id: sessionId, detail }))
}

export function createDshGoContextCapability(
  transport: DshGoContextTransport,
  sessionId: string,
): NonNullable<SessionCapabilities['context']> {
  return { usage: detail => loadDshGoContextUsage(transport, sessionId, detail) }
}
