import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent, QuestionRequestView } from '../../src/types/agent/events.js'
import { createDshGoAuth, type DshGoAuthTransport } from '../../src/auth.js'

interface Call { readonly method: string; readonly params: Readonly<Record<string, unknown>> }

function fixture(handler: (method: string, params: Readonly<Record<string, unknown>>) => unknown) {
  const calls: Call[] = []
  const transport: DshGoAuthTransport = {
    async call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      return handler(method, params) as T
    },
  }
  return { calls, transport }
}

const catalog = (configured: boolean, writable = true) => ({
  models: [{ id: 'model-a', apiKeyEnv: 'MODEL_A_KEY' }],
  credentials: { MODEL_A_KEY: { configured, writable } },
})

test('auth status reports a real unconfigured catalog credential', async () => {
  const { calls, transport } = fixture(() => catalog(false))
  const helper = createDshGoAuth(transport, 'session-a', { model: () => 'model-a' })
  const view = await helper.capability.status()
  assert.match(view.lines[0]!, /MODEL_A_KEY: not configured/)
  assert.match(view.lines[1]!, /does not distinguish/)
  assert.deepEqual(calls, [{ method: 'models.catalog.list', params: {} }])
})

test('auth reads the session model when no live override is supplied and never guesses legacy env state', async () => {
  const { calls, transport } = fixture(method => method === 'session.load'
    ? { model: 'legacy-model' }
    : { models: [{ id: 'legacy-model' }], credentials: {} })
  const helper = createDshGoAuth(transport, 'session-a')
  const view = await helper.capability.status()
  assert.match(view.lines[0]!, /host-environment auth state is unknown/)
  assert.deepEqual(calls.map(call => call.method), ['session.load', 'models.catalog.list'])
})

test('an explicitly unknown live model never falls back to a stale load model', async () => {
  const { calls, transport } = fixture(() => { throw new Error('unexpected transport call') })
  const helper = createDshGoAuth(transport, 'session-a', { model: () => '' })
  await assert.rejects(helper.capability.status(), /a stale load model is not an auth target/)
  assert.deepEqual(calls, [])
})

test('login uses a secret question and the existing model-catalog credential write', async () => {
  const events: AgentEvent[] = []
  let helper: ReturnType<typeof createDshGoAuth>
  const { calls, transport } = fixture(method => method === 'models.catalog.upsert' ? catalog(true) : catalog(false))
  helper = createDshGoAuth(transport, 'session-a', {
    model: () => 'model-a',
    emit: batch => {
      events.push(...batch)
      const request = batch.find((event): event is Extract<AgentEvent, { type: 'question.request' }> => event.type === 'question.request')
      if (request !== undefined) queueMicrotask(() => {
        helper.respondQuestion(request.request.requestId, { answers: [{ selected: [], custom: 'new-secret' }] })
      })
    },
  })
  await helper.capability.login!()
  await helper.capability.reconnect()
  assert.deepEqual(calls, [
    { method: 'models.catalog.list', params: {} },
    { method: 'models.catalog.upsert', params: { model: { id: 'model-a' }, credential: 'new-secret' } },
  ])
  const request = events.find(event => event.type === 'question.request')
  assert.equal(request?.type, 'question.request')
  const question = (request?.request as QuestionRequestView).questions[0]!
  assert.equal(question.secret, true)
  assert.equal(question.purpose, 'auth')
  assert.equal(events.some(event => event.type === 'question.settled'), true)
  assert.equal(JSON.stringify(events).includes('new-secret'), false)
})

test('cancelled login settles the prompt without a credential write', async () => {
  let helper: ReturnType<typeof createDshGoAuth>
  const { calls, transport } = fixture(() => catalog(false))
  helper = createDshGoAuth(transport, 'session-a', {
    model: () => 'model-a',
    emit: batch => {
      const request = batch.find(event => event.type === 'question.request')
      if (request?.type === 'question.request') queueMicrotask(() => { helper.cancelQuestion(request.request.requestId) })
    },
  })
  await helper.capability.login!()
  assert.deepEqual(calls, [{ method: 'models.catalog.list', params: {} }])
})

test('logout clears the stored credential and refuses to claim success while env auth remains', async () => {
  const { calls, transport } = fixture(method => method === 'models.catalog.upsert' ? catalog(false) : catalog(true))
  const helper = createDshGoAuth(transport, 'session-a', { model: () => 'model-a' })
  await helper.capability.logout()
  assert.deepEqual(calls[1], { method: 'models.catalog.upsert', params: { model: { id: 'model-a' }, credential: '' } })

  const environment = fixture(method => method === 'models.catalog.upsert' ? catalog(true) : catalog(true))
  const remaining = createDshGoAuth(environment.transport, 'session-a', { model: () => 'model-a' })
  await assert.rejects(remaining.capability.logout(), /environment variable MODEL_A_KEY still supplies one/)
})

test('logout while unconfigured and writes to read-only credentials fail before mutation', async () => {
  const unconfigured = fixture(() => catalog(false))
  await assert.rejects(createDshGoAuth(unconfigured.transport, 'session-a', { model: () => 'model-a' }).capability.logout(), /is not configured/)
  assert.equal(unconfigured.calls.some(call => call.method === 'models.catalog.upsert'), false)

  const readOnly = fixture(() => catalog(true, false))
  await assert.rejects(createDshGoAuth(readOnly.transport, 'session-a', { model: () => 'model-a' }).capability.logout(), /is read-only/)
  assert.equal(readOnly.calls.some(call => call.method === 'models.catalog.upsert'), false)
})

test('auth storage errors propagate and dispose cancels an in-flight secret prompt', async () => {
  const failure = new Error('credential store failed')
  const failing = fixture(method => {
    if (method === 'models.catalog.upsert') throw failure
    return catalog(false)
  })
  const helper = createDshGoAuth(failing.transport, 'session-a', {
    model: () => 'model-a',
    emit: batch => {
      const request = batch.find(event => event.type === 'question.request')
      if (request?.type === 'question.request') queueMicrotask(() => {
        helper.respondQuestion(request.request.requestId, { answers: [{ selected: [], custom: 'secret' }] })
      })
    },
  })
  await assert.rejects(helper.capability.login!(), error => error === failure)

  let pending: ReturnType<typeof createDshGoAuth>
  const waiting = fixture(() => catalog(false))
  pending = createDshGoAuth(waiting.transport, 'session-a', {
    model: () => 'model-a',
    emit: batch => {
      if (batch.some(event => event.type === 'question.request')) queueMicrotask(() => { pending.dispose() })
    },
  })
  await pending.capability.login!()
  assert.deepEqual(waiting.calls.map(call => call.method), ['models.catalog.list'])
  assert.equal(pending.respondQuestion('unknown', { answers: [] }), false)
})
