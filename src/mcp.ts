import type { McpServerView, SessionCapabilities } from './types/agent/capabilities.js'

/** Additive MCP Transport methods; no local server roster is synthesized. */
export interface DshGoMcpTransport {
  call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T>
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

function invalid(method: string): Error {
  return new Error(`dsh-go: ${method} returned an invalid result`)
}

function nameOf(name: string, method: string): string {
  if (name === '') throw new Error(`dsh-go: ${method} requires a server name`)
  return name
}

function confirmed(method: string, result: unknown): void {
  if (record(result)?.ok !== true) throw invalid(method)
}

export async function listDshGoMcpServers(
  transport: DshGoMcpTransport,
  sessionId: string,
): Promise<readonly McpServerView[]> {
  const result = record(await transport.call<unknown>('mcp.list', { id: sessionId }))
  if (result === undefined || !Array.isArray(result.servers)) throw invalid('mcp.list')
  return result.servers.map(raw => {
    const row = record(raw)
    if (row === undefined || typeof row.name !== 'string' || row.name === ''
      || typeof row.status !== 'string' || row.status === '') throw invalid('mcp.list')
    if (row.toolCount !== undefined
      && (typeof row.toolCount !== 'number' || !Number.isSafeInteger(row.toolCount) || row.toolCount < 0)) {
      throw invalid('mcp.list')
    }
    // The host sets toolCount exactly when a live client exists, and it only
    // reports 'connected' once that client is up: a connected row without a
    // tool count is a server whose tools never got registered, so presenting it
    // as a healthy server would be a silent success. (toolCount = 0 is a real
    // connected roster and stays reportable.)
    if (row.status === 'connected' && row.toolCount === undefined) throw invalid('mcp.list')
    return {
      name: row.name,
      status: row.status,
      ...(row.toolCount === undefined ? {} : { toolCount: row.toolCount as number }),
    }
  })
}

export async function reconnectDshGoMcpServer(
  transport: DshGoMcpTransport,
  sessionId: string,
  name: string,
): Promise<void> {
  const server = nameOf(name, 'mcp.reconnect')
  confirmed('mcp.reconnect', await transport.call<unknown>('mcp.reconnect', { id: sessionId, name: server }))
}

export async function toggleDshGoMcpServer(
  transport: DshGoMcpTransport,
  sessionId: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  const server = nameOf(name, 'mcp.toggle')
  confirmed('mcp.toggle', await transport.call<unknown>('mcp.toggle', { id: sessionId, name: server, enabled }))
}

export function createDshGoMcpCapability(
  transport: DshGoMcpTransport,
  sessionId: string,
): NonNullable<SessionCapabilities['mcp']> {
  return {
    status: () => listDshGoMcpServers(transport, sessionId),
    reconnect: name => reconnectDshGoMcpServer(transport, sessionId, name),
    toggle: (name, enabled) => toggleDshGoMcpServer(transport, sessionId, name, enabled),
  }
}
