import type { FastifyReply, FastifyRequest } from 'fastify'
import { verifyAccessToken, type AccessClaims } from '../lib/auth.js'
import { errors } from '../lib/errors.js'
import { prisma } from '../lib/db.js'
import { updateDbContext } from '../lib/dbContext.js'

declare module 'fastify' {
  interface FastifyRequest {
    user: AccessClaims & { id: string }
  }
}

const BEARER_RE = /^Bearer\s+(.+)$/i

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization
  const token = header?.match(BEARER_RE)?.[1]
  if (!token) throw errors.unauthorized()

  // The global onRequest hook already verified this token for RLS context.
  // Reuse those claims instead of paying JWT verification twice per request.
  const claims = req.authClaims ?? (await verifyAccessToken(token))
  if (!claims) throw errors.unauthorized('Session expired or invalid')

  req.user = { ...claims, id: claims.sub }
  await updateDbContext({ userId: claims.sub, isSuperAdmin: false })

  let platformRole = req.platformRole
  if (platformRole === undefined) {
    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: { platformRole: true },
    })
    platformRole = user?.platformRole ?? null
    req.platformRole = platformRole
  }
  if (platformRole === 'super_admin') {
    await updateDbContext({ isSuperAdmin: true })
  }
}
