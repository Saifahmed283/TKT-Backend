import fs from 'node:fs/promises'
import path from 'node:path'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { del, get, put } from '@vercel/blob'
import { config } from '../config.js'
import { AppError, errors } from './errors.js'

const ALLOWED = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/svg+xml', 'svg'],
  ['application/pdf', 'pdf'],
])

type UploadFile = {
  mimetype: string
  filename: string
  toBuffer: () => Promise<Buffer>
}

const PUBLIC_BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com'
const PRIVATE_BLOB_HOST_SUFFIX = '.private.blob.vercel-storage.com'
export const PROOF_PROXY_PREFIX = '/api/uploads/blob/'

function startsWith(buf: Buffer, value: string | number[], offset = 0) {
  const needle = typeof value === 'string' ? Buffer.from(value, 'binary') : Buffer.from(value)
  return buf.length >= offset + needle.length && buf.subarray(offset, offset + needle.length).equals(needle)
}

function isSafeSvg(buf: Buffer) {
  const text = buf.toString('utf8').replace(/^\uFEFF/, '').trim()
  if (!/<svg[\s>]/i.test(text)) return false
  // Uploaded SVGs are served through a signed proxy. Scripts and handlers would
  // still turn a "payment proof" into stored XSS if opened directly.
  return !/<script\b|<\/script\b|\bon[a-z]+\s*=|\bjavascript:/i.test(text)
}

/** Content sniffing: declared MIME types are attacker-controlled. */
export function detectMimeType(buf: Buffer): string | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(buf, 'GIF87a') || startsWith(buf, 'GIF89a')) return 'image/gif'
  if (startsWith(buf, 'RIFF') && startsWith(buf, 'WEBP', 8)) return 'image/webp'
  if (startsWith(buf, '%PDF-')) return 'application/pdf'
  if (isSafeSvg(buf)) return 'image/svg+xml'
  return null
}

export function isSafeUploadPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('uploads/')) return false
  const name = path.basename(value)
  return Boolean(name) && name !== '.' && name !== '..' && !name.includes('..') && value === `uploads/${name}`
}

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || config.uploads.blobToken
}

function useBlobStore() {
  // Tests stay on local disk so a configured token never makes them hit Blob.
  if (config.isTest) return false
  // Production has no persistent local disk on serverless. Fail fast there
  // when the token is missing instead of silently writing an ephemeral file.
  if (config.isProd) return true
  return Boolean(blobToken())
}

function signProofPath(pathname: string) {
  // Capability link: the blob stays private, but whoever holds the URL can view it.
  // Domain-separate from auth tokens so a JWT secret cannot be reused as proof.
  return createHmac('sha256', config.jwt.accessSecret)
    .update('tkt-private-proof-v1\0')
    .update(pathname)
    .digest('base64url')
}

export function proofUrl(pathname: string) {
  return `${PROOF_PROXY_PREFIX}${pathname}?token=${signProofPath(pathname)}`
}

export function verifyProofToken(pathname: string, token?: string) {
  if (!token) return false
  const expected = Buffer.from(signProofPath(pathname))
  const actual = Buffer.from(token)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function privateBlobUrl(pathname: string) {
  const storeId = process.env.BLOB_STORE_ID || config.uploads.blobStoreId
  if (!storeId) throw new AppError(503, 'UPLOAD_STORE_UNAVAILABLE', 'Blob store is not configured')
  return `https://${storeId}${PRIVATE_BLOB_HOST_SUFFIX}/${pathname}`
}

export async function readPrivateUpload(pathname: string) {
  const token = blobToken()
  if (!token) throw new AppError(503, 'UPLOAD_STORE_UNAVAILABLE', 'Upload storage is not configured')
  try {
    const result = await get(pathname, { access: 'private', token })
    if (!result || result.statusCode !== 200 || !result.stream) return null
    return {
      stream: Readable.fromWeb(result.stream as any),
      contentType: result.blob.contentType,
      size: result.blob.size,
    }
  } catch {
    return null
  }
}

export async function saveUpload(file: UploadFile) {
  const declared = ALLOWED.get(file.mimetype)
  if (!declared) throw errors.badRequest('Unsupported file type. Allowed: jpg, png, webp, gif, svg, pdf')

  const buf = await file.toBuffer()
  if (!buf.length) throw errors.badRequest('Empty file')
  if (buf.length > config.uploads.maxBytes) throw errors.badRequest('File too large')

  const mimeType = detectMimeType(buf)
  if (!mimeType || mimeType !== file.mimetype) {
    throw errors.badRequest('File contents do not match the declared type')
  }

  const ext = ALLOWED.get(mimeType) ?? declared
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
  const pathname = `/uploads/${name}`

  if (useBlobStore()) {
    const token = blobToken()
    if (!token) {
      throw new AppError(503, 'UPLOAD_STORE_UNAVAILABLE', 'Upload storage is not configured')
    }
    const key = `uploads/${name}`
    try {
      const result = await put(key, buf, { access: 'private', token, contentType: mimeType })
      const storedPath = isSafeUploadPath(result.pathname) ? result.pathname : key
      const url = proofUrl(storedPath)
      return { url, path: url, name: file.filename, mimeType, size: buf.length }
    } catch {
      throw new AppError(503, 'UPLOAD_STORE_UNAVAILABLE', 'Upload storage is unavailable')
    }
  }

  const dir = path.resolve(process.cwd(), config.uploads.dir)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name), buf)
  const base = config.publicUrl.replace(/\/$/, '')
  return {
    url: `${base}${pathname}`,
    path: pathname,
    name: file.filename,
    mimeType,
    size: buf.length,
  }
}

function parsedUrl(url: string) {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

export function isOwnBlobUrl(url: string) {
  const parsed = parsedUrl(url)
  if (!parsed || parsed.protocol !== 'https:') return false
  const ownHost = parsed.hostname.endsWith(PUBLIC_BLOB_HOST_SUFFIX) || parsed.hostname.endsWith(PRIVATE_BLOB_HOST_SUFFIX)
  return ownHost && parsed.pathname.startsWith('/uploads/')
}

export function proofPathFromUrl(url?: string | null): string | null {
  if (!url || typeof url !== 'string') return null
  if (url.startsWith(PROOF_PROXY_PREFIX)) {
    const pathname = url.slice(PROOF_PROXY_PREFIX.length).split('?')[0] ?? ''
    return isSafeUploadPath(pathname) ? pathname : null
  }
  const parsed = parsedUrl(url)
  const pathname = parsed?.hostname.endsWith(PRIVATE_BLOB_HOST_SUFFIX) ? parsed.pathname.replace(/^\//, '') : ''
  return isSafeUploadPath(pathname) ? pathname : null
}

export async function deleteUploadedFile(url?: string | null) {
  if (!url || typeof url !== 'string') return

  const proofPath = proofPathFromUrl(url)
  if (proofPath) {
    const token = blobToken()
    if (!token) return
    await del(privateBlobUrl(proofPath), { token }).catch(() => {})
    return
  }

  if (isOwnBlobUrl(url)) {
    const token = blobToken()
    if (!token) return
    await del(url, { token }).catch(() => {})
    return
  }

  // Local fallback URLs can be absolute (publicUrl + /uploads/...) or a path.
  const pathname = parsedUrl(url)?.pathname ?? url.split('?')[0] ?? ''
  if (!pathname.startsWith('/uploads/')) return
  const name = path.basename(pathname)
  if (!name || name.includes('..')) return
  await fs.unlink(path.resolve(process.cwd(), config.uploads.dir, name)).catch(() => {})
}
