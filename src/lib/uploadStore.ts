import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { del, put } from '@vercel/blob'
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

const BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com'

function startsWith(buf: Buffer, value: string | number[], offset = 0) {
  const needle = typeof value === 'string' ? Buffer.from(value, 'binary') : Buffer.from(value)
  return buf.length >= offset + needle.length && buf.subarray(offset, offset + needle.length).equals(needle)
}

function isSafeSvg(buf: Buffer) {
  const text = buf.toString('utf8').replace(/^\uFEFF/, '').trim()
  if (!/<svg[\s>]/i.test(text)) return false
  // Uploaded SVGs are public assets. Scripts and handlers would turn a
  // "payment proof" into stored XSS if a browser opens the URL directly.
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

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || config.uploads.blobToken
}

function useBlobStore() {
  // Production has no persistent local disk on serverless. Fail fast there
  // when the token is missing instead of silently writing an ephemeral file.
  if (config.isProd) return true
  return Boolean(blobToken())
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
    let url: string
    try {
      const result = await put(pathname.slice(1), buf, { access: 'public', token, contentType: mimeType })
      url = result.url
    } catch {
      throw new AppError(503, 'UPLOAD_STORE_UNAVAILABLE', 'Upload storage is unavailable')
    }
    return { url, path: url, name: file.filename, mimeType, size: buf.length }
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
  return parsed.hostname.endsWith(BLOB_HOST_SUFFIX) && parsed.pathname.startsWith('/uploads/')
}

export async function deleteUploadedFile(url?: string | null) {
  if (!url || typeof url !== 'string') return

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
