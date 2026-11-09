import { debugLog } from './transport.js'
import { PERMISSION_MODE_IDS, dshGoLocale, permissionModeCopy, type DshGoLocale } from './i18n.js'
import type { ModeOption, SessionCapabilities } from './types/agent/capabilities.js'
import type { AgentEvent } from './types/agent/events.js'

/** Session permission modes are distinct from approval request responses. */
export interface DshGoModesTransport {
  call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T>
}

/**
 * DSH-GO's four session approval policies in Shift+Tab cycle order.
 *
 * The ids stay the host contract (`deny|ask|allow|auto`, see
 * docs/tui-effort-modes-goals-host-note.md): the picker's visible text is
 * localized, the wire value is never translated. `cycle` is deliberately
 * absent: the TUI contract says an absent cycle walks `list()` unchanged;
 * returning a second copy of the same roster made the real 0.19 picker paint
 * every row twice. Keeping the list whole preserves all four modes (including
 * `auto`) and lets Shift+Tab walk them.
 *
 * The text comes from `i18n.ts`, which mirrors the official 0.19
 * `permission-preset-*` keys (workspace-write is "工作区读写 / 写入需先读该文件",
 * not the ad-hoc "工作区内修改" this file used to hardcode) and is rebuilt on
 * every `list()` from the host's live `locale()`, so `/lang` is not a one-shot
 * decision taken at module load.
 */
export function permissionModes(locale: DshGoLocale): readonly ModeOption[] {
  return PERMISSION_MODE_IDS.map(id => {
    const copy = permissionModeCopy(id, locale)
    if (copy === undefined) throw new Error(`dsh-go: no copy for permission mode ${JSON.stringify(id)}`)
    return { id, label: copy.label, description: copy.description }
  })
}

/** Adapt session.load.permission and session.setPermission to modes. */
export function createDshGoModes(
  transport: DshGoModesTransport,
  sessionId: string,
  options: { emit?(events: readonly AgentEvent[]): void; locale?(): string } = {},
) {
  let current = ''
  const list = (): readonly ModeOption[] => permissionModes(dshGoLocale(options.locale))
  const capability: NonNullable<SessionCapabilities['modes']> = {
    list: () => {
      const modes = list()
      debugLog({ event: 'dshgo.modes.list', sessionId, count: modes.length, locale: dshGoLocale(options.locale) })
      return modes
    },
    // No cycle: same array here duplicated every picker row in real 0.19.
    current: () => { debugLog({ event: 'dshgo.modes.current', sessionId, current }); return current },
    async set(id) {
      if (!PERMISSION_MODE_IDS.includes(id as typeof PERMISSION_MODE_IDS[number])) {
        throw new Error(`dsh-go: invalid permission mode ${JSON.stringify(id)}`)
      }
      debugLog({ event: 'dshgo.modes.set', sessionId, id })
      await transport.call('session.setPermission', { id: sessionId, permission: id })
      const load = await transport.call<{ permission?: string }>('session.load', { id: sessionId })
      debugLog({ event: 'dshgo.modes.loadback', sessionId, requested: id, permission: load.permission })
      if (load.permission !== id) throw new Error(`dsh-go: mode readback mismatch: set ${JSON.stringify(id)} but load ${JSON.stringify(load.permission)}`)
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
