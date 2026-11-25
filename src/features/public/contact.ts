import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/db.js'
import { updateDbContext } from '../../lib/dbContext.js'
import { contactSchema } from './schemas.js'

export async function contactRoutes(app: FastifyInstance) {
// ── Contact ───────────────────────────────────────────────
  app.post('/contact', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const body = contactSchema.parse(req.body)
    const contactId = randomUUID()
    await updateDbContext({ contactId })
    const message = await prisma.contactMessage.create({
      data: {
        id: contactId,
        name: body.name,
        email: body.email,
        orgName: body.orgName,
        eventType: body.eventType,
        eventDate: body.eventDate,
        message: body.message,
      },
    })
    return reply.code(201).send({ data: { id: message.id, status: message.status } })
  })
}
