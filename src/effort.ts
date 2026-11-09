import { dshGoLocale, effortLabel } from './i18n.js'
import type { EffortOption, ModelRef, SessionCapabilities } from './types/agent/capabilities.js'
import type { AgentEvent } from './types/agent/events.js'

/** Only the Transport surface needed by effort catalog and mutation calls. */
export interface DshGoEffortTransport {
  call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T>
}

export interface DshGoEffortBaseline {
  readonly model?: string
  /** Last effort actually observed in the durable session projection. */
  readonly effort?: string
  /** Additive host selection override; it wins over the last observed effort. */
  readonly effortSelection?: string
}

type CatalogRow = {
  readonly id: string
  /** Declared level ids in catalog order; labels are resolved at read time. */
  readonly levels: readonly string[]
  /** The row's own declared default tier, already checked against its levels. */
  readonly defaultEffort?: string
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

function catalogRows(value: unknown): ReadonlyMap<string, CatalogRow> {
  const result = record(value)
  if (result === undefined || !Array.isArray(result.models)) {
    throw new Error('dsh-go: models.catalog.list returned an invalid effort catalog')
  }
  const rows = new Map<string, CatalogRow>()
  for (const raw of result.models) {
    const row = record(raw)
    const id = nonEmpty(row?.id)
    if (row === undefined || id === undefined) continue
    const declaration = row.reasoningEfforts
    const levels: string[] = []
    if (declaration !== false && declaration !== undefined) {
      const efforts = record(declaration)
      if (efforts === undefined) throw new Error(`dsh-go: model ${JSON.stringify(id)} has invalid reasoningEfforts`)
      for (const [level, wireValue] of Object.entries(efforts)) {
        if (level === '') throw new Error(`dsh-go: model ${JSON.stringify(id)} has an empty effort id`)
        // null is the catalog's wire spelling for off; other levels require a
        // non-empty wire value. Neither wire value is presented as an effort id.
        if (level === 'off' ? wireValue !== null && nonEmpty(wireValue) === undefined : nonEmpty(wireValue) === undefined) {
          throw new Error(`dsh-go: model ${JSON.stringify(id)} has an invalid effort wire value`)
        }
        levels.push(level)
      }
    }
    // The default tier is the row's own declaration (the sibling codex backend
    // reads the same row field for forModel().defaultEffort). It is data, not a
    // guess: an absent declaration stays undefined, while a declaration that is
    // not a non-empty string or that the row's own ladder does not declare is a
    // broken catalog and must fail loudly here instead of being dropped.
    const declaredDefault = row.defaultReasoningEffort
    let defaultEffort: string | undefined
    if (declaredDefault !== undefined) {
      const value = nonEmpty(declaredDefault)
      if (value === undefined || !levels.includes(value)) {
        throw new Error(`dsh-go: model ${JSON.stringify(id)} has an invalid default effort`)
      }
      defaultEffort = value
    }
    rows.set(id, { id, levels, ...(defaultEffort === undefined ? {} : { defaultEffort }) })
  }
  return rows
}

/**
 * DSH-GO effort data, backed by the persistent model catalog. Construction is
 * inert: call refresh() before offering levels, and seed() from session.load.
 */
export function createDshGoEffort(
  transport: DshGoEffortTransport,
  sessionId: string,
  options: { emit?(events: readonly AgentEvent[]): void; locale?(): string } = {},
) {
  let rows: ReadonlyMap<string, CatalogRow> = new Map()
  let available = false
  let model = ''
  let effort: string | undefined

  const rowFor = (ref: ModelRef): CatalogRow | undefined => rows.get(ref.model)
  // Labels are resolved per read, not per refresh: the host's `locale()` is
  // live, so a `/lang` switch relabels the ladder on the next render instead of
  // waiting for the next catalog refresh (which may never come).
  const levelsFor = (ref: ModelRef): readonly EffortOption[] => {
    const locale = dshGoLocale(options.locale)
    return (rowFor(ref)?.levels ?? []).map(id => ({ id, label: effortLabel(id, locale) }))
  }
  const capability: NonNullable<SessionCapabilities['effort']> = {
    get levelsAvailable() { return available },
    levels: () => levelsFor({ model }),
    forModel: ref => ({ levels: levelsFor(ref), defaultEffort: rowFor(ref)?.defaultEffort }),
    current: () => effort,
    async set(id) {
      if (id !== null) {
        if (!available) throw new Error('dsh-go: effort catalog is not loaded')
        if (!levelsFor({ model }).some(option => option.id === id)) {
          throw new Error(`dsh-go: invalid effort ${JSON.stringify(id)} for model ${JSON.stringify(model)}`)
        }
      }
      // Empty string is the host's explicit "clear selection" spelling. Do
      // not update local state or emit until the persistent write succeeds.
      await transport.call('session.setEffort', { id: sessionId, effort: id ?? '' })
      effort = id ?? undefined
      options.emit?.([{ type: 'effort.changed', effort: id }])
    },
  }

  return {
    capability,
    async refresh(): Promise<void> {
      const next = catalogRows(await transport.call<unknown>('models.catalog.list', {}))
      rows = next
      available = true
    },
    seed(load: DshGoEffortBaseline): void {
      model = typeof load.model === 'string' ? load.model : ''
      effort = nonEmpty(load.effortSelection) ?? nonEmpty(load.effort)
    },
    noteModel(next: string): void { model = next },
  }
}
