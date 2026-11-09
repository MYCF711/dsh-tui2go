#!/usr/bin/env node
/**
 * Local-only TUI 0.19 workspace action-readiness overlay.
 *
 * Replaces the blanket `refuseAsync('workspace', …)` delegates with calls into
 * the workspace port the dsh-go backend publishes on
 * `globalThis.__DSH_GO_WORKSPACE_PORT__`. A missing port still refuses — this
 * overlay never invents a successful workspace result.
 */
import { AnchorMissing, main, overlayFile } from './_patch.mjs'

const REL = 'lib/types/dsh-adapter/channel/action-readiness.js'
const ANCHOR = '    const refuseAsync = (name, value) => Promise.resolve(refuse(name, value));\n'
const HELPER = `    const wsPort = () => globalThis.__DSH_GO_WORKSPACE_PORT__;
    const ws = (name, fallback) => (...args) => {
        const port = wsPort();
        if (port === undefined || typeof port[name] !== 'function')
            return refuseAsync('workspace', fallback);
        try { return Promise.resolve(port[name](...args)); }
        catch (error) { return Promise.reject(error); }
    };
    const wsCommands = () => {
        const port = wsPort();
        if (port !== undefined && typeof port.refreshCommands === 'function')
            void port.refreshCommands();
        return port === undefined || typeof port.commands !== 'function' ? [] : port.commands();
    };
`
const HELPER_MARKER = '    const wsPort = () => globalThis.__DSH_GO_WORKSPACE_PORT__;\n'

const REPLACEMENTS = [
  ["        listWorkspaces: () => refuseAsync('workspace', []),", "        listWorkspaces: (currentCwd) => ws('list', [])(currentCwd),"],
  ["        listWorkspaceRegistry: () => refuseAsync('workspace', []),", "        listWorkspaceRegistry: () => ws('listRegistry', [])(),"],
  ["        removeWorkspace: () => refuseAsync('workspace', false),", "        removeWorkspace: (path) => ws('remove', false)(path),"],
  ["        renameWorkspaceAt: () => refuseAsync('workspace', false),", "        renameWorkspaceAt: (path, title) => ws('renameAt', false)(path, title),"],
  ["        resolveWorkspace: () => refuseAsync('workspace', undefined),", "        resolveWorkspace: (uri) => ws('resolve', undefined)(uri),"],
  ["        switchWorkspace: () => refuseAsync('workspace', false),", "        switchWorkspace: (target) => ws('switch', false)(target),"],
  ["        renameWorkspace: () => refuseAsync('workspace', false),", "        renameWorkspace: (title) => ws('rename', false)(title),"],
  ['        workspaceCommands: () => [],', '        workspaceCommands: () => wsCommands(),'],
  ["        runWorkspaceCommand: () => refuseAsync('workspace', undefined),", "        runWorkspaceCommand: (name, input) => ws('runCommand', undefined)(name, input),"],
]

main({
  name: 'workspace-action-readiness',
  files: [
    overlayFile({
      rel: REL,
      bakSuffix: '.dsh-go-workspace.bak',
      markers: [HELPER_MARKER, REPLACEMENTS[0][1], REPLACEMENTS[REPLACEMENTS.length - 1][1]],
      transform(source) {
        let next = source
        if (!next.includes(HELPER_MARKER)) {
          if (!next.includes(ANCHOR)) throw new AnchorMissing(REL, 'refuseAsync helper')
          next = next.replace(ANCHOR, ANCHOR + HELPER)
        }
        for (const [from, to] of REPLACEMENTS) {
          if (next.includes(to)) continue
          if (!next.includes(from)) throw new AnchorMissing(REL, from.trim())
          next = next.replace(from, to)
        }
        return next
      },
    }),
  ],
})
