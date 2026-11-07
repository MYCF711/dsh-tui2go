/**
 * `dsh-tui2go` 包入口 —— DSH-GO 的第三方 `AgentBackend` bundle。
 *
 * 0.19 的 `loadBackend()` 只从**模块命名空间**里读两样东西：
 *
 *   1. `backend` —— 固定导出名（第三方 bundle 不能用 `backendExport` 改名）；
 *      它的 `id` 必须等于 `dsh-plugin.json` 的 `spec.id`（`dsh-go`），否则
 *      `loadBackend` 抛 `exports a handler for "…"`。
 *   2. `spec.unloadExport` 指向的函数（`closeDshGoPool`）—— 宿主在 composition
 *      dispose 之后调用一次，只关模块级/进程级资源池。
 *
 * T1 阶段这里接的是 `./backend.stub.js`；T4 已把 `src/backend.ts` 落地，入口改到
 * `./backend.js`（导出名与形状不变）。`dshGoPoolCloseCount` 也一起导出，让装配测试
 * （T6 的 `unloadExport-called-exactly-once`）与 T7 不必按 file URL 去读计数。
 */
export {
  backend,
  createDshGoBackend,
  dshGoResumeCommand,
  DSH_GO_BACKEND_ID,
  DSH_GO_BACKEND_LABEL,
  type DshGoBackendOptions,
  type DshGoSupervisor,
} from './backend.js'
export { closeDshGoPool, dshGoPoolCloseCount } from './pool.js'
export { manifest } from './manifest.js'

/** bundle 是 Cordis 插件包；本包不贡献任何插件行，默认导出是空实现。 */
export default function dshTui2GoBundle(): void {}
