import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import test from 'node:test'
import {
  DSH_GO_IMAGE_LIMITS,
  createDshGoImages,
  decodeDshGoImageDataUrl,
  dshGoImageContent,
  dshGoImageTranscript,
  getDshGoImage,
  putDshGoImage,
  putDshGoImageDataUrl,
  validateDshGoImage,
} from '../../src/images.js'
import {
  parseDshGoAttachment,
  type DshGoAttachment,
  type DshGoAttachmentTransport,
} from '../../src/attachments.js'
import { createDshGoPlacement } from '../../src/placement.js'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII='
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'))
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`
const ID_A = `att-${'a'.repeat(32)}`
const ID_B = `att-${'b'.repeat(32)}`
const ID_C = `att-${'c'.repeat(32)}`
const ID_UNKNOWN = `att-${'d'.repeat(32)}`

interface Call {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

type PromptBlock = {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

function promptBlocks(blocks: readonly PromptBlock[]): readonly PromptBlock[] {
  return blocks
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function homeId(prefix: string, sequence: number): string {
  return `att-${prefix}${sequence.toString(16).padStart(31, '0')}`
}

function pngWithSize(width: number, height: number): Uint8Array {
  const data = PNG_BYTES.slice()
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return data
}

function dataUrl(data: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(data).toString('base64')}`
}

function attachmentFor(data: Uint8Array, id = ID_A, name = 'pixel.png'): DshGoAttachment {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return parseDshGoAttachment({
    id,
    name,
    byteSize: data.byteLength,
    mime: 'image/png',
    sha256: sha256(data),
    width: view.getUint32(16),
    height: view.getUint32(20),
  })
}

function transcriptBlock(attachment: DshGoAttachment): PromptBlock {
  return {
    type: 'attachment',
    attachmentId: attachment.id,
    name: attachment.name,
    byteSize: attachment.byteSize,
    mime: attachment.mime,
    sha256: attachment.sha256,
    width: attachment.width,
    height: attachment.height,
  }
}

function imageFacade(data: Uint8Array, options: {
  readonly name?: string
  readonly mediaType?: string
  readonly bytes?: number
  readonly width?: number
  readonly height?: number
  readonly path?: string
  readonly onRead?: (signal?: AbortSignal) => void
} = {}) {
  return {
    id: 'local-image',
    name: options.name ?? 'pixel.png',
    mediaType: options.mediaType ?? 'image/png',
    bytes: options.bytes ?? data.byteLength,
    width: options.width ?? 1,
    height: options.height ?? 1,
    ...(options.path === undefined ? {} : { path: options.path }),
    async read(signal?: AbortSignal): Promise<Uint8Array> {
      options.onRead?.(signal)
      return data
    },
  }
}

class FakeHome {
  readonly calls: Call[] = []
  onGet?: (id: string) => void
  private sequence = 0
  private readonly stored = new Map<string, { attachment: DshGoAttachment; data: Uint8Array }>()

  constructor(private readonly prefix: string) {}

  readonly transport: DshGoAttachmentTransport = {
    call: <T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> =>
      this.invoke<T>(method, params),
  }

  get putCount(): number {
    return this.calls.filter(call => call.method === 'attachment.put').length
  }

  get getCount(): number {
    return this.calls.filter(call => call.method === 'attachment.get').length
  }

  private async invoke<T>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
    this.calls.push({ method, params })
    if (method === 'attachment.put') {
      const path = params.path
      if (typeof path !== 'string') throw new Error('fake home: attachment.put path is missing')
      const data = new Uint8Array(await readFile(path))
      const id = homeId(this.prefix, ++this.sequence)
      const attachment = attachmentFor(data, id, basename(path))
      this.stored.set(id, { attachment, data })
      return { attachment } as T
    }
    if (method === 'attachment.get') {
      const id = params.id
      if (typeof id !== 'string') throw new Error('fake home: attachment.get id is missing')
      this.onGet?.(id)
      const stored = this.stored.get(id)
      if (stored === undefined) throw new Error(`not_found: ${id}`)
      return {
        attachment: stored.attachment,
        dataBase64: Buffer.from(stored.data).toString('base64'),
      } as T
    }
    throw new Error(`fake home: unexpected method ${method}`)
  }
}

