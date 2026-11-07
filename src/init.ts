import type { SessionCapabilities } from './types/agent/capabilities.js'

/** Only the authenticated Transport surface used by project initialization. */
export interface DshGoInitTransport {
  call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T>
}

export interface DshGoInitFile {
  readonly path: string
  readonly status: 'created' | 'unchanged' | 'failed'
  readonly error?: string
}

/** A validated host report; no local file success is inferred or synthesized. */
export interface DshGoInitResult {
  readonly ok: boolean
  readonly files: readonly DshGoInitFile[]
  readonly created: readonly string[]
  readonly unchanged: readonly string[]
  readonly failed: readonly DshGoInitFile[]
}

export interface DshGoInitOptions {
  /** Receives every valid host report, including partial failure. */
  report?(result: DshGoInitResult): void
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const invalid = (detail = 'returned an invalid result'): Error => new Error(`dsh-go: workspace.init ${detail}`)

function initFile(value: unknown, index: number): DshGoInitFile {
  const row = record(value)
  if (row === undefined || typeof row.path !== 'string' || row.path === '') {
    throw invalid(`returned no file path at index ${index}`)
  }
  if (row.status !== 'created' && row.status !== 'unchanged' && row.status !== 'failed') {
    throw invalid(`returned an invalid file status at index ${index}`)
  }
  if (row.status === 'failed' && (typeof row.error !== 'string' || row.error === '')) {
    throw invalid(`returned a failed file without an error at index ${index}`)
  }
  if (row.status !== 'failed' && row.error !== undefined) {
    throw invalid(`returned an error for a non-failed file at index ${index}`)
  }
  return {
    path: row.path,
    status: row.status,
    ...(row.status === 'failed' ? { error: row.error as string } : {}),
  }
}

export function dshGoInitResult(value: unknown): DshGoInitResult {
  const result = record(value)
  if (result === undefined || !Array.isArray(result.files) || result.files.length === 0) {
    throw invalid('returned no file results')
  }
  const files = result.files.map(initFile)
  const failed = files.filter(file => file.status === 'failed')
  return {
    ok: failed.length === 0,
    files,
    created: files.filter(file => file.status === 'created').map(file => file.path),
    unchanged: files.filter(file => file.status === 'unchanged').map(file => file.path),
    failed,
  }
}

/** Run the host's real idempotent template writer and preserve its file report. */
export async function runDshGoInit(
  transport: DshGoInitTransport,
  cwd: string,
): Promise<DshGoInitResult> {
  if (cwd.trim() === '') throw invalid('requires a working directory')
  return dshGoInitResult(await transport.call<unknown>('workspace.init', { cwd }))
}

export class DshGoInitError extends Error {
  readonly result: DshGoInitResult

  constructor(result: DshGoInitResult) {
    const summary = `created=${result.created.length}, unchanged=${result.unchanged.length}, failed=${result.failed.length}`
    const failures = result.failed.map(file => `${file.path}: ${file.error ?? 'unknown error'}`).join('; ')
    super(`dsh-go: workspace.init partial result (${summary})${failures === '' ? '' : ` — ${failures}`}`)
    this.name = 'DshGoInitError'
    this.result = result
  }
}

export function createDshGoInitCapability(
  transport: DshGoInitTransport,
  cwd: string,
  options: DshGoInitOptions = {},
): NonNullable<SessionCapabilities['init']> {
  return {
    async run(): Promise<void> {
      const result = await runDshGoInit(transport, cwd)
      options.report?.(result)
      // The official capability is void. Keep the detailed report on the error
      // and in report(), while making any failed file visible to the caller.
      if (!result.ok) throw new DshGoInitError(result)
    },
  }
}
