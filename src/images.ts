import type { ImageLimitsView, SessionCapabilities } from './types/agent/capabilities.js'
import type { ImageRef } from './types/agent/events.js'
import type { AgentInput } from './types/agent/session.js'
import {
  DSH_GO_ATTACHMENT_MAX_BYTES,
  dshGoAttachmentBlock,
  getDshGoAttachment,
  parseDshGoAttachment,
  putDshGoAttachmentBytes,
  type DshGoAttachment,
  type DshGoAttachmentTransport,
  type DshGoPromptContentBlock,
} from './attachments.js'
import { probeImageSize, sniffImageMediaType } from './image-size.js'
import type { ImageSizeProbe } from './image-size.js'


export type DshGoImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

const IMAGE_TYPES: readonly DshGoImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGES_PER_MESSAGE = 64
const MAX_PROMPT_BLOCKS = 64
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024
const ATTACHMENT_ID = /^att-[0-9a-f]{32}$/u

/** Native hard caps plus the derived bounds ImageLimitsView requires for the composer. */
export const DSH_GO_IMAGE_LIMITS: ImageLimitsView = Object.freeze({
  mediaTypes: Object.freeze([...IMAGE_TYPES]),
  maxImageBytes: DSH_GO_ATTACHMENT_MAX_BYTES,
  maxImagesPerMessage: MAX_IMAGES_PER_MESSAGE,
  maxMessageImageBytes: MAX_IMAGES_PER_MESSAGE * DSH_GO_ATTACHMENT_MAX_BYTES,
  maxImageDimension: MAX_IMAGE_PIXELS,
  maxImagePixels: MAX_IMAGE_PIXELS,
})

export interface DshGoImageData {
  readonly data: Uint8Array
  readonly mediaType: DshGoImageMediaType
  readonly width: number
  readonly height: number
}

export interface DshGoImagePutOptions {
  readonly signal?: AbortSignal
  readonly name?: string
  readonly limits?: ImageLimitsView
}

export interface DshGoImageContentOptions {
  readonly signal?: AbortSignal
  readonly limits?: ImageLimitsView
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const isImageType = (value: unknown): value is DshGoImageMediaType =>
  typeof value === 'string' && (IMAGE_TYPES as readonly string[]).includes(value)

const imageName = (name: string | undefined, mediaType: DshGoImageMediaType): string =>
  name ?? `image.${mediaType.slice('image/'.length) === 'jpeg' ? 'jpg' : mediaType.slice('image/'.length)}`

function checkDimensions(width: number, height: number, limits: ImageLimitsView): void {
  if (width > limits.maxImageDimension || height > limits.maxImageDimension || width * height > limits.maxImagePixels) {
    throw new Error('dsh-go: image exceeds the pixel/dimension limit')
  }
}

/** Validate the actual encoded bytes; no facade or filename metadata is trusted. */
export function validateDshGoImage(
  data: Uint8Array,
  mediaType: unknown,
  limits: ImageLimitsView = DSH_GO_IMAGE_LIMITS,
): DshGoImageData {
  if (data.byteLength === 0) throw new Error('dsh-go: image data is empty')
  if (data.byteLength > limits.maxImageBytes) throw new Error('dsh-go: image exceeds the 8 MiB per-image limit')
  if (!isImageType(mediaType) || !limits.mediaTypes.includes(mediaType)) {
    throw new Error(`dsh-go: unsupported image media type ${typeof mediaType === 'string' ? mediaType : '?'}`)
  }
  const sniffed = sniffImageMediaType(data)
  if (sniffed === undefined) throw new Error('dsh-go: image bytes have no supported image signature')
  if (sniffed !== mediaType) throw new Error(`dsh-go: image media type ${mediaType} contradicts its ${sniffed} bytes`)
  const size = probeImageSize(data)
  if (size === null) throw new Error('dsh-go: image dimensions could not be measured')
  checkDimensions(size.width, size.height, limits)
  return { data, mediaType, width: size.width, height: size.height }
}

/** Decode one canonical, padded base64 data URL and validate the decoded image. */
export function decodeDshGoImageDataUrl(
  url: string,
  limits: ImageLimitsView = DSH_GO_IMAGE_LIMITS,
): DshGoImageData {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(url)
  if (match === null) throw new Error('dsh-go: expected a supported data:image/...;base64 URL')
  const mediaType = match[1] as DshGoImageMediaType
  const encoded = match[2]!
  if (encoded === '') throw new Error('dsh-go: image data URL payload is empty')
  if (encoded.length % 4 !== 0) throw new Error('dsh-go: image data URL is not canonical base64')
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64') !== encoded) throw new Error('dsh-go: image data URL is not canonical base64')
  return validateDshGoImage(new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength), mediaType, limits)
}

