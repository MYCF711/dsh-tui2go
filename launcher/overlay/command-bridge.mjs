#!/usr/bin/env node
/** Local-only TUI 0.19 command bridge overlay (temporary play profile only). */
import { AnchorMissing, main, overlayFile } from './_patch.mjs'

const COMMANDS = 'lib/types/commands.js'
const CAPABILITIES = 'lib/types/channel/capabilities.js'

const COMMANDS_ANCHOR = "    ['trace', 'any'],\n"
const COMMANDS_ADDED = "    ['workspace', 'workspace'],\n"

const CAPABILITIES_ANCHOR = '        modes: input.dsh || caps.modes !== undefined,\n'
const CAPABILITIES_ADDED = '        workspace: caps.workspace !== undefined,\n'

main({
  name: 'command-bridge',
  files: [
    overlayFile({
      rel: COMMANDS,
      bakSuffix: '.dsh-go-command-bridge.bak',
      markers: COMMANDS_ADDED.trim(),
      transform(source) {
        if (source.includes(COMMANDS_ADDED)) return source
        if (!source.includes(COMMANDS_ANCHOR)) throw new AnchorMissing(COMMANDS, "['trace', 'any']")
        return source.replace(COMMANDS_ANCHOR, COMMANDS_ANCHOR + COMMANDS_ADDED)
      },
    }),
    overlayFile({
      rel: CAPABILITIES,
      bakSuffix: '.dsh-go-command-bridge.bak',
      markers: CAPABILITIES_ANCHOR + CAPABILITIES_ADDED,
      transform(source) {
        if (source.includes(CAPABILITIES_ANCHOR + CAPABILITIES_ADDED)) return source
        if (!source.includes(CAPABILITIES_ANCHOR)) throw new AnchorMissing(CAPABILITIES, 'modes capability row')
        return source.replace(CAPABILITIES_ANCHOR, CAPABILITIES_ANCHOR + CAPABILITIES_ADDED)
      },
    }),
  ],
})
