import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { config } from '../config.js'

export const PASS_GUEST_TYPE = 'tkt_pass_guest'
export const PASS_HANDOFF_TYPE = 'tkt_pass_handoff'
const ISSUER = 'tkt-backend'
const AUDIENCE = 'tkt-pass'

function secret(value: string, name: string): Uint8Array {
  if (!value) throw new Error(`Missing ${name}`)
  return new TextEncoder().encode(value)
}

export function hashPassToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && createHash('sha256').update(left).digest('hex') === createHash('sha256').update(right).digest('hex')
}

/** Event end + 24h, capped at 30 days and the configured TTL, never under an hour. */
export function guestTokenExpiry(eventEndAt: Date | null): Date {
  const now = Date.now()
  const maxTtl = Math.max(60 * 60, Math.min(config.pass.guestTtlSeconds, 30 * 24 * 60 * 60)) * 1000
  const eventTtl = eventEndAt && Number.isFinite(eventEndAt.getTime())
    ? eventEndAt.getTime() + 24 * 60 * 60 * 1000
    : now + maxTtl
  return new Date(Math.max(now + 60 * 60 * 1000, Math.min(eventTtl, now + maxTtl)))
}

export async function signGuestPassToken(params: {
  ticketId: string
  sessionId: string
  expiresAt: Date
}): Promise<string> {
  const iat = Math.floor(Date.now() / 1000)
  return new SignJWT({ typ: PASS_GUEST_TYPE, tid: params.ticketId, sid: params.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(params.ticketId)
    .setIssuedAt(iat)
    .setExpirationTime(Math.floor(params.expiresAt.getTime() / 1000))
    .setJti(createHash('sha256').update(`${params.ticketId}:${params.sessionId}:${iat}`).digest('hex').slice(0, 32))
    .sign(secret(config.pass.guestSecret, 'PASS_TOKEN_SECRET'))
}

export async function verifyGuestPassToken(token: string): Promise<{ ticketId: string; sessionId: string; expiresAt: Date; jti?: string; expired: boolean } | null> {
  if (!token || typeof token !== 'string') return null
  try {
    // Verify signature, issuer and audience while tolerating expiry so an
    // authentic-but-expired link can be reported as EXPIRED_LINK rather than
    // being lumped in with tampered/invalid tokens.
    const { payload } = await jwtVerify(token, secret(config.pass.guestSecret, 'PASS_TOKEN_SECRET'), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: 10 * 365 * 24 * 60 * 60,
    })
    if (payload.typ !== PASS_GUEST_TYPE || typeof payload.tid !== 'string' || typeof payload.sid !== 'string' || typeof payload.exp !== 'number') {
      return null
    }
    return {
      ticketId: payload.tid,
      sessionId: payload.sid,
      expiresAt: new Date(payload.exp * 1000),
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
      expired: payload.exp * 1000 <= Date.now(),
    }
  } catch {
    return null
  }
}

export async function signHandoffToken(params: {
  userId: string
  name: string
  email: string
  platformRole?: string | null
  role?: string | null
}): Promise<string> {
  const iat = Math.floor(Date.now() / 1000)
  return new SignJWT({
    typ: PASS_HANDOFF_TYPE,
    uid: params.userId,
    name: params.name,
    email: params.email,
    platformRole: params.platformRole ?? null,
    orgRole: params.role ?? null,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(params.userId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + config.pass.handoffTtlSeconds)
    .setJti(createHash('sha256').update(`${params.userId}:${iat}:${Math.random()}`).digest('hex').slice(0, 32))
    .sign(secret(config.pass.handoffSecret, 'PASS_HANDOFF_SECRET'))
}
