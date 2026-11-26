import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { attachSse } from '../../lib/realtime.js'
import { config } from '../../config.js'

const querySchema = z.object({
  channel: z.string().regex(/^event:[a-z0-9]+:[a-z_]+$/),
})

export async function realtimeRoutes(app: FastifyInstance) {
  // Vercel Functions are request-scoped. Long-lived SSE responses consume a
  // function invocation until platform termination, while the in-memory hub
  // cannot fan out across independent instances. Production uses polling
  // until a shared realtime provider is configured.
  if (config.isVercel) {
    app.get('/', async (_req, reply) => reply.code(410).send({
      error: {
        code: 'REALTIME_DISABLED_ON_SERVERLESS',
        message: 'Realtime streams are disabled on Vercel. Use the API polling fallback.',
      },
    }))
    return
  }

  app.addHook('preHandler', authenticate)

  app.get('/', async (req, reply) => {
    const { channel } = querySchema.parse(req.query)
    const eventId = channel.split(':')[1]!
    await requirePermission(req, 'event.view', { eventId })
    // The stream is written directly to the raw response and stays open.
    // Hijacking makes that lifecycle explicit and prevents Fastify from
    // trying to send a second response after the handler returns.
    reply.hijack()
    attachSse(reply, channel)
  })
}