import { randomUUID } from 'node:crypto'
import type { SessionCapabilities } from './types/agent/capabilities.js'
import type { DshGoSideQueryRequest } from './transport.js'

/** The authenticated HTTP surface of W149's independent side runner. */
export interface DshGoSideQueryTransport {
  call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T>
  sideQuery(request: DshGoSideQueryRequest): Promise<string | null>
}

/**
 * A host-owned isolated session or independent runner. This explicit marker
 * keeps an ordinary session.prompt transport from being passed as a side query.
 */
export interface DshGoSideQueryRunner {
  readonly isolation: 'ephemeral-session' | 'independent-runner'
  run(request: {
    readonly sessionId: string
    readonly prompt: string
    readonly stream: boolean
    readonly signal: AbortSignal
    readonly onText: (delta: string) => void
  }): Promise<string | null>
  close?(sessionId: string): void | Promise<void>
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

function confirmed(method: string, result: unknown): void {
  if (result === null || typeof result !== 'object' || Array.isArray(result)
    || (result as Record<string, unknown>).ok !== true) {
    throw new Error(`dsh-go: ${method} returned an invalid result`)
  }
}

/** Bind W149 side.query/side.cancel/side.close without touching session.prompt. */
export function createDshGoIndependentSideQueryRunner(
  transport: DshGoSideQueryTransport,
): DshGoSideQueryRunner & { close(sessionId: string): Promise<void> } {
  if (transport === undefined || transport === null
    || typeof transport.call !== 'function' || typeof transport.sideQuery !== 'function') {
    throw new Error('dsh-go: sideQuery requires the real side.query Transport')
  }
  return {
    isolation: 'independent-runner',
    async run({ sessionId, prompt, stream, signal, onText }) {
      const requestId = randomUUID()
      let cancelling: Promise<void> | undefined
      const cancel = (): void => {
        cancelling ??= Promise.resolve().then(async () => {
          confirmed('side.cancel', await transport.call('side.cancel', { id: sessionId, requestId }))
        })
      }
      if (signal.aborted) cancel()
      else signal.addEventListener('abort', cancel, { once: true })
      try {
        return await transport.sideQuery({ id: sessionId, requestId, prompt, stream, signal, onText })
      } finally {
        signal.removeEventListener('abort', cancel)
        if (cancelling !== undefined) await cancelling
      }
    },
    async close(sessionId) {
      confirmed('side.close', await transport.call('side.close', { id: sessionId }))
    },
  }
}

/**
 * Adapt only a real isolated runner. Construction without one fails loudly;
 * callers must leave SessionCapabilities.sideQuery absent until it exists.
 */
export function createDshGoSideQuery(sessionId: string, runner: DshGoSideQueryRunner) {
  if (sessionId === '') throw new Error('dsh-go: sideQuery requires a source session id')
  if (runner === undefined || runner === null
    || (runner.isolation !== 'ephemeral-session' && runner.isolation !== 'independent-runner')
    || typeof runner.run !== 'function') {
    throw new Error('dsh-go: sideQuery requires a real isolated session or independent runner; session.prompt is not a side query')
  }

  let closed = false
  let closePromise: Promise<void> | undefined
  const active = new Set<AbortController>()
  const capability: NonNullable<SessionCapabilities['sideQuery']> = {
    async ask(prompt, options = {}) {
      if (options.signal?.aborted) return { answer: null }
      if (closed) return { answer: null, error: 'dsh-go: sideQuery is closed' }
      const owner = new AbortController()
      active.add(owner)
      const signal = options.signal === undefined ? owner.signal : AbortSignal.any([owner.signal, options.signal])
      let finished = false
      let streamed = ''
      let abort: (() => void) | undefined
      const cancelled = new Promise<undefined>(resolve => {
        abort = () => { resolve(undefined) }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
      try {
        const work = runner.run({
          sessionId,
          prompt,
          stream: options.onText !== undefined,
          signal,
          onText: delta => {
            if (finished || signal.aborted || delta === '') return
            streamed += delta
            options.onText?.(delta)
          },
        })
        const settled = await Promise.race([work, cancelled])
        if (signal.aborted || settled === undefined || settled === null) return { answer: null }
        if (typeof settled !== 'string') return { answer: null, error: 'dsh-go: isolated sideQuery runner returned a non-string answer' }
        const answer = (settled === '' ? streamed : settled).trim()
        if (answer === '') return { answer: null, error: 'dsh-go: isolated sideQuery runner returned no answer' }
        if (streamed === '') options.onText?.(answer)
        return { answer }
      } catch (error) {
        if (signal.aborted) return { answer: null }
        return { answer: null, error: errorText(error) }
      } finally {
        finished = true
        if (abort !== undefined) signal.removeEventListener('abort', abort)
        active.delete(owner)
      }
    },
  }
  return {
    capability,
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise
      closed = true
      for (const controller of active) controller.abort()
      active.clear()
      closePromise = Promise.resolve().then(async () => { await runner.close?.(sessionId) })
      return closePromise
    },
  }
}