function isAbort(error: unknown): boolean {
  return (error as { name?: unknown })?.name === 'AbortError'
}

test('image limits expose the native attachment, count, byte and pixel budgets', () => {
  assert.deepEqual(DSH_GO_IMAGE_LIMITS, {
    mediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    maxImageBytes: 8 * 1024 * 1024,
    maxImagesPerMessage: 64,
    maxMessageImageBytes: 64 * 8 * 1024 * 1024,
    maxImageDimension: 64 * 1024 * 1024,
    maxImagePixels: 64 * 1024 * 1024,
  })
  assert.equal(Object.isFrozen(DSH_GO_IMAGE_LIMITS), true)
  assert.equal(Object.isFrozen(DSH_GO_IMAGE_LIMITS.mediaTypes), true)
})

test('canonical data URL decoding and put/get round-trip preserve the real PNG bytes', async () => {
  const decoded = decodeDshGoImageDataUrl(PNG_DATA_URL)
  assert.deepEqual(decoded.data, PNG_BYTES)
  assert.equal(decoded.mediaType, 'image/png')
  assert.equal(decoded.width, 1)
  assert.equal(decoded.height, 1)

  const home = new FakeHome('a')
  const stored = await putDshGoImageDataUrl(home.transport, PNG_DATA_URL, { name: 'pixel.png' })
  assert.deepEqual(stored, attachmentFor(PNG_BYTES, homeId('a', 1)))
  assert.deepEqual(home.calls.map(call => call.method), ['attachment.put'])
  assert.deepEqual(Object.keys(home.calls[0]!.params), ['path'])

  const facade = getDshGoImage(home.transport, stored)
  assert.deepEqual(await facade.read(), PNG_BYTES)
  assert.deepEqual(home.calls.at(-1), { method: 'attachment.get', params: { id: stored.id } })

  const local = imageFacade(PNG_BYTES, { bytes: 1, path: 'C:/private/local.png' })
  const second = await putDshGoImage(home.transport, local)
  assert.equal(second.id, homeId('a', 2))
  assert.equal(second.byteSize, PNG_BYTES.byteLength)
  assert.equal(second.sha256, sha256(PNG_BYTES))
})

test('remote, path, SVG, malformed base64 and empty payloads are explicitly refused without put', async () => {
  const home = new FakeHome('a')
  const rejected = [
    'https://example.invalid/pixel.png',
    'C:/private/pixel.png',
    `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`,
    'data:image/png;base64,AB==',
    `data:image/png;base64,${PNG_BASE64.slice(0, -1)}`,
    'data:image/png;base64,!!!!',
  ]
  for (const value of rejected) {
    assert.throws(() => decodeDshGoImageDataUrl(value), /dsh-go:/)
    await assert.rejects(putDshGoImageDataUrl(home.transport, value), /dsh-go:/)
  }
  assert.throws(() => decodeDshGoImageDataUrl('data:image/png;base64,'), /payload is empty/)
  await assert.rejects(putDshGoImageDataUrl(home.transport, 'data:image/png;base64,'), /payload is empty/)
  assert.equal(home.putCount, 0)
})

test('per-image size and media type checks use actual bytes rather than facade claims', async () => {
  const home = new FakeHome('a')
  const limits = { ...DSH_GO_IMAGE_LIMITS, maxImageBytes: PNG_BYTES.byteLength - 1 }
  await assert.rejects(
    putDshGoImage(home.transport, imageFacade(PNG_BYTES, { bytes: 1 }), { limits }),
    /per-image limit/,
  )
  await assert.rejects(
    putDshGoImage(home.transport, imageFacade(PNG_BYTES, { mediaType: 'image/jpeg' })),
    /contradicts its image\/png bytes/,
  )
  assert.throws(() => validateDshGoImage(PNG_BYTES, 'image/bmp'), /unsupported image media type/)
  assert.throws(
    () => validateDshGoImage(PNG_BYTES, 'image/png', { ...DSH_GO_IMAGE_LIMITS, mediaTypes: ['image/jpeg'] }),
    /unsupported image media type/,
  )
  assert.throws(() => validateDshGoImage(new Uint8Array([1, 2, 3]), 'image/png'), /no supported image signature/)
  assert.equal(home.putCount, 0)
})

