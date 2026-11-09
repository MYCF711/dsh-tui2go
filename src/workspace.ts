/**
 * Workspace port for the non-DSH TUI composition.
 *
 * TUI 0.19's `createUnavailableActionDelegates` refuses every workspace action
 * for a third-party backend. The local 0.19 overlay consumes this bridge; the
 * backend installs it on open and clears it on dispose. Every method is a real
 * `dshd` Transport call — this module never invents a successful list/registry.
 */
export interface DshGoWorkspaceTransport {
  call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T>
}

export interface DshGoWorkspaceTarget {
  readonly uri: string
  readonly cwd: string
  readonly label: string
  readonly description?: string
  readonly kind: 'local' | 'provider'
  readonly badge: string
}

export interface DshGoWorkspaceEntry {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly present: boolean
  readonly sessionCount: number
}

export interface DshGoWorkspaceCommand {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description: string
}

export type DshGoWorkspaceCommandResult =
  | { readonly kind: 'target'; readonly target: DshGoWorkspaceTarget }
  | {
      readonly kind: 'choices'
      readonly title: string
      readonly choices: readonly {
        readonly id: string
        readonly label: string
        readonly description?: string
        readonly badge?: string
      }[]
    }

export interface DshGoWorkspacePort {
  list(currentCwd: string): Promise<readonly DshGoWorkspaceTarget[]>
  listRegistry(): Promise<readonly DshGoWorkspaceEntry[]>
  resolve(uri: string): Promise<DshGoWorkspaceTarget | undefined>
  switch(target: DshGoWorkspaceTarget): Promise<boolean>
  renameAt(cwd: string, title: string): Promise<DshGoWorkspaceTarget | undefined>
  rename(title: string): Promise<DshGoWorkspaceTarget | undefined>
  remove(cwd: string): Promise<boolean>
  commands(): readonly DshGoWorkspaceCommand[]
  refreshCommands(): Promise<void>
  runCommand(name: string, input: string, cwd?: string): Promise<DshGoWorkspaceCommandResult | undefined>
}

/** Global handoff consumed only by the local 0.19 overlay. */
export const DSH_GO_WORKSPACE_BRIDGE = '__DSH_GO_WORKSPACE_PORT__'

