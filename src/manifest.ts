/**
 * DSH-GO 的公开静态声明（`BackendManifest` 的第三方投影源）。
 *
 * 与 `dsh-plugin.json` 的 `spec` **逐字一致**（除 `inTree`：它是宿主事实，
 * 第三方声明里写不了，0.19 的 `backendManifestOf()` 固定投影为 `false`）。
 * 装配测试（`test/assembly/`）用一条断言钉住这两处，防止手改漂移。
 *
 * T1 阶段 `src/types/agent/**` 归 T2，尚未落地，所以这里用一个**临时本地结构类型**，
 * 不 import 任何宿主内部面（0.19 的 `exports` 也没有 `./agent/*` 子路径）。
 * T2 vendor `backend-manifest.d.ts` 之后，把下面这段类型换成
 * `import type { BackendManifest } from './types/agent/backend-manifest.js'`
 * 并给 `manifest` 换上该标注即可 —— 字段与本类型一一对应。
 */
interface LocalBackendManifest {
  readonly id: string
  readonly label: { readonly kind: 'literal'; readonly text: string }
  readonly shortLabel: string
  readonly product?: string
  readonly inTree: boolean
  readonly capabilities?: readonly string[]
  readonly grants?: readonly string[]
  readonly unloadExport?: string
}

export const manifest: LocalBackendManifest = {
  id: 'dsh-go',
  label: { kind: 'literal', text: 'DSH-GO' },
  shortLabel: 'DSH-GO',
  product: 'dshd',
  inTree: false,
  capabilities: [
    'native',
    'permissions',
    'questions',
    'pendingRetraction',
    'models',
    'effort',
    'modes',
    'goals',
    'compact',
    'fork',
    'rewind',
    'tasks',
    'subagents',
    'images',
    'transcript',
    'context',
    'mcp',
    'sideQuery',
    'auth',
    'rename',
    'color',
    'init',
  ],
  grants: [],
  unloadExport: 'closeDshGoPool',
}
