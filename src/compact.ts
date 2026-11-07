import type { SessionCapabilities } from './types/agent/capabilities.js'

/** The native result of DSH-GO session.compact. */
export interface DshGoCompactResult {
  readonly compacted: boolean
  readonly from?: number
  readonly to?: number
  readonly shadowed?: number
  readonly summaryChars?: number
}

/** Only the Transport surface needed by compaction. */
export interface DshGoCompactTransport {
  call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T>
}

function isCompactResult(value: unknown): value is DshGoCompactResult {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { compacted?: unknown }).compacted === 'boolean'
}

/** Run the native RPC and preserve its real result, including compacted=false. */
export async function runDshGoCompact(
  transport: DshGoCompactTransport,
  sessionId: string,
  keep = 6,
): Promise<DshGoCompactResult> {
  const result = await transport.call<unknown>('session.compact', { id: sessionId, keep })
  if (!isCompactResult(result)) throw new Error('dsh-go: session.compact returned an invalid result')
  return result
}

/** Adapt the native result-producing RPC to the current void capability contract. */
export function createDshGoCompactCapability(
  transport: DshGoCompactTransport,
  sessionId: string,
  keep = 6,
): NonNullable<SessionCapabilities['compact']> {
  return {
    async run() {
      await runDshGoCompact(transport, sessionId, keep)
    },
  }
}
