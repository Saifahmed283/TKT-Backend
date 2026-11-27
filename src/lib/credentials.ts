import { createPublicKey, createPrivateKey, sign, verify } from 'node:crypto'
import { prisma } from './db.js'
import { config } from '../config.js'

export type CredentialPayload = {
  v: 1
  credId: string
  shortCode?: string
  attendeeId: string
  eventId: string
  ticketType: string
  attendeeName: string
  validFrom: number
  validUntil: number | null
  singleUse: boolean
  allowReentry: boolean
}

const SHORT_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** One include shape shared by gate scans so a badge needs a single DB read. */
export const credentialInclude = {
  attendee: true,
  ticket: {
    include: {
      ticketType: true,
      busSeats: {
        select: { id: true, label: true, passengerName: true, bus: { select: { name: true } } },
        orderBy: { label: 'asc' },
      },
    },
  },
}

export async function generateUniqueShortCode(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    let suffix = ''
    for (let i = 0; i < 5; i++) suffix += SHORT_CODE_CHARS[Math.floor(Math.random() * SHORT_CODE_CHARS.length)]
    const shortCode = `TKT-${suffix}`
    const exists = await prisma.credential.findFirst({ where: { shortCode }, select: { id: true } })
    if (!exists) return shortCode
  }
  throw new Error('Could not generate unique ticket code')
}

function getKeyPair() {
  const privB64 = config.credentialKeys.privateKeyB64
  const pubB64 = config.credentialKeys.publicKeyB64
  if (!privB64 || !pubB64) {
    throw new Error(
      'CREDENTIAL_PRIVATE_KEY_B64 / CREDENTIAL_PUBLIC_KEY_B64 must be set. See .env.example.',
    )
  }
  return {
    privateKey: createPrivateKey(Buffer.from(privB64, 'base64url')),
    publicKey: createPublicKey(Buffer.from(pubB64, 'base64url')),
  }
}

export function signPayload(payload: CredentialPayload): string {
  const { privateKey } = getKeyPair()
  const data = JSON.stringify(payload)
  return sign(null, Buffer.from(data), privateKey).toString('base64url')
}

export function verifyPayload(payload: CredentialPayload, signature: string): boolean {
  const { publicKey } = getKeyPair()
  try {
    return verify(
      null,
      Buffer.from(JSON.stringify(payload)),
      publicKey,
      Buffer.from(signature, 'base64url'),
    )
  } catch {
    return false
  }
}

export function publicKeyPem(): string {
  return createPublicKey(Buffer.from(config.credentialKeys.publicKeyB64, 'base64url'))
    .export({ type: 'spki', format: 'pem' })
    .toString()
}

export const credentialCode = {
  encode: (payload: CredentialPayload) => {
    const sig = signPayload(payload)
    return `TKT1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`
  },
  decode: (code: string): { payload: CredentialPayload; signature: string } | null => {
    const parts = code.split('.')
    if (parts.length !== 3 || parts[0] !== 'TKT1') return null
    const [, data, sig] = parts
    if (!data || !sig) return null
    try {
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as CredentialPayload
      if (payload.v !== 1) return null
      return { payload, signature: sig }
    } catch {
      return null
    }
  },
}

export async function verifyCredentialIntegrity(
  code: string,
  eventId: string,
  client: any = prisma,
): Promise<{ credential: any; payload: CredentialPayload | null; signature: string | null; decoded: boolean; verified: boolean } | null> {
  const decoded = credentialCode.decode(code)
  if (decoded) {
    const validSig = verifyPayload(decoded.payload, decoded.signature)
    if (decoded.payload.eventId !== eventId) {
      return { credential: null, payload: decoded.payload, signature: decoded.signature, decoded: true, verified: false }
    }
    // Scope the lookup to the event as well as the signed id so a valid token
    // from another event can never resolve against this event's gate.
    const credential = await client.credential.findFirst({
      where: { id: decoded.payload.credId, eventId },
      include: credentialInclude,
    })
    return { credential, payload: decoded.payload, signature: decoded.signature, decoded: true, verified: validSig }
  }
  // fallback: raw code / shortCode match (legacy badge codes)
  const normalized = code.trim().toUpperCase()
  const credential = await client.credential.findFirst({
    where: normalized.startsWith('TKT-') && normalized.length <= 12
      ? { eventId, OR: [{ shortCode: normalized }, { code }] }
      : { eventId, code },
    include: credentialInclude,
  })
  if (!credential || credential.eventId !== eventId) return null
  return { credential, payload: null, signature: null, decoded: false, verified: false }
}