function verifyStoredImage(attachment: DshGoAttachment, image: DshGoImageData): DshGoAttachment {
  if (attachment.mime !== image.mediaType || attachment.byteSize !== image.data.byteLength
    || attachment.width !== image.width || attachment.height !== image.height) {
    throw new Error('dsh-go: attachment.put returned metadata that does not match the image bytes')
  }
  return attachment
}

async function putValidated(
  transport: DshGoAttachmentTransport,
  image: DshGoImageData,
  options: DshGoImagePutOptions,
): Promise<DshGoAttachment> {
  const attachment = await putDshGoAttachmentBytes(transport, {
    data: image.data,
    name: imageName(options.name, image.mediaType),
  }, options.signal)
  return verifyStoredImage(attachment, image)
}

/** Store a data URL through the host's path-only attachment.put adapter. */
export async function putDshGoImageDataUrl(
  transport: DshGoAttachmentTransport,
  url: string,
  options: DshGoImagePutOptions = {},
): Promise<DshGoAttachment> {
  const image = decodeDshGoImageDataUrl(url, options.limits)
  return putValidated(transport, image, options)
}

/** Read and validate an arbitrary facade before storing its actual bytes. */
export async function putDshGoImage(
  transport: DshGoAttachmentTransport,
  image: ImageRef,
  options: DshGoImagePutOptions = {},
): Promise<DshGoAttachment> {
  options.signal?.throwIfAborted()
  const data = await image.read(options.signal)
  const validated = validateDshGoImage(data, image.mediaType, options.limits)
  return putValidated(transport, validated, { ...options, name: options.name ?? image.name })
}

function sameStoredImage(left: DshGoAttachment, right: DshGoAttachment): boolean {
  return left.id === right.id && left.name === right.name && left.mime === right.mime
    && left.byteSize === right.byteSize && left.sha256 === right.sha256
    && left.width === right.width && left.height === right.height
}

/** Build a durable lazy facade. No attachment.get occurs until read(). */
export function getDshGoImage(
  transport: DshGoAttachmentTransport,
  value: unknown,
  limits: ImageLimitsView = DSH_GO_IMAGE_LIMITS,
): ImageRef {
  const attachment = parseDshGoAttachment(value)
  if (!isImageType(attachment.mime) || !limits.mediaTypes.includes(attachment.mime)) {
    throw new Error('dsh-go: attachment is not a supported image')
  }
  const width = attachment.width!
  const height = attachment.height!
  checkDimensions(width, height, limits)
  return {
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mime,
    bytes: attachment.byteSize,
    width,
    height,
    async read(signal?: AbortSignal): Promise<Uint8Array> {
      signal?.throwIfAborted()
      const content = await getDshGoAttachment(transport, attachment.id, signal)
      if (!sameStoredImage(attachment, content.attachment)) {
        throw new Error('dsh-go: attachment.get returned different image metadata')
      }
      return validateDshGoImage(content.data, content.attachment.mime, limits).data
    },
  }
}

function durableImage(value: unknown): DshGoAttachment | undefined {
  const block = record(value)
  if (block?.type !== 'attachment' || !isImageType(block.mime)) return undefined
  try {
    return parseDshGoAttachment({ ...block, id: block.attachmentId })
  } catch {
    return undefined
  }
}

