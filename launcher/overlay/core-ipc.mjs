#!/usr/bin/env node
/** Local-only TUI 0.19 coreDelegates / workspaceService overlay. */
import { AnchorMissing, main, overlayFile } from './_patch.mjs'

const REL = 'lib/types/dsh-adapter/channel/core/compose.js'

const SERVICE_ANCHOR = '        get service() { return host.workspaceService; },'
const SERVICE_PATCHED = `        get service() {
            const port = binding.session.capabilities.workspace;
            if (port === undefined)
                return host.workspaceService;
            return {
                list: cwd => port.list(cwd),
                resolve: (uri, cwd) => port.resolve(uri, cwd),
                listRegistry: () => port.listRegistry(),
                remove: path => port.remove(path),
                rename: (path, title) => port.renameAt(path, title),
                commands: () => port.commands(),
                runCommand: (name, input, cwd) => port.runCommand(name, input, cwd),
            };
        },`
const SERVICE_MARKER = '            const port = binding.session.capabilities.workspace;'

const DELEGATES_ANCHOR = '        resolveWorkspace: workspaces.resolveWorkspace,\n        switchWorkspace: workspaces.switchWorkspace,\n'
const DELEGATES_PATCHED = `        listWorkspaces: workspaces.listWorkspaces,
        listWorkspaceRegistry: workspaces.listWorkspaceRegistry,
        removeWorkspace: workspaces.removeWorkspace,
        renameWorkspaceAt: workspaces.renameWorkspaceAt,
        resolveWorkspace: workspaces.resolveWorkspace,
        switchWorkspace: workspaces.switchWorkspace,
        renameWorkspace: workspaces.renameWorkspace,
        workspaceCommands: () => {
            const rows = workspaces.workspaceCommands();
            if (rows.length > 0)
                return rows;
            // The host service is real; its command cache is async. Until the
            // first refresh lands, expose the fixed host command ids so a typed
            // /workspace remove|resolve is dispatched instead of "unknown".
            return ['registry', 'resolve', 'create', 'switch', 'remove'].map(name => ({ name, description: name }));
        },
        runWorkspaceCommand: workspaces.runWorkspaceCommand,
`
const DELEGATES_MARKER = '        listWorkspaceRegistry: workspaces.listWorkspaceRegistry,'

const EXTENSION_ANCHOR = `            extension: {
                ...extension.delegates,
                listSessions: (onEnriched, onPartial) => {
                    listedFrom = listSessions;
                    listedCwd = state.cwd;
                    return listSessions(onEnriched, onPartial);
                },
            },`
const EXTENSION_PATCHED = `            extension: (() => {
                const delegates = {
                    ...extension.delegates,
                    listSessions: (onEnriched, onPartial) => {
                        listedFrom = listSessions;
                        listedCwd = state.cwd;
                        return listSessions(onEnriched, onPartial);
                    },
                };
                if (binding.session.capabilities.modes !== undefined)
                    delete delegates.cycleMode;
                return delegates;
            })(),`
const EXTENSION_MARKER = `                if (binding.session.capabilities.modes !== undefined)
                    delete delegates.cycleMode;`

main({
  name: 'core-ipc',
  files: [
    overlayFile({
      rel: REL,
      bakSuffix: '.dsh-go-core-delegates.bak',
      markers: [SERVICE_MARKER, DELEGATES_MARKER, EXTENSION_MARKER],
      transform(source) {
        let next = source
        if (!next.includes(SERVICE_MARKER)) {
          if (!next.includes(SERVICE_ANCHOR)) throw new AnchorMissing(REL, 'workspaceService getter')
          next = next.replace(SERVICE_ANCHOR, SERVICE_PATCHED)
        }
        if (!next.includes(DELEGATES_MARKER)) {
          if (!next.includes(DELEGATES_ANCHOR)) throw new AnchorMissing(REL, 'workspace delegates')
          next = next.replace(DELEGATES_ANCHOR, DELEGATES_PATCHED)
        }
        if (!next.includes(EXTENSION_MARKER)) {
          if (!next.includes(EXTENSION_ANCHOR)) throw new AnchorMissing(REL, 'extension delegates')
          next = next.replace(EXTENSION_ANCHOR, EXTENSION_PATCHED)
        }
        return next
      },
    }),
  ],
})
