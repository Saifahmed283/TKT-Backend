import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/db.js'
import { runWithDbContext } from '../../lib/dbContext.js'
import { config } from '../../config.js'
import { processOutboxEvents } from '../../lib/outbox.js'

export async function releaseExpiredSeatHolds(): Promise<number> {
  return runWithDbContext({ isInternal: true }, async () => {
    const now = new Date()
    const expired = await prisma.busSeat.updateMany({
      where: { state: 'HELD', holdExpiresAt: { lt: now } },
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
    }).catch(() => ({ count: 0 }))
    return expired.count
  })
}

/**
 * Internal endpoint for scheduled cleanup (Vercel Cron / external scheduler).
 * Registered in buildApp so the serverless handler receives the same route and
 * secret checks as the long-running server.
 */
export async function registerCleanupEndpoint(app: FastifyInstance): Promise<void> {
  app.post('/internal/cleanup/expired-holds', async (req, reply) => {
    const secret = req.headers['x-cron-secret'] || req.headers['authorization']?.replace('Bearer ', '')
    if (!config.cronSecret) {
      return reply.status(503).send({ error: { code: 'CRON_NOT_CONFIGURED', message: 'Cron secret is not configured' } })
    }
    if (secret !== config.cronSecret) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid cron secret' } })
    }
    const count = await releaseExpiredSeatHolds()
    const outbox = await processOutboxEvents(100)
    return { data: { cleaned: count, outbox } }
  })
}
