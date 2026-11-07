import type { QuestionAnswers, SessionAuthView, SessionCapabilities } from './types/agent/capabilities.js'
import type { AgentEvent, QuestionItemView } from './types/agent/events.js'

/** Existing session.load plus model-catalog credential storage APIs. */
export interface DshGoAuthTransport {
  call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T>
}

export interface DshGoAuthOptions {
  /** The backend's current session model, including a not-yet-run override. */
  model?(): string
  locale?(): 'zh' | 'en'
  /** Required only for interactive API-key login. */
  emit?(events: readonly AgentEvent[]): void
}

export type DshGoAuthCapability = NonNullable<SessionCapabilities['auth']> & {
  /** Clear this model's stored catalog credential; an env credential may remain. */
  logout(): Promise<void>
}

interface CredentialTarget {
  readonly model: string
  readonly apiKeyEnv: string
  readonly configured: boolean
  readonly writable: boolean
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

function parseTarget(value: unknown, model: string): CredentialTarget | undefined {
  const catalog = record(value)
  if (catalog === undefined || !Array.isArray(catalog.models) || record(catalog.credentials) === undefined) {
    throw new Error('dsh-go: models.catalog.list returned an invalid auth projection')
  }
  const row = catalog.models.map(record).find(candidate => candidate?.id === model)
  if (row === undefined) return undefined
  const ref = row.apiKeyEnv
  if (ref === undefined || ref === '') return undefined
  if (typeof ref !== 'string') throw new Error('dsh-go: model credential ref is invalid')
  const status = record(record(catalog.credentials)?.[ref])
  if (status === undefined || typeof status.configured !== 'boolean' || typeof status.writable !== 'boolean') {
    throw new Error(`dsh-go: model ${JSON.stringify(model)} has no reliable credential status`)
  }
  return { model, apiKeyEnv: ref, configured: status.configured, writable: status.writable }
}

/**
 * API-key auth over the host's real model-catalog store. No OAuth provider is
 * claimed: DSH-GO does not consume the TUI host's OAuth credentials.
 */
export function createDshGoAuth(
  transport: DshGoAuthTransport,
  sessionId: string,
  options: DshGoAuthOptions = {},
) {
  const pending = new Map<string, (answers: QuestionAnswers | undefined) => void>()
  let sequence = 0
  let disposed = false
  const zh = (): boolean => options.locale?.() === 'zh'
  const emit = (events: readonly AgentEvent[]): void => { options.emit?.(events) }

  const catalog = async (): Promise<unknown> => transport.call<unknown>('models.catalog.list', {})
  const currentModel = async (): Promise<string> => {
    if (options.model !== undefined) {
      const supplied = options.model()
      if (supplied === '') throw new Error('dsh-go: the live session model is unknown; a stale load model is not an auth target')
      return supplied
    }
    const load = record(await transport.call<unknown>('session.load', { id: sessionId, tailMessages: 1 }))
    if (load === undefined || typeof load.model !== 'string' || load.model === '') {
      throw new Error('dsh-go: the session model is unknown; auth state cannot be inferred from the default model')
    }
    return load.model
  }
  const target = async (): Promise<CredentialTarget | undefined> => parseTarget(await catalog(), await currentModel())
  const requireTarget = async (): Promise<CredentialTarget> => {
    const current = await target()
    if (current === undefined) {
      throw new Error(zh()
        ? 'dsh-go: 当前模型没有可写的目录凭据引用；环境凭据状态不会由 Transport 编造'
        : 'dsh-go: the current model has no writable catalog credential ref; environment auth is not invented')
    }
    if (!current.writable) throw new Error(`dsh-go: credential ${current.apiKeyEnv} is read-only`)
    return current
  }
  const save = async (current: CredentialTarget, credential: string): Promise<CredentialTarget> => {
    const result = await transport.call<unknown>('models.catalog.upsert', {
      model: { id: current.model },
      credential,
    })
    const next = parseTarget(result, current.model)
    if (next === undefined || next.apiKeyEnv !== current.apiKeyEnv) {
      throw new Error('dsh-go: credential write returned no matching auth projection')
    }
    return next
  }
  const settle = (id: string, answers?: QuestionAnswers): boolean => {
    const resolve = pending.get(id)
    if (resolve === undefined) return false
    pending.delete(id)
    emit([{ type: 'question.settled', requestId: id }])
    resolve(answers)
    return true
  }
  const askCredential = (): Promise<string | undefined> => {
    if (disposed || options.emit === undefined) {
      throw new Error('dsh-go: interactive login requires the backend question bridge')
    }
    const requestId = `dsh-go-login:${sessionId}:${++sequence}`
    const question: QuestionItemView = {
      header: 'DSH-GO',
      question: zh() ? '输入当前模型的 API 凭据' : 'Enter the API credential for the current model',
      detail: zh() ? '凭据只写入 DSH-GO 模型目录，不进入会话记录。' : 'The credential is written only to the DSH-GO model catalog, never to the session record.',
      options: [],
      secret: true,
      purpose: 'auth',
    }
    const answer = new Promise<QuestionAnswers | undefined>(resolve => { pending.set(requestId, resolve) })
    emit([{ type: 'question.request', request: { requestId, questions: [question] } }])
    return answer.then(answers => answers?.answers[0]?.custom)
  }

  const capability: DshGoAuthCapability = {
    async status(): Promise<SessionAuthView> {
      const model = await currentModel()
      const current = parseTarget(await catalog(), model)
      if (current === undefined) {
        return { lines: [zh()
          ? `DSH-GO 模型 ${model}：没有目录凭据引用；宿主环境是否已配置凭据未知。`
          : `DSH-GO model ${model}: no catalog credential ref; host-environment auth state is unknown.`] }
      }
      return { lines: [
        zh() ? `DSH-GO 凭据 ${current.apiKeyEnv}：${current.configured ? '已配置' : '未配置'}。`
          : `DSH-GO credential ${current.apiKeyEnv}: ${current.configured ? 'configured' : 'not configured'}.`,
        zh() ? '来源：目录中存储的凭据或同名环境变量；Transport 不区分二者。'
          : 'Source: the stored catalog credential or the same-named environment variable; Transport does not distinguish them.',
      ] }
    },
    async login(_loginOAuth?: () => Promise<boolean>): Promise<void> {
      if (disposed) throw new Error('dsh-go: auth is disposed')
      const current = await requireTarget()
      const credential = await askCredential()
      if (credential === undefined || disposed) return
      if (credential.trim() === '') throw new Error('dsh-go: API credential is empty')
      const next = await save(current, credential)
      if (!next.configured) throw new Error('dsh-go: credential write did not produce a configured credential')
      // DSH-GO resolves catalog credentials for every turn; no cached child
      // credential needs a restart here.
    },
    async reconnect(): Promise<void> {
      if (disposed) throw new Error('dsh-go: auth is disposed')
      // The host resolves the active model provider and credential per request.
    },
    async logout(): Promise<void> {
      if (disposed) throw new Error('dsh-go: auth is disposed')
      const current = await requireTarget()
      if (!current.configured) throw new Error(`dsh-go: credential ${current.apiKeyEnv} is not configured`)
      const next = await save(current, '')
      if (next.configured) {
        throw new Error(zh()
          ? `dsh-go: 已清除目录凭据，但环境变量 ${current.apiKeyEnv} 仍提供凭据；请从环境中移除它`
          : `dsh-go: stored credential cleared, but environment variable ${current.apiKeyEnv} still supplies one; remove it from the environment`)
      }
    },
  }

  return {
    capability,
    /** Route only this helper's secret prompts; native approvals are untouched. */
    respondQuestion: (requestId: string, answers: QuestionAnswers): boolean => settle(requestId, answers),
    cancelQuestion: (requestId: string): boolean => settle(requestId),
    withdrawAll(): void { for (const id of [...pending.keys()]) settle(id) },
    dispose(): void {
      if (disposed) return
      for (const id of [...pending.keys()]) settle(id)
      disposed = true
    },
  }
}
