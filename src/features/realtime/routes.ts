import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { attachSse } from '../../lib/realtime.js'

const querySchema = z.object({
  channel: z.string().regex(/^event:[a-z0-9]+:[a-z_]+$/),
})

export async function realtimeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req, reply) => {
    const { channel } = querySchema.parse(req.query)
    const eventId = channel.split(':')[1]!
    await requirePermission(req, 'event.view', { eventId })
    attachSse(reply, channel)
  })
}