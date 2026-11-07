/**
 * `dsh-plugin.json` 的 `spec.unloadExport` 指向这里（`closeDshGoPool`）。
 *
 * 语义边界（0.19 `BackendManifest.unloadExport` 的注释）：只关**模块级 / 进程级**
 * 资源池；会话级资源（子进程、transcript 句柄）归 `session.dispose()`。
 * 注册表只记住"真的被 import 过"的条目的这个钩子，所以"没 import"也意味着"不会调"。
 *
 * T1 阶段还没有池可关；计数器只用于让装配测试从 Loader 的**同一个模块实例**上
 * 观察到"恰好被调一次"（T6 的 `unloadExport-called-exactly-once`）。
 */
let closes = 0

/** 只关模块级/进程级资源池；会话级资源归 `session.dispose()`。 */
export async function closeDshGoPool(): Promise<void> {
  closes += 1
}

/** 只读计数，供装配测试观察 `closeDshGoPool` 的调用次数。 */
export function dshGoPoolCloseCount(): number {
  return closes
}
