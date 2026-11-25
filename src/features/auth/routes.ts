import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { prisma } from '../../lib/db.js'
import { hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyRefreshToken } from '../../lib/auth.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { writeAudit } from '../../lib/audit.js'
import { config } from '../../config.js'
import { validatePasswordStrength } from '../../lib/passwordPolicy.js'
import { updateDbContext } from '../../lib/dbContext.js'

const registerSchema = z
  .object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email(),
    password: z.string().min(1, 'Password is required'),
  })
  .superRefine((val, ctx) => {
    const policy = validatePasswordStrength(val.password)
    if (!policy.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: policy.reason })
    }
  })

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

function refreshCookieOptions() {
  // ticketak.vercel.app -> tkt-backend.vercel.app is cross-site, so the
  // refresh cookie needs SameSite=None; Secure on Vercel. Localhost stays Lax
  // so ordinary http dev servers keep working.
  const crossSite = config.isProd || config.isVercel
  return {
    httpOnly: true,
    sameSite: crossSite ? ('none' as const) : ('lax' as const),
    secure: crossSite,
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  }
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

async function createRefreshSession(userId: string, token: string, req: any) {
  const tokenHash = hashRefreshToken(token)
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
  await prisma.refreshSession.create({
    data: {
      userId,
      tokenHash,
      userAgent: req.headers['user-agent'] ?? null,
      ipAddress: req.ip ?? null,
      expiresAt,
    },
  })
}

function setRefreshCookie(reply: any, token: string) {
  reply.setCookie('tkt_refresh', token, refreshCookieOptions())
}

async function clearRefreshCookieAndRevoke(reply: any, token?: string) {
  if (token) {
    const tokenHash = hashRefreshToken(token)
    await prisma.refreshSession.updateMany({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    })
  }
  const crossSite = config.isProd || config.isVercel
  reply.clearCookie('tkt_refresh', {
    path: '/',
    sameSite: crossSite ? ('none' as const) : ('lax' as const),
    secure: crossSite,
  })
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/register', {
    config: { rateLimit: { max: 3, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const { name, email, password } = registerSchema.parse(req.body)
    const exists = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
    if (exists) throw errors.conflict('An account with this email already exists')

    const user = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        passwordHash: await hashPassword(password),
      },
    })
    await updateDbContext({ userId: user.id, isAuth: true })

    const access = await signAccessToken(user)
    const refresh = await signRefreshToken(user.id)
    await createRefreshSession(user.id, refresh, req)
    setRefreshCookie(reply, refresh)

    await writeAudit({
      actorUserId: user.id,
      action: 'user.registered',
      resourceType: 'user',
      resourceId: user.id,
      sourceIp: req.ip,
    })

    return reply.status(201).send({ data: { token: access, user: publicUser(user) } })
  })

  app.post('/login', {
    config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const { email, password } = loginSchema.parse(req.body)
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw errors.unauthorized('Invalid email or password')
    }
    if (user.status !== 'ACTIVE') throw errors.unauthorized('This account is suspended')
    await updateDbContext({ userId: user.id, isAuth: true })

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

    const access = await signAccessToken(user)
    const refresh = await signRefreshToken(user.id)
    await createRefreshSession(user.id, refresh, req)
    setRefreshCookie(reply, refresh)

    await writeAudit({
      actorUserId: user.id,
      action: 'user.login',
      resourceType: 'user',
      resourceId: user.id,
      sourceIp: req.ip,
    })

    return reply.send({ data: { token: access, user: publicUser(user) } })
  })

  /**
 * Extract refresh token from cookies with fallback parsing.
 * Vercel's edge runtime sometimes doesn't populate req.cookies properly.
 */
