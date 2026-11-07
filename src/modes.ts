import type { ModeOption, SessionCapabilities } from './types/agent/capabilities.js'
import type { AgentEvent } from './types/agent/events.js'

/** Session permission modes are distinct from approval request responses. */
export interface DshGoModesTransport {
  call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T>
}

export const DSH_GO_PERMISSION_MODES: readonly ModeOption[] = [
  { id: 'deny', label: 'deny' },
  { id: 'ask', label: 'ask' },
  { id: 'allow', label: 'allow' },
  { id: 'auto', label: 'auto' },
]

/** Adapt session.load.permission and session.setPermission to modes. */
export function createDshGoModes(
  transport: DshGoModesTransport,
  sessionId: string,
  options: { emit?(events: readonly AgentEvent[]): void } = {},
) {
  let current = ''
  const capability: NonNullable<SessionCapabilities['modes']> = {
    list: () => DSH_GO_PERMISSION_MODES,
    cycle: () => DSH_GO_PERMISSION_MODES,
    current: () => current,
    async set(id) {
      if (!DSH_GO_PERMISSION_MODES.some(option => option.id === id)) {
        throw new Error(`dsh-go: invalid permission mode ${JSON.stringify(id)}`)
      }
      await transport.call('session.setPermission', { id: sessionId, permission: id })
      current = id
      options.emit?.([{ type: 'mode.changed', modeId: id }])
    },
  }
  return {
    capability,
    seed(load: { readonly permission?: string }): void {
      current = typeof load.permission === 'string' ? load.permission : ''
    },
  }
}
