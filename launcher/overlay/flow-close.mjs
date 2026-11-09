#!/usr/bin/env node
/** Local-only TUI 0.19 workspace-flow close overlay. */
import { AnchorMissing, main, overlayFile } from './_patch.mjs'

const REL = 'lib/types/screens/Chat.js'
const NEEDLE = "channel.notify(t('workspace-command-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 });"
const ADDED = "\n                dispatchOverlay({ type: 'close-if', kind: 'workspace-flow' });"
// `workspace-flow` close-if calls exist in 0.19 already, so the marker must be
// the *pair* (failure notify followed by our own call), not the single line.
const MARKER = NEEDLE + ADDED

main({
  name: 'flow-close',
  files: [
    overlayFile({
      rel: REL,
      bakSuffix: '.dsh-go-flow-close.bak',
      markers: MARKER,
      transform(source) {
        if (source.includes(MARKER)) return source
        if (!source.includes(NEEDLE)) throw new AnchorMissing(REL, 'workspace-command-failed notify')
        return source.split(NEEDLE).join(MARKER)
      },
    }),
  ],
})