/** Project durable attachment blocks without prefetching their bytes.
 *  ImageRef.id stays the real attachment id; idPrefix never replaces it. */
export function dshGoImageTranscript(
  transport: DshGoAttachmentTransport,
  content: unknown,
  _idPrefix?: string,
): ImageRef[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(block => {
    const attachment = durableImage(block)
    if (attachment === undefined) return []
    try {
      return [getDshGoImage(transport, attachment)]
    } catch {
      return []
    }
  })
}

interface PreparedBlock {
  readonly index: number
  readonly image: DshGoImageData
  readonly name?: string
}

function existingAttachmentId(block: Record<string, unknown>): string | undefined {
  const direct = block.attachmentId
  if (typeof direct === 'string' && ATTACHMENT_ID.test(direct)) return direct
  const attachment = record(block.attachment)
  const nested = attachment?.attachmentId ?? attachment?.id
  return typeof nested === 'string' && ATTACHMENT_ID.test(nested) ? nested : undefined
}

function localAttachmentId(block: Record<string, unknown>): string | undefined {
  const attachment = record(block.attachment)
  const value = block.attachmentId ?? attachment?.attachmentId ?? attachment?.id
  return typeof value === 'string' && value !== '' && !ATTACHMENT_ID.test(value) ? value : undefined
}

function noteExistingImage(block: Record<string, unknown>, limits: ImageLimitsView, total: number): number {
  const bytes = block.byteSize
  if (bytes !== undefined && (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > limits.maxImageBytes)) {
    throw new Error('dsh-go: durable image has an invalid byteSize')
  }
  return total + (typeof bytes === 'number' ? bytes : 0)
}

function referenceBlock(block: Record<string, unknown>): DshGoPromptContentBlock {
  if (block.referenceType === 'file' && typeof block.path === 'string' && block.path !== '') {
    return { type: 'reference', referenceType: 'file', path: block.path }
  }
  if (block.referenceType === 'session' && typeof block.sessionId === 'string' && block.sessionId !== '') {
    return { type: 'reference', referenceType: 'session', sessionId: block.sessionId }
  }
  throw new Error('dsh-go: invalid reference content block')
}

/**
 * Convert image blocks to durable attachment ids in place. Every new image is
 * read and validated before the first put, so a bad later image cannot leave a
 * partially uploaded batch. Existing real attachment ids remain references.
 */
