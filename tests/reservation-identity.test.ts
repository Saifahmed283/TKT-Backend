import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  decryptReservationIdentity,
  decryptReservationIdentityNumber,
  encryptReservationIdentityNumber,
} from '../src/lib/reservation-identity.js'
import { reservationSchema } from '../src/features/public/schemas.js'

const previousSecret = process.env.JWT_SECRET

beforeAll(() => {
  process.env.JWT_SECRET = 'reservation-identity-test-secret-with-more-than-32-characters'
})

afterAll(() => {
  if (previousSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = previousSecret
})

describe('reservation identity protection', () => {
  it('encrypts national ID values and decrypts only with the configured key', () => {
    const nationalId = '29901011234567'
    const encrypted = encryptReservationIdentityNumber(nationalId)
    expect(encrypted).toMatch(/^v1:/)
    expect(encrypted).not.toContain(nationalId)
    expect(decryptReservationIdentityNumber(encrypted)).toBe(nationalId)
  })

  it('returns normalized identity details only for valid encrypted records', () => {
    const encryptedIdentityNumber = encryptReservationIdentityNumber('AB1234567')
    expect(decryptReservationIdentity({
      gender: 'female',
      nationality: 'OTHER',
      encryptedIdentityNumber,
    })).toEqual({
      gender: 'female',
      nationality: 'OTHER',
      identityType: 'PASSPORT',
      identityNumber: 'AB1234567',
    })
    expect(decryptReservationIdentity({ gender: 'unknown' })).toBeNull()
  })

  it('accepts 14-digit Egyptian IDs and rejects malformed ones', () => {
    const common = {
      name: 'Test Guest',
      email: 'guest@example.test',
      phone: '+20 100 123 4567',
      gender: 'prefer_not_to_say',
      nationality: 'EG',
      ticketTypeId: 'ticket-type-id',
    }
    expect(reservationSchema.safeParse({ ...common, identityNumber: '29901011234567' }).success).toBe(true)
    expect(reservationSchema.safeParse({ ...common, identityNumber: '1234567890123' }).success).toBe(false)
  })

  it('accepts non-Egyptian passport numbers after normalization', () => {
    const result = reservationSchema.safeParse({
      name: 'Test Guest',
      email: 'guest@example.test',
      phone: '+971 50 123 4567',
      gender: 'female',
      nationality: 'OTHER',
      identityNumber: 'ab1234567',
      ticketTypeId: 'ticket-type-id',
    })
    expect(result.success).toBe(true)
  })
})
