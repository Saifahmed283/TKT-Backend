import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.js'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { updateDbContext } from '../../lib/dbContext.js'
import { afterResponse } from '../../lib/background.js'
import { processOutboxEventIds } from '../../lib/outbox.js'
import { signHandoffToken } from '../../lib/pass-tokens.js'
import { authenticate } from '../../middleware/auth.js'
import {
  assertPassServiceToken,
  canAccessPassEvent,
  createPreviewToken,
  getEventAnalytics,
  getEventPassDesign,
  getGuestPass,
  listPassExplorer,
  listPassTickets,
  normalizePassDesign,
  passDeliveryCount,
  resetEventPassDesign,
  resendPassTicket,
  resendPassTickets,
  saveEventPassDesign,
  saveGuestPassDesign,
  type PassActor,
} from './service.js'

const listTicketsQuery = z.object({
  approval: z.enum(['APPROVED', 'PENDING', 'REJECTED', 'NONE', 'ALL']).optional(),
  passStatus: z.enum(['NOT_ISSUED', 'ISSUED', 'DELIVERED', 'FAILED', 'REVOKED', 'ALL']).optional(),
  q: z.string().max(160).optional(),
})

const designSchema = z.object({
  theme: z.enum(['royal-gold', 'rose-blush', 'lilac-dream', 'emerald-wild', 'midnight-sky']).optional(),
  header: z.string().nullable().optional(),
  accent: z.string().nullable().optional(),
  quote: z.string().max(200).optional(),
})

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function actorFromServiceHeaders(req: FastifyRequest): PassActor {
  return {
    master: headerValue(req, 'x-tkt-actor-role') === 'master',
    userId: headerValue(req, 'x-tkt-actor-user-id') || undefined,
    platformRole: headerValue(req, 'x-tkt-actor-platform-role') || null,
  }
}

/** Accept either a TKT browser session or the pass app's server-side service token. */
async function passAuth(req: FastifyRequest, reply: FastifyReply) {
  const serviceToken = headerValue(req, 'x-tkt-service-token')
  if (serviceToken) {
    assertPassServiceToken(serviceToken)
    const actor = actorFromServiceHeaders(req)
    await updateDbContext({
      userId: actor.userId,
      isSuperAdmin: Boolean(actor.master || actor.platformRole === 'super_admin'),
      isInternal: true,
    })
    ;(req as FastifyRequest & { passActor?: PassActor }).passActor = actor
    return
  }
  await authenticate(req, reply)
  const actor: PassActor = { userId: req.user.id, platformRole: req.platformRole ?? null }
  ;(req as FastifyRequest & { passActor?: PassActor }).passActor = actor
}

function actor(req: FastifyRequest): PassActor {
  return (req as FastifyRequest & { passActor?: PassActor }).passActor ?? { userId: req.user?.id }
}

function requireService(req: FastifyRequest) {
  assertPassServiceToken(headerValue(req, 'x-tkt-service-token'))
}

function tokenValue(req: FastifyRequest, body?: unknown): string | null {
  const query = req.query as Record<string, unknown> | undefined
  const fromQuery = query?.t
  if (typeof fromQuery === 'string') return fromQuery
  const fromBody = body && typeof body === 'object' ? (body as Record<string, unknown>).t : null
  return typeof fromBody === 'string' ? fromBody : null
}

export async function passRoutes(app: FastifyInstance) {
  app.addHook('preHandler', passAuth)

  // Explorer: organizations → folders → events visible to this actor.
  app.get('/explorer', async (req) => listPassExplorer(actor(req)))

  // Full analytics for one event.
  app.get('/events/:eventId/analytics', async (req) => {
    const { eventId } = req.params as { eventId: string }
    return getEventAnalytics(actor(req), eventId)
  })

  app.get('/events/:eventId/tickets', async (req) => {
    const { eventId } = req.params as { eventId: string }
    const filters = listTicketsQuery.parse(req.query)
    return { tickets: await listPassTickets(actor(req), eventId, filters) }
  })

  app.get('/events/:eventId/design', async (req) => {
    const { eventId } = req.params as { eventId: string }
    return getEventPassDesign(actor(req), eventId)
  })

  app.put('/events/:eventId/design', async (req) => {
    const { eventId } = req.params as { eventId: string }
    const body = z.object({ design: designSchema, resetTickets: z.boolean().optional() }).parse(req.body)
    await canAccessPassEvent(actor(req), eventId)
    return saveEventPassDesign(actor(req), eventId, body.design, body.resetTickets === true)
  })

  app.post('/events/:eventId/design/reset', async (req) => {
    const { eventId } = req.params as { eventId: string }
    return resetEventPassDesign(actor(req), eventId)
  })

  app.post('/tickets/resend', async (req, reply) => {
    const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }).parse(req.body)
    const result = await resendPassTickets(actor(req), body.ids)
    await afterResponse(req, 'pass batch resend', { eventId: '' }, () => processOutboxEventIds(result.outboxEventIds))
    return reply.send({ data: result })
  })

  app.post('/tickets/:ticketId/resend', async (req, reply) => {
    const { ticketId } = req.params as { ticketId: string }
    const result = await resendPassTicket(actor(req), ticketId)
    await afterResponse(req, 'pass resend', { eventId: '' }, () => processOutboxEventIds([result.outboxEventId]))
    return reply.send({ data: result })
  })

  app.post('/tickets/:ticketId/preview', async (req) => {
    const { ticketId } = req.params as { ticketId: string }
    const result = await createPreviewToken(actor(req), ticketId)
    return {
      token: result.token,
      url: `${config.pass.siteUrl.replace(/\/$/, '')}/pass?t=${encodeURIComponent(result.token)}`,
      expiresAt: result.expiresAt.toISOString(),
    }
  })

  // Signed handoff from the main TKT app into the pass admin.
  app.post('/handoff', async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, email: true, platformRole: true },
    })
    if (!user) throw errors.notFound('User not found')
    const membership = await prisma.organizationMember.findFirst({
      where: { userId: user.id, status: 'ACTIVE' },
      select: { role: true },
      orderBy: { createdAt: 'asc' },
    })
    const token = await signHandoffToken({
      userId: user.id,
      name: user.name,
      email: user.email,
      platformRole: user.platformRole ?? null,
      role: membership?.role ?? null,
    })
    return {
      url: `${config.pass.siteUrl.replace(/\/$/, '')}/api/admin/handoff?token=${encodeURIComponent(token)}`,
      expiresInSeconds: config.pass.handoffTtlSeconds,
    }
  })
}

/** Guest endpoints are called by the pass app's server-side BFF, never by browsers directly. */
export async function publicPassRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => requireService(req))

  app.get('/guest', async (req) => {
    const token = tokenValue(req)
    if (!token) return { error: 'INVALID_LINK' }
    return getGuestPass(token)
  })

  app.post('/design', async (req) => {
    const body = z.object({ t: z.string().min(1), design: designSchema }).parse(req.body)
    const token = tokenValue(req, body)
    if (!token) return { error: 'INVALID_LINK' }
    return saveGuestPassDesign(token, body.design)
  })

  app.get('/delivery-count', async () => ({ sentToday: await passDeliveryCount() }))
}
