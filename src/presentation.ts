/**
 * Backend-neutral tool-card presentation. The card shapes are the
 * host-plane view types the UI already renders (`ToolCallView` /
 * `ToolResultView`); a backend translator decides which shape a call gets,
 * so neither the shared projector nor the UI ever picks a card by tool name.
 *
 * Ported verbatim from 0.18 `src/agent/presentation.ts` (the only change is the
 * import specifier: `../adapter/ports/channel-view.js` → `./types/agent/*`).
 * The declarations themselves live in the vendored `./types/agent/presentation.d.ts`;
 * that file is a pure `.d.ts`, so it emits no `.js` and
 * `import { isSuppressedPresentation } from './types/agent/presentation.js'`
 * typechecks and then dies with `ERR_MODULE_NOT_FOUND`. This module is the
 * runtime half — it implements the one declared value member and re-exports the
 * declarations from that single declaration site, so callers that hold the
 * vendored types stay assignable here (no second copy of `SuppressedToolPresentation`).
 */
import type { SuppressedToolPresentation, ToolCallPresentation } from './types/agent/presentation.js'

export type {
  SuppressedToolPresentation,
  ToolCallPresentation,
  ToolCallView,
  ToolPresentation,
  ToolPresentationMeta,
  ToolResultPresentation,
  ToolResultView,
} from './types/agent/presentation.js'

/** Whether a call presentation suppresses the tool card. */
export function isSuppressedPresentation(
  presentation: ToolCallPresentation | undefined,
): presentation is SuppressedToolPresentation {
  return presentation !== undefined && (presentation.card === 'question' || presentation.card === 'subagent' || presentation.card === 'todo')
}
