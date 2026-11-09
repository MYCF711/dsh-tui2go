#!/usr/bin/env node
/** Local-only TUI 0.19 /workspace gate bridge. */
import { AnchorMissing, main, overlayFile } from './_patch.mjs'

const REL = 'lib/types/components/PromptInput.js'
const ANCHOR = '        if (command === undefined && isUnavailableLocalCommand(parsed.name, capabilities)) {'
const PATCHED = "        if (command === undefined && parsed.name !== 'workspace' && isUnavailableLocalCommand(parsed.name, capabilities)) {"
const MARKER = "parsed.name !== 'workspace' && isUnavailableLocalCommand(parsed.name, capabilities)"

main({
  name: 'promptinput-gate',
  files: [
    overlayFile({
      rel: REL,
      bakSuffix: '.dsh-go-promptinput.bak',
      markers: MARKER,
      transform(source) {
        if (source.includes(MARKER)) return source
        if (!source.includes(ANCHOR)) throw new AnchorMissing(REL, 'isUnavailableLocalCommand gate')
        return source.replace(ANCHOR, PATCHED)
      },
    }),
  ],
})
