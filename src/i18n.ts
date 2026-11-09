/**
 * DSH-GO's own user-visible copy, written in the language the host is showing.
 *
 * The 0.19 backend contract is explicit about this (src/types/agent/backend.d.ts,
 * `locale()`): the host reports the language it is rendering and **plugin text
 * never goes through the host dictionary** ("A backend's own copy is written in
 * it"). So the plugin cannot call the TUI's `t('permission-preset-…')`; what it
 * must do is write its own copy in `locale()`, and read that accessor live so a
 * `/lang` switch applies to the next string it writes.
 *
 * What this module adds on top of "write your own copy" is **wording parity**:
 * every string that the official 0.19 dictionary also has is copied verbatim
 * from it and records the key it came from, so the two UIs can never disagree
 * about what a level is called. Nothing here is presented as an official
 * string: `key` is provenance, `derived` marks the ones the dictionary does not
 * have at all (DSH-GO's own copy).
 *
 * Provenance: `@deepseek-harness-tui/dsh-tui@0.19.0`, `lib/types/i18n.js` —
 * permission presets at lines 713-720 (`permission-preset-*`), effort tiers at
 * lines 198-202 (`effort-tier-*`). Verified against the installed package in
 * PLAY (`node_modules/@deepseek-harness-tui/dsh-tui/lib/types/i18n.js`).
 */

/** The languages the host can report (`BackendLocale`). */
export type DshGoLocale = 'zh' | 'en'

/**
 * Read the host's live locale. Anything that is not exactly `en` is Chinese:
 * the project's default copy is Chinese, and a host that reports nothing (a
 * unit fixture, an older host) must keep the strings the plugin shipped with.
 */
export function dshGoLocale(read?: () => string): DshGoLocale {
  return read?.() === 'en' ? 'en' : 'zh'
}

/**
 * One string in both languages.
 *
 * `key` is the official 0.19 i18n key this text mirrors (provenance, never a
 * claim of official sourcing on its own); `derived` means the official
 * dictionary has no such key and the text is DSH-GO's own.
 */
export interface LocalizedCopy {
  readonly zh: string
  readonly en: string
  readonly key?: string
  readonly derived?: true
}

export type LocalizedPair = { readonly label: LocalizedCopy; readonly description: LocalizedCopy }

const pick = (copy: LocalizedCopy, locale: DshGoLocale): string => locale === 'en' ? copy.en : copy.zh

/** Visible text of one permission-mode option. */
export interface PermissionModeCopy {
  readonly label: string
  readonly description: string
}

/**
 * Session-mode labels/descriptions keyed by DSH-GO's wire id.
 *
 * Each id maps onto the official permission preset it represents, which is why
 * the presets — not the sandbox modes — are the source of truth here:
 * `deny` = read-only, `ask` = workspace-write, `allow` = danger-full-access,
 * `auto` = the experimental auto-review preset. `auto`'s icon-free wording is
 * the official one, including its "this session only" caveat.
 */
/** Ids in Shift+Tab cycle order; index 0 is the unmarked base mode. */
export const PERMISSION_MODE_IDS = ['deny', 'ask', 'allow', 'auto'] as const

export type DshGoPermissionModeId = typeof PERMISSION_MODE_IDS[number]

const PERMISSION_MODES: Readonly<Record<DshGoPermissionModeId, LocalizedPair>> = {
  deny: {
    label: { key: 'permission-preset-readonly', zh: '只读', en: 'Read-only' },
    description: {
      key: 'permission-preset-readonly-desc',
      zh: '会话只读：不写文件、不执行命令',
      en: 'Read-only session: no file writes, no commands',
    },
  },
  ask: {
    label: { key: 'permission-preset-workspace-write', zh: '工作区读写', en: 'Workspace read/write' },
    description: {
      key: 'permission-preset-workspace-write-desc',
      zh: '工作区内读写；写入需先读该文件',
      en: 'Read/write inside the workspace; writes need a prior read',
    },
  },
  allow: {
    label: { key: 'permission-preset-full-access', zh: '完全访问', en: 'Full access' },
    description: {
      key: 'permission-preset-full-access-desc',
      zh: '不受限读写，无需审批',
      en: 'Unrestricted access, no approvals',
    },
  },
  auto: {
    label: { key: 'permission-preset-auto', zh: '自动授权审查', en: 'Auto review' },
    description: {
      key: 'permission-preset-auto-desc',
      zh: '模型在每次工具调用前审查授权；无文件沙箱，仅当前会话',
      en: 'The model reviews every tool call before it runs; no file sandbox, this session only',
    },
  },
}

/** Copy for one permission mode id, in the requested language. */
export function permissionModeCopy(id: string, locale: DshGoLocale): PermissionModeCopy | undefined {
  const pair = (PERMISSION_MODES as Readonly<Record<string, LocalizedPair>>)[id]
  if (pair === undefined) return undefined
  return { label: pick(pair.label, locale), description: pick(pair.description, locale) }
}

/**
 * Effort-tier labels, keyed by the catalog's level id.
 *
 * `off` is the one gap: 0.19 ships `effort-tier-low|medium|high|xhigh|max`
 * (i18n.js:198-202) and has **no** `off` key, so its text is `derived` — and
 * deliberately still says 关闭/Off rather than reusing an unrelated key such as
 * `picker-effort-default` ("默认"), which means "no choice", not "no thinking".
 */
const EFFORT_LABELS: Readonly<Record<string, LocalizedCopy>> = {
  off: { derived: true, zh: '关闭', en: 'Off' },
  low: { key: 'effort-tier-low', zh: '低', en: 'Low' },
  medium: { key: 'effort-tier-medium', zh: '中', en: 'Medium' },
  high: { key: 'effort-tier-high', zh: '高', en: 'High' },
  xhigh: { key: 'effort-tier-xhigh', zh: '超高', en: 'Extra high' },
  max: { key: 'effort-tier-max', zh: '最高', en: 'Max' },
}

/**
 * Label for one effort level. A level the plugin has no copy for stays its raw
 * id — a model may declare tiers this build has never seen, and inventing text
 * for them would be worse than showing what the catalog says.
 */
export function effortLabel(level: string, locale: DshGoLocale): string {
  const copy = EFFORT_LABELS[level]
  return copy === undefined ? level : pick(copy, locale)
}

/**
 * Where one label's text comes from: the official 0.19 i18n key it mirrors, or
 * `derived` when the official dictionary has no such key. Empty object for an
 * id this build has no copy for (the raw id is shown).
 *
 * Exported so the parameter ledger and the unit tests can assert provenance
 * instead of trusting a comment.
 */
export function labelProvenance(kind: 'mode' | 'effort', id: string): { key?: string; derived?: true } {
  const copy = kind === 'mode'
    ? (PERMISSION_MODES as Readonly<Record<string, LocalizedPair>>)[id]?.label
    : EFFORT_LABELS[id]
  if (copy === undefined) return {}
  return copy.key === undefined ? { ...(copy.derived === true ? { derived: true as const } : {}) } : { key: copy.key }
}
