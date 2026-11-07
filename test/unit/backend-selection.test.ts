/**
 * T4 · backend-selection —— 本包在 **0.19 真实注册表**里"选得中、载得回、钩得住"。
 *
 * 这一条不是本仓自己的复制品：它 import 的是 0.19 官方包里**真的** `registerBackend`
 * / `parseBackendChoice` / `loadBackend` / `listOfferedBackends` / `unloadBackends`
 * （只读参考，绝不修改），以及 spec 平面的 `validateBackendSpec` /
 * `BACKEND_CAPABILITY_NAMES` 与 `backendManifestOf`。本仓只提供**被装配的那一半**：
 * `dsh-plugin.json` 的 spec、`src/index.ts` 的固定导出名 `backend`、以及
 * `spec.unloadExport` 指的池钩子。
 *
 * 参考副本 `C:/…/tui-019-run/package` 解自官方 tarball 但**不带 `node_modules`**，
 * 直接 import 会 `ERR_MODULE_NOT_FOUND`（emoji-regex 等 bare 依赖）；所以这里用
 * T6 从**同一个 tarball** 真装出来的那份（`$TUI2GO_T6_ENV`，同样逐字节同一实现）。
 * 本文件在 import 任何 0.19 模块之前先把 `HOME`/`DSH_*` 指到一次性 scratch：
 * 0.19 的 data dir 是 **import 时**解析的。
 *
 * 另外把 T2 交给 T4 的**运行时值成员**一起钉在这里（纯 `.d.ts` 不产 `.js`，
 * 从 `./types/agent/*` import 值会 typecheck 通过然后运行时炸）：
 * `refs` 的 4 个、`backend-manifest` 的 2 个、`events.NO_EVENTS`、
 * `presentation.isSuppressedPresentation`。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isBackendIdSyntax, BACKEND_ID_PATTERN } from '../../src/backend-manifest.js'
import { NO_EVENTS } from '../../src/events.js'
import { manifest } from '../../src/manifest.js'
import { isSuppressedPresentation } from '../../src/presentation.js'
import { DEFAULT_BACKEND_ID, formatSessionRef, parseSessionRef, sameSessionRef } from '../../src/refs.js'
import { dshGoPoolCloseCount } from '../../src/pool.js'

// ── 1. 先改 home，再 import 0.19（0.19 在模块求值期解析 data dir） ────────────

const packageRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scratch = process.env.TUI2GO_T4_SCRATCH ?? join(tmpdir(), 'TUI2GO', 'T4', 'scratch')
const scratchHome = join(scratch, 'home')
const scratchDirs = {
  HOME: scratchHome,
  USERPROFILE: scratchHome,
  DSH_HOME: join(scratch, 'dsh-home'),
  DSH_TUI_HOME: join(scratch, 'dsh-tui-home'),
  DSH_TUI_SESSION_ROOT: join(scratch, 'sessions'),
}
for (const value of Object.values(scratchDirs)) mkdirSync(value, { recursive: true })
for (const [key, value] of Object.entries(scratchDirs)) process.env[key] = value

// ── 2. 找一份**能 import** 的 0.19（同一 tarball 的真装副本） ────────────────

const T6_ENV = process.env.TUI2GO_T6_ENV ?? join(tmpdir(), 'TUI2GO', 'T6', 'env')
const installed019 = join(T6_ENV, 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
const reference019 = process.env.TUI2GO_TUI019_ROOT ?? join(tmpdir(), 'tui-019-run', 'package')
const candidates = [process.env.TUI2GO_T4_TUI019, installed019].filter((value): value is string => typeof value === 'string' && value !== '')

interface Tui019 {
  readonly root: string
  readonly version: string
  readonly registerBackend: (entry: unknown) => void
  readonly listBackends: () => readonly { id: string; manifest: Record<string, unknown>; admission: { decision: string }; load?: unknown }[]
  readonly listOfferedBackends: () => readonly { id: string }[]
  readonly getBackend: (id: string) => { id: string; admission: { decision: string } } | undefined
  readonly loadBackend: (id: string) => Promise<{ id: string; descriptor: { label: string } }>
  readonly unloadBackends: () => Promise<void>
  readonly parseBackendChoice: (value: unknown) => string | undefined
  readonly backendManifestOf: (spec: unknown) => Record<string, unknown>
  readonly validateBackendSpec: (spec: unknown) => unknown
  readonly capabilityNames: readonly string[]
}

async function load019(): Promise<Tui019> {
  const failures: string[] = []
  for (const root of candidates) {
    if (!(await exists(join(root, 'package.json')))) {
      failures.push(`${root}: no package.json`)
      continue
    }
    try {
      const load = async (relative: string) => import(pathToFileURL(join(root, relative)).href)
      const [registry, contribution, spec, capabilities] = await Promise.all([
        load('lib/types/dsh-adapter/backend-registry.js'),
        load('lib/types/dsh-adapter/backend-contribution.js'),
        load('lib/types/adapter/spec/tui-contributions.js'),
        load('lib/types/adapter/spec/backend-capabilities.js'),
      ])
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string }
      assert.equal(pkg.name, '@deepseek-harness-tui/dsh-tui', `${root} is not the official TUI package`)
      return {
        root,
        version: pkg.version ?? '',
        registerBackend: registry.registerBackend,
        listBackends: registry.listBackends,
        listOfferedBackends: registry.listOfferedBackends,
        getBackend: registry.getBackend,
        loadBackend: registry.loadBackend,
        unloadBackends: registry.unloadBackends,
        parseBackendChoice: registry.parseBackendChoice,
        backendManifestOf: contribution.backendManifestOf,
        validateBackendSpec: spec.validateBackendSpec,
        capabilityNames: capabilities.BACKEND_CAPABILITY_NAMES,
      }
    } catch (error) {
      failures.push(`${root}: ${error instanceof Error ? `${error.code ?? ''} ${error.message}`.trim() : String(error)}`)
    }
  }
  throw new Error(
    `backend-selection: no importable 0.19 registry. Tried:\n  ${failures.join('\n  ')}\n`
    + `The read-only reference copy (${reference019}) unpacks from the official tarball without node_modules, so it is `
    + 'expected to fail with ERR_MODULE_NOT_FOUND — point TUI2GO_T4_TUI019 or TUI2GO_T6_ENV at a real install.',
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await import('node:fs/promises').then(fs => fs.access(path))
    return true
  } catch {
    return false
  }
}

const tui = await load019()

// ── 3. 本包的声明（`dsh-plugin.json` 的 spec + `src/manifest.ts`） ──────────

const declaration = JSON.parse(readFileSync(join(packageRoot, 'dsh-plugin.json'), 'utf8')) as {
  contributes: Record<string, { spec: Record<string, unknown> }[]>
}
const spec = declaration.contributes['x-dsh-tui']![0]!.spec
const projected = tui.backendManifestOf(spec)

test('the declaration passes the 0.19 family validator and projects to an out-of-tree manifest', () => {
  assert.equal(tui.version, '0.19.0', `expected the 0.19 registry, got ${tui.version} at ${tui.root}`)
  assert.doesNotThrow(() => tui.validateBackendSpec(spec), 'validateBackendSpec must accept our spec (D-3)')
  // D-4: `inTree` is the host's projection fact, never a plugin's claim.
  assert.equal(projected.inTree, false)
  assert.equal(projected.id, 'dsh-go')
  assert.deepEqual(projected.label, { kind: 'literal', text: 'DSH-GO' })
  assert.equal(projected.shortLabel, 'DSH-GO')
  assert.equal(projected.product, 'dshd')
  assert.equal(projected.alwaysAvailable, undefined, 'a plugin may not be always-available')
  assert.equal(projected.nativeKey, undefined, 'a plugin may not declare a native channel')
  assert.equal(projected.unloadExport, 'closeDshGoPool')
  assert.deepEqual(projected.grants, [])
})

test('D-1: dsh-plugin.json and src/manifest.ts state the same facts (modulo inTree)', () => {
  const facts = projected as { capabilities: string[]; grants: string[] }
  assert.equal(manifest.id, projected.id)
  assert.deepEqual(manifest.label, projected.label)
  assert.equal(manifest.shortLabel, projected.shortLabel)
  assert.equal(manifest.product, projected.product)
  assert.equal(manifest.inTree, false)
  assert.deepEqual([...manifest.capabilities!], [...facts.capabilities])
  assert.deepEqual([...manifest.grants!], [...facts.grants])
  assert.equal(manifest.unloadExport, projected.unloadExport)
  // 声明的能力名必须全部落在 0.19 的 27 个已知名里（否则注册会被判 rejected）。
  assert.equal(tui.capabilityNames.length, 27)
  assert.deepEqual([...facts.capabilities].filter(name => !tui.capabilityNames.includes(name)), [])
})

test('isBackendIdSyntax / BACKEND_ID_PATTERN come from this package runtime, not from a .d.ts', () => {
  assert.ok(BACKEND_ID_PATTERN instanceof RegExp)
  assert.equal(BACKEND_ID_PATTERN.source, '^[a-z0-9][a-z0-9-]{0,31}$')
  assert.equal(isBackendIdSyntax('dsh-go'), true)
  assert.equal(isBackendIdSyntax('DSH-GO'), false, 'ids are lowercase only')
  assert.equal(isBackendIdSyntax('a'.repeat(33)), false, 'at most 32 characters')
  assert.equal(isBackendIdSyntax(''), false)
  assert.equal(isBackendIdSyntax(undefined), false)
  assert.equal(isBackendIdSyntax(manifest.id), true)
})

test('refs / NO_EVENTS / isSuppressedPresentation are real runtime values here', () => {
  assert.equal(DEFAULT_BACKEND_ID, 'dsh')
  assert.equal(formatSessionRef({ backendId: 'dsh-go', sessionId: 'A' }), 'dsh-go:A')
  assert.equal(formatSessionRef({ backendId: 'dsh', sessionId: 'A' }), 'A', 'DSH refs serialize without a prefix')
  assert.deepEqual(parseSessionRef('dsh-go:A', ['dsh-go', 'dsh']), { backendId: 'dsh-go', sessionId: 'A' })
  assert.deepEqual(parseSessionRef('A', ['dsh-go']), { backendId: 'dsh', sessionId: 'A' })
  assert.equal(sameSessionRef({ backendId: 'dsh-go', sessionId: 'A' }, { backendId: 'dsh-go', sessionId: 'A' }), true)
  assert.equal(sameSessionRef({ backendId: 'dsh-go', sessionId: 'A' }, { backendId: 'dsh', sessionId: 'A' }), false)

  assert.equal(NO_EVENTS.length, 0)
  assert.equal(Object.isFrozen(NO_EVENTS), true, 'NO_EVENTS is the frozen shared empty translation result')

  assert.equal(isSuppressedPresentation({ card: 'question' }), true)
  assert.equal(isSuppressedPresentation({ card: 'subagent' }), true)
  assert.equal(isSuppressedPresentation({ card: 'todo' }), true)
  assert.equal(isSuppressedPresentation({ card: 'generic', title: 'bash' }), false)
  assert.equal(isSuppressedPresentation(undefined), false)
})

test('registration makes the bundle selectable, loadable and unloadable exactly once', async () => {
  // 注册之前 `dsh-go` 不是任何人的选择项（0.19 只 seed dsh/claude/codex）。
  assert.equal(tui.parseBackendChoice('dsh-go'), undefined)
  assert.equal(tui.listBackends().some(entry => entry.id === 'dsh-go'), false)

  // D-5：真实的 `registerBackend` 不抛 reserved / duplicate / label / alwaysAvailable / nativeKey。
  tui.registerBackend({ manifest: projected, load: async () => import('../../src/index.js') })
  assert.throws(
    () => tui.registerBackend({ manifest: projected, load: async () => import('../../src/index.js') }),
    /already registered/u,
  )

  // D-6：可被挑中，而且不是 `waiting_authorization`。
  const offered = tui.listOfferedBackends().filter(entry => entry.id === 'dsh-go')
  assert.equal(offered.length, 1)
  assert.notEqual(tui.getBackend('dsh-go')?.admission.decision, 'waiting_authorization')
  assert.equal(tui.listBackends().filter(entry => entry.id === 'dsh-go').length, 1)

  // 选择解析：id 大小写不敏感（`/kernel` 的输入是人手打的）。
  assert.equal(tui.parseBackendChoice('dsh-go'), 'dsh-go')
  assert.equal(tui.parseBackendChoice('DSH-GO'), 'dsh-go')
  assert.equal(tui.parseBackendChoice('  dsh-go  '), 'dsh-go')
  assert.equal(tui.parseBackendChoice('nope'), undefined)
  assert.equal(tui.parseBackendChoice(42), undefined)

  // D-7：加载回来的 handler 必须是本包的固定导出，且 id 与 spec 逐字一致。
  const handler = await tui.loadBackend('dsh-go')
  assert.equal(handler.id, 'dsh-go')
  assert.equal(handler.descriptor.label, 'DSH-GO')

  // D-9：`spec.unloadExport` 恰好被调一次；第二次 `unloadBackends()` 是 no-op。
  const before = dshGoPoolCloseCount()
  await tui.unloadBackends()
  assert.equal(dshGoPoolCloseCount(), before + 1)
  await tui.unloadBackends()
  assert.equal(dshGoPoolCloseCount(), before + 1)
})
