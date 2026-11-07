import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createDshGoInitCapability,
  DshGoInitError,
  dshGoInitResult,
  runDshGoInit,
  type DshGoInitResult,
  type DshGoInitTransport,
} from '../../src/init.js'

const TEMPLATE = '# Repository Guidelines\n\n## Project Structure\n\n## Build And Test\n'

test('workspace.init contract fixture really writes once and repeat never overwrites', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-go-init-'))
  t.after(async () => { await rm(cwd, { recursive: true, force: true }) })
  const path = join(cwd, 'AGENTS.md')
  const calls: unknown[] = []
  const transport: DshGoInitTransport = {
    async call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      try {
        await writeFile(path, TEMPLATE, { encoding: 'utf8', flag: 'wx' })
        return { files: [{ path, status: 'created' }] } as T
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        return { files: [{ path, status: 'unchanged' }] } as T
      }
    },
  }

  const reports: DshGoInitResult[] = []
  const capability = createDshGoInitCapability(transport, cwd, { report: result => { reports.push(result) } })
  await capability.run()
  assert.equal(await readFile(path, 'utf8'), TEMPLATE)
  assert.deepEqual(reports[0], {
    ok: true,
    files: [{ path, status: 'created' }],
    created: [path],
    unchanged: [],
    failed: [],
  })

  await writeFile(path, 'user-owned instructions\n', 'utf8')
  const repeated = await runDshGoInit(transport, cwd)
  assert.equal(repeated.ok, true)
  assert.deepEqual(repeated.created, [])
  assert.deepEqual(repeated.unchanged, [path])
  assert.equal(await readFile(path, 'utf8'), 'user-owned instructions\n')
  assert.deepEqual(calls, [
    { method: 'workspace.init', params: { cwd } },
    { method: 'workspace.init', params: { cwd } },
  ])
})

test('init preserves a real partial-failure report and capability rejects with it', async () => {
  const response = {
    files: [
      { path: '/work/AGENTS.md', status: 'created' },
      { path: '/work/docs/AGENTS.md', status: 'failed', error: 'permission denied' },
    ],
  }
  const transport: DshGoInitTransport = { async call<T = unknown>(): Promise<T> { return response as T } }
  const reports: DshGoInitResult[] = []
  const capability = createDshGoInitCapability(transport, '/work', { report: result => { reports.push(result) } })
  await assert.rejects(capability.run(), error => {
    assert.ok(error instanceof DshGoInitError)
    assert.equal(error.result.ok, false)
    assert.match(error.message, /created=1, unchanged=0, failed=1/)
    assert.match(error.message, /\/work\/docs\/AGENTS\.md: permission denied/)
    assert.deepEqual(error.result.created, ['/work/AGENTS.md'])
    assert.deepEqual(error.result.failed, [{ path: '/work/docs/AGENTS.md', status: 'failed', error: 'permission denied' }])
    return true
  })
  assert.equal(reports.length, 1)
  const partial = await runDshGoInit(transport, '/work')
  assert.equal(partial.ok, false)
  assert.deepEqual(reports[0], partial)
  assert.deepEqual(reports[0]?.files, response.files)
})

test('init transport errors propagate unchanged and no file report is invented', async () => {
  const failure = new Error('host crashed before init')
  const transport: DshGoInitTransport = { async call<T = unknown>(): Promise<T> { throw failure } }
  const reports: DshGoInitResult[] = []
  const capability = createDshGoInitCapability(transport, '/work', { report: result => { reports.push(result) } })
  await assert.rejects(capability.run(), error => error === failure)
  assert.deepEqual(reports, [])
  await assert.rejects(runDshGoInit(transport, ' '), /requires a working directory/)
})

test('init rejects malformed or falsely empty success reports', async () => {
  const invalid: unknown[] = [
    undefined,
    {},
    { files: [] },
    { files: [{ status: 'created' }] },
    { files: [{ path: '/work/AGENTS.md', status: 'written' }] },
    { files: [{ path: '/work/AGENTS.md', status: 'failed' }] },
    { files: [{ path: '/work/AGENTS.md', status: 'created', error: 'not really created' }] },
  ]
  for (const response of invalid) {
    assert.throws(() => dshGoInitResult(response), /workspace\.init/)
    const transport: DshGoInitTransport = { async call<T = unknown>(): Promise<T> { return response as T } }
    await assert.rejects(runDshGoInit(transport, '/work'), /workspace\.init/)
  }
})