test('pixel and per-side dimension limits are measured from encoded bytes', async () => {
  const home = new FakeHome('a')
  const wide = pngWithSize(2, 1)
  await assert.rejects(
    putDshGoImage(home.transport, imageFacade(wide, { width: 1, height: 1 }), {
      limits: { ...DSH_GO_IMAGE_LIMITS, maxImageDimension: 1 },
    }),
    /pixel\/dimension limit/,
  )
  assert.throws(
    () => decodeDshGoImageDataUrl(dataUrl(pngWithSize(2, 2)), { ...DSH_GO_IMAGE_LIMITS, maxImagePixels: 3 }),
    /pixel\/dimension limit/,
  )
  const boundary = decodeDshGoImageDataUrl(dataUrl(pngWithSize(2, 2)), {
    ...DSH_GO_IMAGE_LIMITS,
    maxImageDimension: 2,
    maxImagePixels: 4,
  })
  assert.equal(boundary.width, 2)
  assert.equal(boundary.height, 2)
  assert.equal(home.putCount, 0)
})

test('image count and aggregate message bytes fail the whole batch before any put', async () => {
  const home = new FakeHome('a')
  await assert.rejects(dshGoImageContent(home.transport, {
    text: '',
    images: [imageFacade(PNG_BYTES), imageFacade(PNG_BYTES)],
  }, {
    limits: { ...DSH_GO_IMAGE_LIMITS, maxImagesPerMessage: 1 },
  }), /too many images/)
  assert.equal(home.putCount, 0)

  await assert.rejects(dshGoImageContent(home.transport, {
    text: '',
    images: [imageFacade(PNG_BYTES), imageFacade(PNG_BYTES)],
  }, {
    limits: {
      ...DSH_GO_IMAGE_LIMITS,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: PNG_BYTES.byteLength * 2 - 1,
    },
  }), /per-message byte limit/)
  assert.equal(home.putCount, 0)

  await assert.rejects(dshGoImageContent(home.transport, {
    text: '',
    blocks: promptBlocks([
      { type: 'image', attachmentId: ID_C, byteSize: PNG_BYTES.byteLength },
      { type: 'image', url: PNG_DATA_URL },
    ]),
  }, {
    limits: {
      ...DSH_GO_IMAGE_LIMITS,
      maxMessageImageBytes: PNG_BYTES.byteLength * 2 - 1,
    },
  }), /per-message byte limit/)
  assert.equal(home.putCount, 0)
})

test('a bad later image leaves zero partial uploads', async () => {
  const home = new FakeHome('a')
  await assert.rejects(dshGoImageContent(home.transport, {
    text: 'caption',
    images: [
      imageFacade(PNG_BYTES),
      imageFacade(new Uint8Array([1, 2, 3]), { mediaType: 'image/png' }),
    ],
  }), /no supported image signature/)
  assert.equal(home.putCount, 0)
  assert.equal(home.calls.length, 0)
})

