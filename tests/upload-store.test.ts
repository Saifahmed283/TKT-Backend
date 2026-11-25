import { describe, expect, it } from 'vitest'
import { detectMimeType, isOwnBlobUrl, isSafeUploadPath, proofPathFromUrl, proofUrl, verifyProofToken } from '../src/lib/uploadStore.js'

describe('upload content sniffing', () => {
  it('recognizes declared image and PDF signatures', () => {
    expect(detectMimeType(Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.from('data')]))).toBe('image/jpeg')
    expect(detectMimeType(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('data')]))).toBe('image/png')
    expect(detectMimeType(Buffer.from('GIF89a data'))).toBe('image/gif')
    expect(detectMimeType(Buffer.concat([Buffer.from('RIFF'), Buffer.from('1234'), Buffer.from('WEBP')]))).toBe('image/webp')
    expect(detectMimeType(Buffer.from('%PDF-1.7'))).toBe('application/pdf')
    expect(detectMimeType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml')
  })

  it('rejects mislabeled and script-bearing SVG payloads', () => {
    expect(detectMimeType(Buffer.from('plain text'))).toBeNull()
    expect(detectMimeType(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeNull()
    expect(detectMimeType(Buffer.from('<svg><script>alert(1)</script></svg>'))).toBeNull()
  })
})

describe('blob URL ownership', () => {
  it('only accepts Vercel Blob URLs under our uploads prefix', () => {
    expect(isOwnBlobUrl('https://example.public.blob.vercel-storage.com/uploads/proof.png')).toBe(true)
    expect(isOwnBlobUrl('https://example.public.blob.vercel-storage.com/uploads/proof.png?x=1')).toBe(true)
    expect(isOwnBlobUrl('https://example.private.blob.vercel-storage.com/uploads/proof.png')).toBe(true)
    expect(isOwnBlobUrl('https://evil.example/uploads/proof.png')).toBe(false)
    expect(isOwnBlobUrl('/uploads/proof.png')).toBe(false)
  })
})

describe('private proof capability links', () => {
  it('signs and verifies a proof path', () => {
    const url = proofUrl('uploads/proof.png')
    const token = new URL(url, 'http://localhost').searchParams.get('token')!
    expect(url.startsWith('/api/uploads/blob/uploads/proof.png?token=')).toBe(true)
    expect(verifyProofToken('uploads/proof.png', token)).toBe(true)
    expect(verifyProofToken('uploads/proof.png', `${token}x`)).toBe(false)
    expect(verifyProofToken('uploads/other.png', token)).toBe(false)
  })

  it('parses only safe proof paths', () => {
    expect(proofPathFromUrl(proofUrl('uploads/proof.png'))).toBe('uploads/proof.png')
    expect(proofPathFromUrl('/api/uploads/blob/uploads/../secret?token=x')).toBeNull()
    expect(isSafeUploadPath('uploads/proof.png')).toBe(true)
    expect(isSafeUploadPath('/uploads/proof.png')).toBe(false)
  })
})