export function installDshGoWorkspacePort(port: DshGoWorkspacePort | undefined): void {
  const g = globalThis as { [key: string]: unknown }
  // The reproducible local 0.19 fixture owns the bridge; a real backend must
  // not overwrite it while that fixture is active.
  if (g.__DSH_GO_WORKSPACE_FIXTURE__ === true) return
  if (port === undefined) delete g[DSH_GO_WORKSPACE_BRIDGE]
  else g[DSH_GO_WORKSPACE_BRIDGE] = port
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined
function target(value: unknown): DshGoWorkspaceTarget | undefined {
  const row = record(value) ?? {}
  // Official WorkspaceView: {workspaceId,path,title}; TUI target: {uri,cwd,label}.
  const workspaceId = text(row.workspaceId)
  const uri = text(row.uri) ?? (workspaceId === undefined ? undefined : `workspace://${workspaceId}`)
  const cwd = text(row.cwd) ?? text(row.path)
  if (uri === undefined || cwd === undefined) return undefined
  const kind = row.kind === 'provider' ? 'provider' : 'local'
  return {
    uri, cwd, kind,
    label: text(row.label) ?? text(row.title) ?? cwd,
    ...(text(row.description) === undefined ? {} : { description: text(row.description)! }),
    badge: text(row.badge) ?? (workspaceId === undefined ? 'local' : 'workspace'),
  }
}
function targets(value: unknown): DshGoWorkspaceTarget[] {
  const row = record(value) ?? {}
  const rows = Array.isArray(row?.workspaces) ? row.workspaces : Array.isArray(row?.targets) ? row.targets : []
  return rows.map(target).filter((item): item is DshGoWorkspaceTarget => item !== undefined)
}
function entries(value: unknown): DshGoWorkspaceEntry[] {
  const row = record(value) ?? {}
  const rows = Array.isArray(row?.entries) ? row.entries : Array.isArray(row?.workspaces) ? row.workspaces : []
  return rows.map(raw => {
    const item = record(raw) ?? {}
    const id = text(item.id) ?? text(item.workspaceId); const path = text(item.path)
    if (id === undefined || path === undefined) return undefined
    const sessions = Array.isArray(item.sessionIds) ? item.sessionIds.length : 0
    return { id, path, title: text(item.title) ?? path, present: item.present !== false, sessionCount: typeof item.sessionCount === 'number' ? item.sessionCount : sessions }
  }).filter((item): item is DshGoWorkspaceEntry => item !== undefined)
}
function commands(value: unknown): DshGoWorkspaceCommand[] {
  const row = record(value) ?? {}
  const rows = Array.isArray(row.commands) ? row.commands : []
  return rows.map(raw => {
    const item = record(raw) ?? {}
    // Host shape: {id,title,available,reason}; the TUI vocabulary calls it name/description.
    const name = text(item.name) ?? text(item.id)
    if (name === undefined) return undefined
    const title = text(item.title) ?? text(item.description) ?? name
    const unavailable = item.available === false ? `（不可用：${text(item.reason) ?? '宿主未提供'}）` : ''
    return { name, description: title + unavailable }
  }).filter((item): item is DshGoWorkspaceCommand => item !== undefined)
}
function commandResult(value: unknown): DshGoWorkspaceCommandResult | undefined {
  const row = record(value) ?? {}
  if (row.kind === 'target') {
    const t = target(row.target); return t === undefined ? undefined : { kind: 'target', target: t }
  }
  if (row.kind === 'choices') {
    const title = text(row.title) ?? ''
    const rows = Array.isArray(row.choices) ? row.choices : []
    return { kind: 'choices', title, choices: rows.map(raw => {
      const item = record(raw) ?? {}; const id = text(item.id)
      if (id === undefined) return undefined
      return { id, label: text(item.label) ?? id, ...(text(item.description) === undefined ? {} : { description: text(item.description)! }), ...(text(item.badge) === undefined ? {} : { badge: text(item.badge)! }) }
    }).filter((item): item is { id: string; label: string; description?: string; badge?: string } => item !== undefined) }
  }
  return undefined
}

export function createDshGoWorkspacePort(transport: DshGoWorkspaceTransport, sessionId: string, requestedCwd = ''): DshGoWorkspacePort {
  let cwd = requestedCwd
  let commandRows: readonly DshGoWorkspaceCommand[] = []
  const registry = async (): Promise<DshGoWorkspaceTarget[]> => targets(await transport.call<unknown>('workspace.registry', {}))
  const current = (): string => cwd
  return {
    async list(currentCwd) {
      cwd = currentCwd
      return registry()
    },
    async listRegistry() {
      return entries(await transport.call<unknown>('workspace.registry', {}))
    },
    async resolve(uri) {
      const result = await transport.call<unknown>('workspace.resolve', { uri })
      return target(record(result)?.workspace ?? result)
    },
    async switch(next) {
      // The official switch takes a registry reference; path is the stable
      // identifier the TUI target already carries.
      const result = await transport.call<unknown>('workspace.switch', { path: next.cwd })
      const row = record(result)?.workspace
      if (row === undefined) return false
      cwd = next.cwd
      return true
    },
    async renameAt(path, title) {
      const resolved = await transport.call<unknown>('workspace.resolve', { path })
      const workspaceId = text(record(record(resolved)?.workspace)?.workspaceId)
      if (workspaceId === undefined) return undefined
      const result = await transport.call<unknown>('workspace.rename', { request: { workspaceId, title } })
      return target(record(result)?.workspace ?? result)
    },
    async rename(title) {
      if (cwd === '') return undefined
      try {
        return await this.renameAt(cwd, title)
      } catch {
        // A switched session can keep the pre-switch cwd for one frame; the
        // registry has the real workspace whose title the user is editing.
        const list = await registry()
        return list[0] === undefined ? undefined : this.renameAt(list[0].cwd, title)
      }
    },
    async remove(path) {
      const result = await transport.call<unknown>('workspace.remove', { path })
      return record(result)?.removed === true
    },
    commands() {
      return commandRows
    },
    async refreshCommands() {
      commandRows = commands(await transport.call<unknown>('workspace.commands', {}))
    },
    async runCommand(name, input, path) {
      const at = path ?? current()
      if (name === 'registry') {
        const list = await registry()
        return list[0] === undefined ? undefined : { kind: 'target', target: list[0] }
      }
      if (name === 'resolve') {
        const resolved = await this.resolve(input)
        return resolved === undefined ? undefined : { kind: 'target', target: resolved }
      }
      if (name === 'switch') {
        const resolved = await this.resolve(input)
        if (resolved === undefined) return undefined
        return await this.switch(resolved) ? { kind: 'target', target: resolved } : undefined
      }
      if (name === 'create') {
        const result = await transport.call<unknown>('workspace.create', { request: { path: input } })
        const created = target(record(result)?.workspace ?? result)
        return created === undefined ? undefined : { kind: 'target', target: created }
      }
      if (name === 'remove') {
        await this.remove(input)
        return { kind: 'choices', title: '已移除工作区', choices: [] }
      }
      throw new Error(`dsh-go: workspace command ${JSON.stringify(name)} is not available`)
    },
  }
}
