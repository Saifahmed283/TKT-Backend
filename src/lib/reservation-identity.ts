import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export type ReservationIdentityInput = {
  gender: 'male' | 'female' | 'other' | 'prefer_not_to_say'
  nationality: 'EG' | 'OTHER'
  identityNumber: string
}

export type ReservationIdentityRecord = {
  gender: ReservationIdentityInput['gender']
  nationality: ReservationIdentityInput['nationality']
  identityType: 'NATIONAL_ID' | 'PASSPORT'
  identityNumber: string
}

function encryptionKey(): Buffer {
  const secret = process.env.PII_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!secret || secret.length < 24) {
    throw new Error('PII_ENCRYPTION_KEY or a sufficiently strong JWT_SECRET is required to protect reservation identity data')
  }
  return createHash('sha256').update('tkt:reservation-identity:v1:').update(secret).digest()
}

/** AES-256-GCM protects identity numbers at rest; only event-authorized admin endpoints decrypt them. */
export function encryptReservationIdentityNumber(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value.trim().toUpperCase(), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decryptReservationIdentityNumber(value: string): string {
  const [version, ivHex, tagHex, encryptedHex] = value.split(':')
  if (version !== 'v1' || !ivHex || !tagHex || !encryptedHex) {
    throw new Error('Unsupported encrypted reservation identity format')
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]).toString('utf8')
}

export function decryptReservationIdentity(value: unknown): ReservationIdentityRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    !['male', 'female', 'other', 'prefer_not_to_say'].includes(String(record.gender))
    || !['EG', 'OTHER'].includes(String(record.nationality))
    || typeof record.encryptedIdentityNumber !== 'string'
  ) return null
  const nationality = record.nationality as 'EG' | 'OTHER'
  return {
    gender: record.gender as ReservationIdentityRecord['gender'],
    nationality,
    identityType: nationality === 'EG' ? 'NATIONAL_ID' : 'PASSPORT',
    identityNumber: decryptReservationIdentityNumber(record.encryptedIdentityNumber),
  }
}
