import { describe, it, expect } from 'vitest'
import { decodeScanCandidates } from '../src/features/access/routes.js'

describe('access scan decodeScanCandidates', () => {
  it('includes raw candidate', () => {
    const candidates = decodeScanCandidates('TKT1.abc.def')
    expect(candidates[0]).toEqual({ code: 'TKT1.abc.def', source: 'tkt1' })
  })

  it('decodes url-encoded TKT1', () => {
    const raw = encodeURIComponent('TKT1.payload.sig')
    const candidates = decodeScanCandidates(raw)
    expect(candidates.some((c) => c.code === 'TKT1.payload.sig' && c.source === 'tkt1')).toBe(true)
  })

  it('decodes base64url JSON wrapper containing reservationCode', () => {
    const wrapped = Buffer.from(JSON.stringify({ reservationCode: 'TKT-ABC123' })).toString('base64url')
    const candidates = decodeScanCandidates(wrapped)
    expect(candidates.some((c) => c.code === 'TKT-ABC123')).toBe(true)
  })

  it('extracts code from JSON wrapper', () => {
    const wrapped = JSON.stringify({ code: 'TKT1.payload.sig' })
    const candidates = decodeScanCandidates(wrapped)
    expect(candidates.some((c) => c.code === 'TKT1.payload.sig' && c.source === 'tkt1')).toBe(true)
  })

  it('dedupes candidates', () => {
    const candidates = decodeScanCandidates('TKT1.same.sig')
    const codes = candidates.filter((c) => c.code === 'TKT1.same.sig')
    expect(codes.length).toBe(1)
  })
})
