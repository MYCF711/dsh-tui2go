import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export const DSH_GO_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024

type DshGoAttachmentMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'text/plain'

/** Metadata returned by DSH-GO's persistent attachment store. */
export interface DshGoAttachment {
  readonly id: string
  readonly name: string
  readonly byteSize: number
  readonly mime: DshGoAttachmentMime
  readonly sha256: string
  readonly width?: number
  readonly height?: number
}

export interface DshGoAttachmentContent {
  readonly attachment: DshGoAttachment
  readonly data: Uint8Array
}

/** Only the Transport surface needed by attachments. */
export interface DshGoAttachmentTransport {
  call<T = unknown>(method: string, params: Readonly<Record<string, unknown>>): Promise<T>
}

export type DshGoPromptContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'attachment'; readonly attachmentId: string }
  | { readonly type: 'reference'; readonly referenceType: 'file'; readonly path: string }
  | { readonly type: 'reference'; readonly referenceType: 'session'; readonly sessionId: string }

const ATTACHMENT_ID = /^att-[0-9a-f]{32}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const IMAGE_MIMES: readonly DshGoAttachmentMime[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isMime(value: unknown): value is DshGoAttachmentMime {
  return value === 'text/plain' || (typeof value === 'string' && (IMAGE_MIMES as readonly string[]).includes(value))
}

function invalidAttachment(): Error {
  return new Error('dsh-go: invalid attachment metadata')
}

/** Validate and normalize the metadata supplied by the host. */
export function parseDshGoAttachment(value: unknown): DshGoAttachment {
  const input = record(value)
  if (input === undefined) throw invalidAttachment()
  const { id, name, byteSize, mime, sha256 } = input
  if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)
    || typeof name !== 'string' || name === ''
    || typeof byteSize !== 'number' || !Number.isInteger(byteSize)
    || byteSize <= 0 || byteSize > DSH_GO_ATTACHMENT_MAX_BYTES
    || !isMime(mime)
    || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    throw invalidAttachment()
  }
  if ((input.width !== undefined && typeof input.width !== 'number')
    || (input.height !== undefined && typeof input.height !== 'number')) {
    throw invalidAttachment()
  }
  const width = input.width as number | undefined
  const height = input.height as number | undefined
  if (mime === 'text/plain') {
    if (!((width === undefined || width === 0) && (height === undefined || height === 0))) throw invalidAttachment()
  } else if (width === undefined || height === undefined
    || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw invalidAttachment()
  }
  return {
    id, name, byteSize, mime, sha256,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  }
}

/** Store an explicit local path through the native path-only RPC. */
export async function putDshGoAttachment(
  transport: DshGoAttachmentTransport,
  path: string,
): Promise<DshGoAttachment> {
  const result = await transport.call<unknown>('attachment.put', { path })
  const attachment = record(result)?.attachment
  if (attachment === undefined) throw new Error('dsh-go: attachment.put returned an invalid result')
  return parseDshGoAttachment(attachment)
}

function temporaryAttachmentName(name: string | undefined): string {
  const base = basename((name ?? 'attachment').replace(/\\/gu, '/'))
  const safe = base.replace(/[<>:"/\\|?*\x00-\x1F]/gu, '_').replace(/[. ]+$/gu, '')
  return safe === '' || safe === '.' || safe === '..' ? 'attachment' : safe
}

/** Adapt in-memory bytes to the host's path-only put API, always removing staging. */
export async function putDshGoAttachmentBytes(
  transport: DshGoAttachmentTransport,
  input: { readonly data: Uint8Array; readonly name?: string },
  signal?: AbortSignal,
): Promise<DshGoAttachment> {
  signal?.throwIfAborted()
  if (input.data.byteLength === 0) throw new Error('dsh-go: attachment data is empty')
  if (input.data.byteLength > DSH_GO_ATTACHMENT_MAX_BYTES) throw new Error('dsh-go: attachment data exceeds 8 MiB')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-go-attachment-'))
  try {
    signal?.throwIfAborted()
    const path = join(directory, temporaryAttachmentName(input.name))
    await writeFile(path, input.data, { mode: 0o600, flag: 'wx' })
    signal?.throwIfAborted()
    const attachment = await putDshGoAttachment(transport, path)
    signal?.throwIfAborted()
    return attachment
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Read durable bytes and verify the host's identity, length and digest claims. */
export async function getDshGoAttachment(
  transport: DshGoAttachmentTransport,
  id: string,
  signal?: AbortSignal,
): Promise<DshGoAttachmentContent> {
  signal?.throwIfAborted()
  if (!ATTACHMENT_ID.test(id)) throw new Error('dsh-go: invalid attachment id')
  const result = await transport.call<unknown>('attachment.get', { id })
  signal?.throwIfAborted()
  const envelope = record(result)
  if (envelope === undefined) throw new Error('dsh-go: attachment.get returned an invalid result')
  const attachment = parseDshGoAttachment(envelope.attachment)
  if (attachment.id !== id) throw new Error('dsh-go: attachment.get returned a different attachment id')
  const encoded = envelope.dataBase64
  if (typeof encoded !== 'string' || encoded === '' || /\s/u.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('dsh-go: attachment.get returned non-canonical base64')
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64') !== encoded) throw new Error('dsh-go: attachment.get returned non-canonical base64')
  const data = new Uint8Array(decoded)
  if (data.byteLength !== attachment.byteSize) throw new Error('dsh-go: attachment byteSize does not match its bytes')
  const sha256 = createHash('sha256').update(data).digest('hex')
  if (sha256 !== attachment.sha256) throw new Error('dsh-go: attachment sha256 does not match its bytes')
  return { attachment, data }
}

/** Only the durable id crosses the prompt boundary; client metadata is not trusted. */
export function dshGoAttachmentBlock(
  attachment: DshGoAttachment | string,
): Extract<DshGoPromptContentBlock, { type: 'attachment' }> {
  return { type: 'attachment', attachmentId: typeof attachment === 'string' ? attachment : attachment.id }
}
