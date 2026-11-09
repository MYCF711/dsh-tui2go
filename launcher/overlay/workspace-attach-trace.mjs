#!/usr/bin/env node
/**
 * Local-only TUI 0.19 workspace attach tracing.
 *
 * Writes `workspace.attach.*` / `workspace.resolve.result` / `workspace.create.result`
 * JSON lines to `$DSH_GO_DEBUG_LOG` so the merge gate can assert the attach
 * lifecycle instead of guessing from the rendered screen.
 */
import { AnchorMissing, main, overlayFile } from './_patch.mjs'

const REL = 'lib/types/dsh-adapter/workspace.js'

const ANCHOR = `export async function attachSessionToWorkspace(ctx, cwd, sessionId) {
    const registry = ctx.get('workspaceRegistry');
    if (registry === undefined)
        return false;
    const workspace = await registry.resolveByPath(cwd) ?? await registry.create(cwd);
    await workspace.attachSession(sessionId);
    return true;
}`

const PATCHED = `import { appendFileSync } from 'node:fs';
const dbgOpen = (event) => {
    const file = process.env.DSH_GO_DEBUG_LOG;
    if (!file)
        return;
    try { appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + String.fromCharCode(10)); } catch { }
};
export async function attachSessionToWorkspace(ctx, cwd, sessionId) {
    const registry = ctx.get('workspaceRegistry');
    dbgOpen({ event: 'workspace.attach.start', cwd, sessionId, hasRegistry: registry !== undefined });
    if (registry === undefined)
        return false;
    const resolved = await registry.resolveByPath(cwd);
    dbgOpen({ event: 'workspace.resolve.result', cwd, sessionId, resolved: resolved === undefined ? null : { id: resolved.id, path: resolved.path, title: resolved.title } });
    const workspace = resolved ?? await registry.create(cwd);
    dbgOpen({ event: 'workspace.create.result', cwd, sessionId, workspace: { id: workspace.id, path: workspace.path, title: workspace.title } });
    try {
        await workspace.attachSession(sessionId);
        dbgOpen({ event: 'workspace.attach.ok', cwd, sessionId, workspaceId: workspace.id });
        return true;
    } catch (error) {
        dbgOpen({ event: 'workspace.attach.error', cwd, sessionId, workspaceId: workspace.id, error: { name: error?.name, message: error?.message, stack: error?.stack, code: error?.code, hint: error?.hint, status: error?.status, retryable: error?.retryable, body: error?.body } });
        throw error;
    }
}`

const MARKER = "dbgOpen({ event: 'workspace.attach.start'"

main({
  name: 'workspace-attach-trace',
  files: [
    overlayFile({
      rel: REL,
      bakSuffix: '.dsh-go-open-trace.bak',
      markers: MARKER,
      transform(source) {
        if (source.includes(MARKER)) return source
        if (!source.includes(ANCHOR)) throw new AnchorMissing(REL, 'attachSessionToWorkspace')
        return source.replace(ANCHOR, PATCHED)
      },
    }),
  ],
})
