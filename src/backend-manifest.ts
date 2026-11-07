/**
 * A backend's static description — the runtime form of the `manifest.ts` that
 * every `src/backends/<id>/` directory ships (roadmap Stage A / P0).
 *
 * It is **pure data**: the build-time index (`scripts/gen-backend-index.mjs`)
 * imports each manifest statically, so a manifest may import nothing at all
 * except types, plus the single allowlisted version constant inside its own
 * backend (the Claude SDK pin — see `scripts/verify-backend-registry.ts`).
 * The backend implementation stays behind the registry's lazy `load()`.
 *
 * This module sits in the neutral domain layer (`src/agent/**`) on purpose: the
 * host registry, the boundary gate and the UI all need these shapes, and none
 * of them may import a concrete backend.
 *
 * Ported verbatim from 0.18 `src/agent/backend-manifest.ts` (the only change is
 * the import specifier: `./backend.js` → `./types/agent/backend.js`). The type
 * declarations live in the vendored `./types/agent/backend-manifest.d.ts`; that
 * file is a pure `.d.ts`, so it emits no `.js` and importing its two value
 * members from there typechecks and then dies with `ERR_MODULE_NOT_FOUND`. This
 * module is the runtime half: it implements `BACKEND_ID_PATTERN` and
 * `isBackendIdSyntax` and re-exports the declarations from that single
 * declaration site — the branded `BackendId` (its `unique symbol` key) must be
 * *the same* declaration on both sides, or the predicate's narrowing would not
 * be assignable to the vendored type at a call site.
 */
import type { BackendId } from './types/agent/backend-manifest.js'

export type {
  BackendEntry,
  BackendId,
  BackendManifest,
  KernelLabel,
} from './types/agent/backend-manifest.js'

/**
 * The syntax every backend id must match: readable, sortable, usable as a file
 * name. `:` is deliberately excluded — a plugin id could otherwise not become
 * `~/.dsh-tui/backends/<id>/` on Windows (drive letters / alternate data
 * streams), and `AgentSessionRef` disambiguation would need the full id set,
 * which is exactly what a plugin registry cannot enumerate (P0 §5).
 *
 * Mirrored in `bin/dsh-tui.js`, which must work without compiled modules.
 */
export const BACKEND_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u

/** Whether an untrusted value may pass into a session ref, a path or a log. */
export function isBackendIdSyntax(value: unknown): value is BackendId {
  return typeof value === 'string' && BACKEND_ID_PATTERN.test(value)
}
