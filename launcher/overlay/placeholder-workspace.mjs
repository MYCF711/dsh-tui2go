#!/usr/bin/env node
/**
 * Local-only TUI 0.19 `/workspace` overlay for a third-party (dsh-go) backend.
 *
 * `placeholder-workspace` carries the real workspace port from the backend into
 * the session; this overlay makes the TUI action delegates consume it instead of
 * refusing every workspace action.
 */
import { AnchorMissing, main, overlayFile } from './_patch.mjs'

const BACKENDS = 'lib/types/dsh-adapter/backends.js'
const PLUGIN = 'lib/types/dsh-adapter/plugin.js'

const BACKENDS_ANCHOR = '        resumeCommand: (sessionId) => launch.resumeCommand(sessionId),\n'
const BACKENDS_ADDED = '        ...(backend.workspace === undefined ? {} : { workspace: backend.workspace }),\n'

main({
  name: 'placeholder-workspace',
  files: [
    overlayFile({
      rel: BACKENDS,
      bakSuffix: '.dsh-go-placeholder-workspace.bak',
      markers: BACKENDS_ADDED.trim(),
      transform(source) {
        if (source.includes(BACKENDS_ADDED)) return source
        if (!source.includes(BACKENDS_ANCHOR)) throw new AnchorMissing(BACKENDS, 'backend resumeCommand')
        return source.replace(BACKENDS_ANCHOR, BACKENDS_ANCHOR + BACKENDS_ADDED)
      },
    }),
    overlayFile({
      rel: PLUGIN,
      bakSuffix: '.dsh-go-placeholder-workspace.bak',
      markers: [
        'const startingSession = createStartingSession(prepared.backendId, sessionCwd);',
        'backendStart = { ...prepared, session: startingSession, initialHistory: [] };',
      ],
      transform(source) {
        if (source.includes('backendStart = { ...prepared, session: startingSession, initialHistory: [] };')) return source
        const lines = source.split('\n')
        const at = lines.findIndex(line => line.trim().startsWith('backendStart = { ...prepared, session: createStartingSession('))
        if (at < 0) throw new AnchorMissing(PLUGIN, 'backendStart = { ...prepared, session: createStartingSession(')
        const indent = lines[at].slice(0, lines[at].indexOf('backendStart'))
        lines.splice(
          at,
          1,
          indent + 'const startingSession = createStartingSession(prepared.backendId, sessionCwd);',
          indent + 'if (prepared.workspace !== undefined)',
          indent + '    startingSession.capabilities.workspace = prepared.workspace;',
          indent + 'backendStart = { ...prepared, session: startingSession, initialHistory: [] };',
        )
        return lines.join('\n')
      },
    }),
  ],
})
