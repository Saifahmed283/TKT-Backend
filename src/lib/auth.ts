import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'
import { config } from '../config.js'

const accessKey = new TextEncoder().encode(config.jwt.accessSecret)
const refreshKey = new TextEncoder().encode(config.jwt.refreshSecret)

export type AccessClaims = {
  sub: string
  email: string
  name: string
  type: 'access'
}

export type RefreshClaims = {
  sub: string
  type: 'refresh'
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export async function signAccessToken(user: { id: string; email: string; name: string }): Promise<string> {
  return new SignJWT({ type: 'access', email: user.email, name: user.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(config.jwt.accessTtl)
    .sign(accessKey)
}

export async function signRefreshToken(userId: string): Promise<string> {
  return new SignJWT({ type: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(config.jwt.refreshTtl)
    .sign(refreshKey)
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, accessKey)
    if (payload.type !== 'access') return null
    return {
      sub: payload.sub!,
      email: (payload.email as string) ?? '',
      name: (payload.name as string) ?? '',
      type: 'access',
    }
  } catch {
    return null
  }
}

export async function verifyRefreshToken(token: string): Promise<RefreshClaims | null> {
  try {
    const { payload } = await jwtVerify(token, refreshKey)
    if (payload.type !== 'refresh') return null
    return { sub: payload.sub!, type: 'refresh' }
  } catch {
    return null
  }
}