function extractRefreshToken(req: any): string | undefined {
  // First try Fastify's built-in cookie parser
  const fromParser = (req.cookies as Record<string, string | undefined> | undefined)?.tkt_refresh
  if (fromParser) return fromParser

  // Fallback: manually parse Cookie header
  const cookieHeader = req.headers?.cookie
  if (!cookieHeader) return undefined

  try {
    const cookies = cookieHeader.split(';').reduce((acc: Record<string, string>, cookie) => {
      const [key, ...valueParts] = cookie.trim().split('=')
      if (key && valueParts.length > 0) {
        acc[key.trim()] = valueParts.join('=').trim()
      }
      return acc
    }, {} as Record<string, string>)
    return cookies.tkt_refresh
  } catch {
    return undefined
  }
}

  app.post('/refresh', {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const token = extractRefreshToken(req)
      
      // Detailed logging for debugging
      const hasCookieHeader = !!req.headers?.cookie
      const hasParsedCookies = !!req.cookies
      req.log.info({
        hasCookieHeader,
        hasParsedCookies,
        cookieHeaderPreview: req.headers?.cookie?.substring(0, 50),
        tokenFound: !!token,
      }, 'auth.refresh attempt')

      if (!token) {
        req.log.warn({ 
          cookieHeader: req.headers?.cookie ? 'present' : 'missing',
          parsedCookies: req.cookies ? Object.keys(req.cookies) : 'none',
        }, 'auth.refresh: No refresh token found')
        throw errors.unauthorized('No refresh session')
      }
      
      const claims = await verifyRefreshToken(token)
      if (!claims) {
        req.log.warn({ tokenPreview: token.substring(0, 10) }, 'auth.refresh: Token verification failed')
        throw errors.unauthorized('Refresh session expired')
      }
      
      // Check if token is revoked
      const tokenHash = hashRefreshToken(token)
      const session = await prisma.refreshSession.findUnique({ where: { tokenHash } })
      if (!session) {
        req.log.warn({ tokenHash: tokenHash.substring(0, 10) }, 'auth.refresh: Session not found in DB')
        await clearRefreshCookieAndRevoke(reply, token)
        throw errors.unauthorized('Refresh session not found')
      }
      if (session.revokedAt) {
        req.log.warn({ sessionId: session.id }, 'auth.refresh: Session revoked')
        await clearRefreshCookieAndRevoke(reply, token)
        throw errors.unauthorized('Refresh session revoked')
      }
      if (session.expiresAt < new Date()) {
        req.log.warn({ sessionId: session.id, expiresAt: session.expiresAt }, 'auth.refresh: Session expired')
        await clearRefreshCookieAndRevoke(reply, token)
        throw errors.unauthorized('Refresh session expired')
      }
      
      const user = await prisma.user.findUnique({ where: { id: claims.sub } })
      if (!user || user.status !== 'ACTIVE') {
        await clearRefreshCookieAndRevoke(reply, token)
        throw errors.unauthorized('Account not found')
      }

      // Rotate refresh token: revoke old, create new
      await prisma.refreshSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      })
      
      const access = await signAccessToken(user)
      const refresh = await signRefreshToken(user.id)
      await createRefreshSession(user.id, refresh, req)
      setRefreshCookie(reply, refresh)
      
      req.log.info({ userId: user.id }, 'auth.refresh: Success')
      return reply.send({ data: { token: access, user: publicUser(user) } })
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err) throw err
      req.log.error({ err }, 'auth.refresh failed')
      throw errors.unauthorized('Refresh session invalid')
    }
  })

  app.post('/logout', async (req, reply) => {
    const token = extractRefreshToken(req)
    await clearRefreshCookieAndRevoke(reply, token)
    return reply.send({ data: { ok: true } })
  })

  app.get('/me', { preHandler: authenticate }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, name: true, email: true, phone: true, platformRole: true,
        orgMemberships: {
          select: {
            role: true, status: true,
            org: { select: { id: true, name: true, slug: true } },
          },
        },
        eventMemberships: {
          where: { status: 'ACTIVE' },
          select: {
            id: true, status: true,
            role: { select: { code: true, name: true, scope: true, permissions: true } },
            team: { select: { id: true, name: true } },
            areas: { select: { area: { select: { id: true, name: true, type: true } } } },
            event: { select: { id: true, name: true, status: true, type: true, startAt: true, org: { select: { id: true, name: true } } } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    })
    if (!user) throw errors.notFound('User not found')
    return { data: user }
  })
}

function publicUser(user: { id: string; name: string; email: string; platformRole: string | null }) {
  return { id: user.id, name: user.name, email: user.email, platformRole: user.platformRole }
}