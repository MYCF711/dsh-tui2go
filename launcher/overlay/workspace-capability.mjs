#!/usr/bin/env node
/** Local-only TUI 0.19 workspace capability row overlay. */
import { AnchorMissing, main, overlayFile } from './_patch.mjs'

const REL = 'lib/types/channel/capabilities.js'
const ANCHOR = '        goals: input.dsh || caps.goals !== undefined,\n'
const ADDED = '        workspace: caps.workspace !== undefined,\n'

main({
  name: 'workspace-capability',
  files: [
    overlayFile({
      rel: REL,
      bakSuffix: '.dsh-go-workspace-capability.bak',
      markers: ANCHOR + ADDED,
      transform(source) {
        if (source.includes(ANCHOR + ADDED)) return source
        if (!source.includes(ANCHOR)) throw new AnchorMissing(REL, 'goals capability row')
        return source.replace(ANCHOR, ANCHOR + ADDED)
      },
    }),
  ],
})
