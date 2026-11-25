import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { prisma } from '../../lib/db.js'
import { runWithDbContext } from '../../lib/dbContext.js'
import { config } from '../../config.js'
import { processOutboxEvents } from '../../lib/outbox.js'

export async function releaseExpiredSeatHolds(): Promise<number> {
  return runWithDbContext({ isInternal: true }, async () => {
    const now = new Date()
    const expired = await prisma.busSeat.updateMany({
      where: { state: 'HELD', holdExpiresAt: { lte: now } },
      data: {
        state: 'AVAILABLE',
        holderName: null,
        passengerName: null,
        passengerEmail: null,
        passengerPhone: null,
        groupId: null,
        ticketId: null,
        holdToken: null,
        holdExpiresAt: null,
        reservedAt: null,
      },
    })

    // Do not convert database failures into a successful zero-count cleanup.
    return expired.count
  })
}

function isAuthorizedCronRequest(req: FastifyRequest): boolean {
  if (!config.cronSecret) return false
  const headerSecret = req.headers['x-cron-secret']
  const authorization = req.headers.authorization
  const bearerSecret = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : undefined
  return headerSecret === config.cronSecret || bearerSecret === config.cronSecret
}

export async function registerCleanupEndpoint(app: FastifyInstance): Promise<void> {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.cronSecret) {
      return reply.status(503).send({
        error: { code: 'CRON_NOT_CONFIGURED', message: 'Cron secret is not configured' },
      })
    }

    if (!isAuthorizedCronRequest(req)) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid cron secret' },
      })
    }

    const cleaned = await releaseExpiredSeatHolds()
    const outbox = await processOutboxEvents(100)
    const rateLimitsCleaned = await runWithDbContext({ isInternal: true }, () =>
      prisma.$executeRaw`
        DELETE FROM "RateLimitCounter"
        WHERE "windowStart" < ${new Date(Date.now() - 24 * 60 * 60 * 1000)}
      `,
    )

    return { data: { cleaned, outbox, rateLimitsCleaned } }
  }

  // Vercel Cron invokes this endpoint with GET. POST remains available for a
  // protected manual invocation from operational tooling.
  app.get('/internal/cleanup/expired-holds', handler)
  app.post('/internal/cleanup/expired-holds', handler)

  // Run durable delivery retries separately from the daily expiry sweep.
  // An external scheduler can call this endpoint every few minutes.
  const outboxHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.cronSecret) {
      return reply.status(503).send({
        error: { code: 'CRON_NOT_CONFIGURED', message: 'Cron secret is not configured' },
      })
    }
    if (!isAuthorizedCronRequest(req)) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid cron secret' },
      })
    }
    const outbox = await processOutboxEvents(50)
    return { data: { outbox } }
  }

  app.get('/internal/process-outbox', outboxHandler)
  app.post('/internal/process-outbox', outboxHandler)
}
