import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute } from 'node:path'
import test from 'node:test'
import {
  DSH_GO_ATTACHMENT_MAX_BYTES,
  dshGoAttachmentBlock,
  getDshGoAttachment,
  parseDshGoAttachment,
  putDshGoAttachment,
  putDshGoAttachmentBytes,
  type DshGoAttachment,
  type DshGoAttachmentTransport,
} from '../../src/attachments.js'

const ID_A = `att-${'a'.repeat(32)}`
const ID_B = `att-${'b'.repeat(32)}`
const DATA = new Uint8Array([0, 1, 2, 127, 128, 255])

interface Call {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function attachmentFor(data: Uint8Array, overrides: Partial<DshGoAttachment> = {}): DshGoAttachment {
  return {
    id: ID_A,
    name: 'pixel.png',
    byteSize: data.byteLength,
    mime: 'image/png',
    sha256: sha256(data),
    width: 3,
    height: 2,
    ...overrides,
  }
}

function getResult(data = DATA, attachment = attachmentFor(data)): unknown {
  return { attachment, dataBase64: Buffer.from(data).toString('base64') }
}

function transportReturning(result: unknown, calls: Call[]): DshGoAttachmentTransport {
  return {
    async call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      calls.push({ method, params })
      return result as T
    },
  }
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(stat(path), error => (error as { code?: unknown }).code === 'ENOENT')
}

function isAbort(error: unknown): boolean {
  return (error as { name?: unknown })?.name === 'AbortError'
}

test('attachment parser accepts real image and text metadata shapes', () => {
  const image = attachmentFor(DATA)
  assert.deepEqual(parseDshGoAttachment(image), image)
  for (const mime of ['image/jpeg', 'image/gif', 'image/webp'] as const) {
    assert.deepEqual(parseDshGoAttachment({ ...image, mime }), { ...image, mime })
  }
  const text = {
    id: ID_A, name: 'note.txt', byteSize: DATA.byteLength, mime: 'text/plain', sha256: sha256(DATA),
  }
  assert.deepEqual(parseDshGoAttachment(text), text)
  assert.deepEqual(parseDshGoAttachment({ ...text, width: 0, height: 0 }), { ...text, width: 0, height: 0 })
})

test('attachment parser rejects malformed identity, limits, MIME and dimensions', () => {
  const good: Record<string, unknown> = { ...attachmentFor(DATA) }
  const missingWidth = { ...good }
  delete missingWidth.width
  const invalid: unknown[] = [
    null, [], {}, { ...good, id: 'att-short' }, { ...good, id: ID_A.toUpperCase() },
    { ...good, name: '' }, { ...good, byteSize: 0 }, { ...good, byteSize: -1 },
    { ...good, byteSize: 1.5 }, { ...good, byteSize: DSH_GO_ATTACHMENT_MAX_BYTES + 1 },
    { ...good, sha256: '0'.repeat(63) }, { ...good, sha256: 'A'.repeat(64) },
    { ...good, mime: 'image/bmp' }, missingWidth, { ...good, width: 0 },
    { ...good, height: 1.5 }, { ...good, width: '3' },
    { ...good, mime: 'text/plain' }, { ...good, mime: 'text/plain', width: 0, height: 1 },
  ]
  for (const value of invalid) assert.throws(() => parseDshGoAttachment(value), /dsh-go: invalid attachment metadata/)
})

test('attachment.put uses exact path params and returns validated metadata', async () => {
  const calls: Call[] = []
  const response = { attachment: attachmentFor(DATA) }
  const result = await putDshGoAttachment(transportReturning(response, calls), 'C:/explicit/pixel.png')
  assert.deepEqual(result, response.attachment)
  assert.deepEqual(calls, [{ method: 'attachment.put', params: { path: 'C:/explicit/pixel.png' } }])
})

test('byte put stages the exact bytes under an absolute safe basename and cleans up', async () => {
  let stagedPath: string | undefined
  const transport: DshGoAttachmentTransport = {
    async call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      assert.equal(method, 'attachment.put')
      assert.deepEqual(Object.keys(params), ['path'])
      const path = params.path
      if (typeof path !== 'string') throw new Error('path was not staged')
      stagedPath = path
      assert.equal(isAbsolute(path), true)
      assert.equal(dirname(dirname(path)), tmpdir())
      assert.equal(basename(path), 'pixel.png')
      const bytes = await readFile(path)
      assert.deepEqual(new Uint8Array(bytes), DATA)
      if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
      return { attachment: attachmentFor(DATA, { name: basename(path) }) } as T
    },
  }
  const result = await putDshGoAttachmentBytes(transport, { data: DATA, name: '../../pixel.png' })
  assert.equal(result.name, 'pixel.png')
  assert.ok(stagedPath !== undefined)
  await assertMissing(stagedPath)
  await assertMissing(dirname(stagedPath))
})

