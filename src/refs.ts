/**
 * Stable session identity across backends — the runtime implementation of the
 * vendored `./types/agent/refs.d.ts` declaration.
 *
 * A bare session id is only unique inside one backend's catalog, so every
 * cross-backend reference carries the backend id with it.
 *
 * `./types/agent/refs.d.ts` is a pure declaration file: it emits no `.js`, so
 * `import { formatSessionRef } from './types/agent/refs.js'` typechecks and then
 * dies with `ERR_MODULE_NOT_FOUND`. The four value members it declares
 * (`DEFAULT_BACKEND_ID`, `formatSessionRef`, `parseSessionRef`,
 * `sameSessionRef`) are implemented here so T4 can import them from
 * `./refs.js`.
 */
import type { AgentSessionRef } from './types/agent/refs.js'

export type { AgentSessionRef }

/**
 * Backend assumed when a persisted reference carries no prefix. The literal is
 * pinned by `refs.d.ts:24` (`export declare const DEFAULT_BACKEND_ID = "dsh"`)
 * and asserted in `test/unit/refs.test.ts`.
 */
export const DEFAULT_BACKEND_ID = 'dsh'

/**
 * Serialize a reference as `<backendId>:<sessionId>`. DSH references
 * serialize without a prefix, so DSH ids persisted by older builds (MRU
 * lists, `--resume <id>`) stay valid as-is.
 */
export function formatSessionRef(ref: AgentSessionRef): string {
  return ref.backendId === DEFAULT_BACKEND_ID ? ref.sessionId : `${ref.backendId}:${ref.sessionId}`
}

/**
 * Parse {@link formatSessionRef} output. Backend ids may themselves contain
 * a colon (`acp:gemini`), so the prefix is the longest known backend id the
 * text starts with (followed by `:` and a non-empty session id); any other
 * string is a bare DSH session id (DSH ids never need escaping this way).
 */
export function parseSessionRef(text: string, knownBackends: readonly string[]): AgentSessionRef {
  let match: string | undefined
  for (const backendId of knownBackends) {
    if (backendId === '' || backendId === DEFAULT_BACKEND_ID) continue
    if (text.length <= backendId.length + 1 || !text.startsWith(`${backendId}:`)) continue
    if (match === undefined || backendId.length > match.length) match = backendId
  }
  return match === undefined
    ? { backendId: DEFAULT_BACKEND_ID, sessionId: text }
    : { backendId: match, sessionId: text.slice(match.length + 1) }
}

/** Value equality of two references. */
export function sameSessionRef(a: AgentSessionRef, b: AgentSessionRef): boolean {
  return a.backendId === b.backendId && a.sessionId === b.sessionId
}