test('BEFORE image AFTER stays ordered and placement submits only durable content', async () => {
  const home = new FakeHome('a')
  const content = await dshGoImageContent(home.transport, {
    text: 'BEFORE AFTER',
    blocks: promptBlocks([
      { type: 'text', text: 'BEFORE' },
      {
        type: 'image',
        id: 'local-image',
        path: 'C:/private/pixel.png',
        url: PNG_DATA_URL,
        name: 'pixel.png',
      },
      { type: 'text', text: 'AFTER' },
    ]),
  })
  assert.deepEqual(content, [
    { type: 'text', text: 'BEFORE' },
    { type: 'attachment', attachmentId: homeId('a', 1) },
    { type: 'text', text: 'AFTER' },
  ])

  const calls: Call[] = []
  const placement = createDshGoPlacement({
    sessionId: 'session-A',
    call: async (method, params) => {
      calls.push({ method, params })
      return { accepted: true, turnId: 'turn-1' }
    },
    emit: () => {},
  })
  assert.deepEqual(await placement.submit({
    text: 'BEFORE AFTER',
    blocks: content,
    clientMessageId: 'client-local',
  }, 'turn'), { accepted: true })
  assert.deepEqual(calls, [{
    method: 'session.prompt',
    params: {
      sessionId: 'session-A',
      content: [
        { type: 'text', text: 'BEFORE' },
        { type: 'attachment', attachmentId: homeId('a', 1) },
        { type: 'text', text: 'AFTER' },
      ],
      placement: 'turn',
    },
  }])
  const wire = JSON.stringify(calls[0]!.params)
  for (const forbidden of ['local-image', 'client-local', 'C:/private', 'data:image', PNG_BASE64]) {
    assert.equal(wire.includes(forbidden), false)
  }
})

test('self-contained image blocks do not consume a later local facade', async () => {
  const cases = [
    { first: { type: 'image', attachment: { attachmentId: ID_C } }, firstId: ID_C, secondId: homeId('a', 1), puts: 1 },
    { first: { type: 'image', url: dataUrl(pngWithSize(2, 1)) }, firstId: homeId('a', 1), secondId: homeId('a', 2), puts: 2 },
  ]
  for (const item of cases) {
    const home = new FakeHome('a')
    const content = await dshGoImageContent(home.transport, {
      text: '',
      blocks: promptBlocks([
        item.first,
        { type: 'image', attachment: { attachmentId: 'local-image' } },
      ]),
      images: [imageFacade(PNG_BYTES)],
    })
    assert.deepEqual(content, [
      { type: 'attachment', attachmentId: item.firstId },
      { type: 'attachment', attachmentId: item.secondId },
    ])
    assert.equal(home.putCount, item.puts)
    const local = getDshGoImage(home.transport, attachmentFor(PNG_BYTES, item.secondId))
    assert.deepEqual(await local.read(), PNG_BYTES)
    if (item.puts === 2) {
      const embedded = getDshGoImage(home.transport, attachmentFor(pngWithSize(2, 1), item.firstId, 'image.png'))
      assert.deepEqual(await embedded.read(), pngWithSize(2, 1))
    }
  }

  const matchingHome = new FakeHome('a')
  const matching = await dshGoImageContent(matchingHome.transport, {
    text: '',
    blocks: promptBlocks([{
      type: 'image',
      attachment: { attachmentId: 'local-image' },
      url: dataUrl(pngWithSize(2, 1)),
    }]),
    images: [imageFacade(PNG_BYTES)],
  })
  assert.deepEqual(matching, [{ type: 'attachment', attachmentId: homeId('a', 1) }])
  assert.deepEqual(await getDshGoImage(matchingHome.transport, attachmentFor(PNG_BYTES, homeId('a', 1))).read(), PNG_BYTES)

  const ambiguousHome = new FakeHome('b')
  await assert.rejects(dshGoImageContent(ambiguousHome.transport, {
    text: '',
    blocks: promptBlocks([{ type: 'image', url: PNG_DATA_URL }]),
    images: [imageFacade(PNG_BYTES)],
  }), /image facades did not match/)
  assert.equal(ambiguousHome.putCount, 0)
})

test('reference and existing direct or nested attachment blocks remain durable references', async () => {
  const home = new FakeHome('a')
  const content = await dshGoImageContent(home.transport, {
    text: '',
    blocks: promptBlocks([
      { type: 'reference', referenceType: 'file', path: 'C:/docs/note.txt' },
      { type: 'reference', referenceType: 'session', sessionId: 'session-ref' },
      { type: 'attachment', attachmentId: ID_A, mime: 'application/octet-stream', path: 'C:/forged' },
      { type: 'attachment', attachment: { id: ID_B }, mime: 'image/png', byteSize: PNG_BYTES.byteLength },
      { type: 'image', attachment: { attachmentId: ID_C }, byteSize: PNG_BYTES.byteLength },
    ]),
  })
  assert.deepEqual(content, [
    { type: 'reference', referenceType: 'file', path: 'C:/docs/note.txt' },
    { type: 'reference', referenceType: 'session', sessionId: 'session-ref' },
    { type: 'attachment', attachmentId: ID_A },
    { type: 'attachment', attachmentId: ID_B },
    { type: 'attachment', attachmentId: ID_C },
  ])
  assert.equal(home.calls.length, 0)
})