test('byte put rejects empty/oversize data without RPC and cleans staging after transport failure', async () => {
  let calls = 0
  const unused: DshGoAttachmentTransport = {
    async call<T = unknown>(): Promise<T> {
      calls++
      return { attachment: attachmentFor(DATA) } as T
    },
  }
  await assert.rejects(putDshGoAttachmentBytes(unused, { data: new Uint8Array() }), /empty/)
  await assert.rejects(
    putDshGoAttachmentBytes(unused, { data: new Uint8Array(DSH_GO_ATTACHMENT_MAX_BYTES + 1) }),
    /8 MiB/,
  )
  assert.equal(calls, 0)

  const failure = new Error('put failed')
  let stagedPath: string | undefined
  const broken: DshGoAttachmentTransport = {
    async call<T = unknown>(_method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      if (typeof params.path !== 'string') throw new Error('path was not staged')
      stagedPath = params.path
      throw failure
    },
  }
  await assert.rejects(putDshGoAttachmentBytes(broken, { data: DATA }), error => error === failure)
  assert.ok(stagedPath !== undefined)
  await assertMissing(dirname(stagedPath))
})

test('attachment.get uses exact id params and returns verified fresh Uint8Array bytes', async () => {
  const calls: Call[] = []
  const result = await getDshGoAttachment(transportReturning(getResult(), calls), ID_A)
  assert.deepEqual(result.attachment, attachmentFor(DATA))
  assert.deepEqual(result.data, DATA)
  assert.equal(Buffer.isBuffer(result.data), false)
  assert.deepEqual(calls, [{ method: 'attachment.get', params: { id: ID_A } }])
  await assert.rejects(getDshGoAttachment(transportReturning(getResult(), []), 'att-short'), /invalid attachment id/)
})

test('put/get transport errors propagate unchanged', async () => {
  const failure = new Error('transport failed')
  const transport: DshGoAttachmentTransport = {
    async call<T = unknown>(): Promise<T> {
      throw failure
    },
  }
  await assert.rejects(putDshGoAttachment(transport, 'C:/explicit/pixel.png'), error => error === failure)
  await assert.rejects(getDshGoAttachment(transport, ID_A), error => error === failure)
})

test('malformed put/get success envelopes are rejected', async () => {
  for (const response of [undefined, null, [], {}, { attachment: undefined }]) {
    await assert.rejects(putDshGoAttachment(transportReturning(response, []), 'C:/explicit/pixel.png'))
    await assert.rejects(getDshGoAttachment(transportReturning(response, []), ID_A))
  }
  await assert.rejects(getDshGoAttachment(transportReturning({ attachment: attachmentFor(DATA) }, []), ID_A), /base64/)
})

test('get rejects empty, whitespace, truncated and non-canonical base64', async () => {
  for (const dataBase64 of ['', 'AA AA', 'AAA', 'AB==', '!!!!', '====', 'AA==\n']) {
    await assert.rejects(
      getDshGoAttachment(transportReturning({ attachment: attachmentFor(DATA), dataBase64 }, []), ID_A),
      /base64/,
    )
  }
})

test('get rejects byte size, SHA256 and returned-id mismatches', async () => {
  const size = { attachment: attachmentFor(DATA, { byteSize: DATA.byteLength + 1 }), dataBase64: Buffer.from(DATA).toString('base64') }
  await assert.rejects(getDshGoAttachment(transportReturning(size, []), ID_A), /byteSize/)
  const hash = { attachment: attachmentFor(DATA, { sha256: '0'.repeat(64) }), dataBase64: Buffer.from(DATA).toString('base64') }
  await assert.rejects(getDshGoAttachment(transportReturning(hash, []), ID_A), /sha256/)
  await assert.rejects(getDshGoAttachment(transportReturning(getResult(DATA, attachmentFor(DATA, { id: ID_B })), []), ID_A), /different attachment id/)
})

test('pre-aborted put/get do no RPC work', async () => {
  const controller = new AbortController()
  controller.abort()
  const calls: Call[] = []
  const transport = transportReturning(getResult(), calls)
  await assert.rejects(putDshGoAttachmentBytes(transport, { data: DATA }, controller.signal), isAbort)
  await assert.rejects(getDshGoAttachment(transport, ID_A, controller.signal), isAbort)
  assert.equal(calls.length, 0)
})

test('abort observed after RPC rejects and byte put still removes staging', async () => {
  const getController = new AbortController()
  const getTransport: DshGoAttachmentTransport = {
    async call<T = unknown>(): Promise<T> {
      getController.abort()
      return getResult() as T
    },
  }
  await assert.rejects(getDshGoAttachment(getTransport, ID_A, getController.signal), isAbort)

  const putController = new AbortController()
  let stagedPath: string | undefined
  const putTransport: DshGoAttachmentTransport = {
    async call<T = unknown>(_method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      if (typeof params.path !== 'string') throw new Error('path was not staged')
      stagedPath = params.path
      putController.abort()
      return { attachment: attachmentFor(DATA) } as T
    },
  }
  await assert.rejects(putDshGoAttachmentBytes(putTransport, { data: DATA }, putController.signal), isAbort)
  assert.ok(stagedPath !== undefined)
  await assertMissing(dirname(stagedPath))
})

test('attachment prompt block emits only type and durable attachmentId', () => {
  const attachment = { ...attachmentFor(DATA), name: 'forged.png', path: 'C:/forged', extra: 'drop me' }
  assert.deepEqual(dshGoAttachmentBlock(attachment), { type: 'attachment', attachmentId: ID_A })
  assert.deepEqual(dshGoAttachmentBlock(ID_B), { type: 'attachment', attachmentId: ID_B })
})