export async function dshGoImageContent(
  transport: DshGoAttachmentTransport,
  input: Pick<AgentInput, 'text' | 'blocks' | 'images'>,
  options: DshGoImageContentOptions = {},
): Promise<readonly DshGoPromptContentBlock[] | undefined> {
  const limits = options.limits ?? DSH_GO_IMAGE_LIMITS
  const images = input.images ?? []
  if (input.blocks === undefined && images.length === 0) return undefined
  const source = input.blocks ?? (input.text === '' ? [] : [{ type: 'text', text: input.text }])
  const expectedBlocks = source.length + (input.blocks === undefined ? images.length : 0)
  if (expectedBlocks === 0) throw new Error('dsh-go: prompt content must contain at least one block')
  if (expectedBlocks > MAX_PROMPT_BLOCKS) throw new Error(`dsh-go: prompt content exceeds ${MAX_PROMPT_BLOCKS} blocks`)

  const output: (DshGoPromptContentBlock | undefined)[] = []
  const prepared: PreparedBlock[] = []
  let imageCursor = 0
  let imageCount = 0
  let totalBytes = 0

  const prepare = (image: DshGoImageData, name?: string): void => {
    imageCount += 1
    if (imageCount > limits.maxImagesPerMessage) throw new Error('dsh-go: too many images in one message')
    totalBytes += image.data.byteLength
    if (totalBytes > limits.maxMessageImageBytes) throw new Error('dsh-go: images exceed the per-message byte limit')
    output.push(undefined)
    prepared.push({ index: output.length - 1, image, ...(name === undefined ? {} : { name }) })
  }

  const existing = (block: Record<string, unknown>, id: string, knownImage = false): void => {
    if (knownImage || isImageType(block.mime)) {
      imageCount += 1
      if (imageCount > limits.maxImagesPerMessage) throw new Error('dsh-go: too many images in one message')
      totalBytes = noteExistingImage(block, limits, totalBytes)
      if (totalBytes > limits.maxMessageImageBytes) throw new Error('dsh-go: images exceed the per-message byte limit')
    }
    output.push(dshGoAttachmentBlock(id))
  }

  for (const raw of source) {
    const block = record(raw)
    if (block === undefined || typeof block.type !== 'string') throw new Error('dsh-go: invalid prompt content block')
    switch (block.type) {
      case 'text':
        if (typeof block.text !== 'string') throw new Error('dsh-go: text content block has no text')
        output.push({ type: 'text', text: block.text })
        break
      case 'reference':
        output.push(referenceBlock(block))
        break
      case 'attachment': {
        const id = existingAttachmentId(block)
        if (id === undefined) throw new Error('dsh-go: attachment block has no real durable attachment id')
        existing(block, id)
        break
      }
      case 'image': {
        const durable = existingAttachmentId(block)
        if (durable !== undefined) {
          existing(block, durable, true)
          break
        }
        const facade = images[imageCursor]
        const localId = localAttachmentId(block)
        const hasDataUrl = typeof block.url === 'string'
        const facadeMatches = facade !== undefined && (localId === undefined ? !hasDataUrl : facade.id === localId)
        if (facadeMatches) {
          imageCursor += 1
          options.signal?.throwIfAborted()
          const data = await facade.read(options.signal)
          prepare(validateDshGoImage(data, facade.mediaType, limits), facade.name)
          break
        }
        if (typeof block.url !== 'string') throw new Error('dsh-go: image block has no matching facade, data URL or durable attachment id')
        prepare(decodeDshGoImageDataUrl(block.url, limits), typeof block.name === 'string' ? block.name : undefined)
        break
      }
      default:
        throw new Error(`dsh-go: unsupported prompt content block type ${block.type}`)
    }
  }
  if (input.blocks !== undefined && imageCursor !== images.length) {
    throw new Error('dsh-go: image facades did not match their prompt image blocks')
  }
  while (imageCursor < images.length) {
    const facade = images[imageCursor++]!
    options.signal?.throwIfAborted()
    const data = await facade.read(options.signal)
    prepare(validateDshGoImage(data, facade.mediaType, limits), facade.name)
  }

  for (const item of prepared) {
    const attachment = await putValidated(transport, item.image, { signal: options.signal, name: item.name })
    output[item.index] = dshGoAttachmentBlock(attachment)
  }
  return output.map(block => {
    if (block === undefined) throw new Error('dsh-go: internal image content assembly error')
    return block
  })
}

/** Transport-bound convenience surface used by the backend owner. */
export function createDshGoImages(transport: DshGoAttachmentTransport) {
  const capability: NonNullable<SessionCapabilities['images']> = { limits: DSH_GO_IMAGE_LIMITS }
  return {
    capability,
    limits: DSH_GO_IMAGE_LIMITS,
    put: (image: ImageRef, options: DshGoImagePutOptions = {}) => putDshGoImage(transport, image, options),
    putDataUrl: (url: string, options: DshGoImagePutOptions = {}) => putDshGoImageDataUrl(transport, url, options),
    get: (attachment: DshGoAttachment) => getDshGoImage(transport, attachment),
    content: (input: Pick<AgentInput, 'text' | 'blocks' | 'images'>, options: DshGoImageContentOptions = {}) =>
      dshGoImageContent(transport, input, options),
    transcript: (content: unknown, idPrefix?: string): ImageRef[] => dshGoImageTranscript(transport, content, idPrefix),
  }
}