test('absent, image-only, unknown and facade-less content follows the explicit contract', async () => {
  const home = new FakeHome('a')
  assert.equal(await dshGoImageContent(home.transport, { text: 'plain' }), undefined)
  assert.equal(await dshGoImageContent(home.transport, { text: 'plain', images: [] }), undefined)
  assert.deepEqual(await dshGoImageContent(home.transport, {
    text: '',
    images: [imageFacade(PNG_BYTES)],
  }), [{ type: 'attachment', attachmentId: homeId('a', 1) }])

  const rejectedHome = new FakeHome('b')
  await assert.rejects(dshGoImageContent(rejectedHome.transport, {
    text: '',
    blocks: promptBlocks([{ type: 'video', url: PNG_DATA_URL }]),
  }), /unsupported prompt content block type video/)
  await assert.rejects(dshGoImageContent(rejectedHome.transport, {
    text: '',
    blocks: promptBlocks([{ type: 'image' }]),
  }), /no matching facade, data URL or durable attachment id/)
  await assert.rejects(dshGoImageContent(rejectedHome.transport, {
    text: '',
    blocks: promptBlocks([{ type: 'image', url: 'https://example.invalid/pixel.png' }]),
  }), /expected a supported data:image/)
  await assert.rejects(dshGoImageContent(rejectedHome.transport, {
    text: '',
    blocks: promptBlocks([null, { type: 'text', text: 'AFTER' }] as unknown as readonly PromptBlock[]),
  }), /invalid prompt content block/)
  assert.equal(rejectedHome.putCount, 0)
})

test('image put/get transport errors propagate unchanged', async () => {
  const failure = new Error('image transport failed exactly')
  const transport: DshGoAttachmentTransport = {
    async call<T = unknown>(): Promise<T> {
      throw failure
    },
  }
  await assert.rejects(putDshGoImageDataUrl(transport, PNG_DATA_URL), error => error === failure)
  const facade = getDshGoImage(transport, attachmentFor(PNG_BYTES))
  await assert.rejects(facade.read(), error => error === failure)
})

test('durable construction and transcript are lazy, preserve metadata and read real bytes with a signal', async () => {
  const home = new FakeHome('a')
  const stored = await putDshGoImageDataUrl(home.transport, PNG_DATA_URL, { name: 'pixel.png' })
  const direct = getDshGoImage(home.transport, stored)
  const transcript = dshGoImageTranscript(home.transport, [
    { type: 'text', text: 'ignored' },
    transcriptBlock(stored),
    { ...transcriptBlock(stored), mime: 'image/svg+xml' },
  ], 'local-prefix')
  assert.equal(home.getCount, 0)
  assert.equal(transcript.length, 1)
  for (const facade of [direct, transcript[0]!]) {
    assert.equal(facade.id, stored.id)
    assert.equal(facade.name, 'pixel.png')
    assert.equal(facade.mediaType, 'image/png')
    assert.equal(facade.bytes, PNG_BYTES.byteLength)
    assert.equal(facade.width, 1)
    assert.equal(facade.height, 1)
    assert.equal(facade.path, undefined)
  }

  const controller = new AbortController()
  assert.deepEqual(await direct.read(controller.signal), PNG_BYTES)
  assert.equal(home.getCount, 1)
  assert.deepEqual(await transcript[0]!.read(), PNG_BYTES)
  assert.equal(home.getCount, 2)
  assert.equal(transcript[0]!.id.startsWith('local-prefix'), false)
})

