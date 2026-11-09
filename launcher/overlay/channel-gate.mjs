#!/usr/bin/env node
/** Local-only TUI 0.19 `channel` command availability gate. */
import { AnchorMissing, main, overlayFile } from './_patch.mjs'

const REL = 'lib/types/commands.js'
const ANCHOR = `    if (name === BACKEND_GOAL_COMMAND.name)\n        return capabilities.goals === false;\n`
const ADDED = `    if (name === 'channel')\n        return capabilities.channels === false;\n`

main({
  name: 'channel-gate',
  files: [
    overlayFile({
      rel: REL,
      bakSuffix: '.dsh-go-channel-gate.bak',
      markers: ADDED,
      transform(source) {
        if (source.includes(ADDED)) return source
        if (!source.includes(ANCHOR)) throw new AnchorMissing(REL, 'BACKEND_GOAL_COMMAND gate')
        return source.replace(ANCHOR, ANCHOR + ADDED)
      },
    }),
  ],
})