test('durable read honors abort before and after attachment.get', async () => {
  const home = new FakeHome('a')
  const stored = await putDshGoImageDataUrl(home.transport, PNG_DATA_URL)
  const facade = getDshGoImage(home.transport, stored)
  const before = new AbortController()
  before.abort()
  await assert.rejects(facade.read(before.signal), isAbort)
  assert.equal(home.getCount, 0)

  const after = new AbortController()
  home.onGet = () => { after.abort() }
  await assert.rejects(facade.read(after.signal), isAbort)
  assert.equal(home.getCount, 1)
})

test('a new images surface reopens the same durable id without the old facade memory', async () => {
  const home = new FakeHome('a')
  const stored = await putDshGoImageDataUrl(home.transport, PNG_DATA_URL)
  const oldFacade = getDshGoImage(home.transport, stored)
  assert.equal(oldFacade.id, stored.id)
  assert.equal(home.getCount, 0)

  const reopened = createDshGoImages(home.transport)
  const freshFacade = reopened.get(stored)
  assert.notEqual(freshFacade, oldFacade)
  assert.equal(home.getCount, 0)
  assert.deepEqual(await freshFacade.read(), PNG_BYTES)
  assert.equal(home.getCount, 1)
  assert.deepEqual(home.calls.at(-1), { method: 'attachment.get', params: { id: stored.id } })
})

test('independent homes never cross-read equal ids and reject an id absent from the other home', async () => {
  const homeA = new FakeHome('a')
  const homeB = new FakeHome('a')
  const bytesA = PNG_BYTES
  const bytesB = pngWithSize(2, 1)
  const storedA = await putDshGoImageDataUrl(homeA.transport, dataUrl(bytesA))
  const storedB = await putDshGoImageDataUrl(homeB.transport, dataUrl(bytesB))
  assert.equal(storedA.id, storedB.id)
  assert.deepEqual(await getDshGoImage(homeA.transport, storedA).read(), bytesA)
  assert.deepEqual(await getDshGoImage(homeB.transport, storedB).read(), bytesB)
  assert.equal(homeA.getCount, 1)
  assert.equal(homeB.getCount, 1)

  const isolatedA = new FakeHome('a')
  const isolatedB = new FakeHome('b')
  const onlyA = await putDshGoImageDataUrl(isolatedA.transport, PNG_DATA_URL)
  await assert.rejects(getDshGoImage(isolatedB.transport, onlyA).read(), new RegExp(`not_found: ${onlyA.id}`))
  assert.equal(isolatedA.getCount, 0)
  assert.equal(isolatedB.getCount, 1)
  await assert.rejects(getDshGoImage(isolatedB.transport, attachmentFor(PNG_BYTES, ID_UNKNOWN)).read(), /not_found/)
})

test('createDshGoImages binds capability, put, get, content and transcript to one transport', async () => {
  const home = new FakeHome('a')
  const images = createDshGoImages(home.transport)
  assert.deepEqual(images.capability, { limits: DSH_GO_IMAGE_LIMITS })
  assert.equal(images.limits, DSH_GO_IMAGE_LIMITS)

  const first = await images.put(imageFacade(PNG_BYTES))
  assert.equal(first.id, homeId('a', 1))
  const second = await images.putDataUrl(PNG_DATA_URL)
  assert.equal(second.id, homeId('a', 2))
  const fetched = images.get(first)
  assert.equal(home.getCount, 0)
  assert.deepEqual(await fetched.read(), PNG_BYTES)

  const content = await images.content({ text: '', images: [imageFacade(PNG_BYTES)] })
  assert.deepEqual(content, [{ type: 'attachment', attachmentId: homeId('a', 3) }])
  const transcript = images.transcript([transcriptBlock(second)], 'ignored-prefix')
  assert.equal(transcript.length, 1)
  assert.equal(transcript[0]!.id, second.id)
  assert.equal(home.getCount, 1)
  assert.deepEqual(await transcript[0]!.read(), PNG_BYTES)
  assert.equal(home.getCount, 2)
})
