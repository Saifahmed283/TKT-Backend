import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { decideReservation, reservationApprovalOf, reservationCodeOf } from './service.js'
import { logActivity } from '../../lib/activity.js'

const listQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).default('PENDING'),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

const decisionSchema = z.object({ approved: z.boolean() })

export async function reservationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // ── Reservation inbox (public registrations per event) ─────────
  app.get('/', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'event.view', { eventId })
    const { status, q, page, pageSize } = listQuerySchema.parse(req.query)

    const where: any = { eventId, metadata: { path: ['channel'], equals: 'public' } }
    if (status !== 'ALL') {
      if (status === 'PENDING') {
        where.OR = [
          { metadata: { path: ['approval'], equals: 'PENDING' } },
          { metadata: { path: ['approval'], equals: null }, price: { gt: 0 }, status: { in: ['ISSUED', 'ACTIVE'] } },
        ]
      } else if (status === 'APPROVED') {
        where.OR = [
          { metadata: { path: ['approval'], equals: 'APPROVED' } },
          { metadata: { path: ['approval'], equals: null }, OR: [{ price: { equals: 0 } }, { price: null }] },
        ]
      } else {
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : []),
          { metadata: { path: ['approval'], equals: 'REJECTED' } },
        ]
        where.OR = undefined
      }
    }
    if (q) {
      where.AND = [
        { OR: [{ attendee: { name: { contains: q, mode: 'insensitive' } } }, { attendee: { email: { contains: q, mode: 'insensitive' } } }] },
      ]
    }

    const [total, rows] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          attendee: { select: { id: true, name: true, email: true, phone: true, status: true } },
          ticketType: { select: { id: true, name: true, price: true } },
          credential: { select: { id: true, code: true, status: true } },
        },
      }),
    ])

    return {
      data: {
        rows: rows.map((t: (typeof rows)[number]) => ({
          id: t.id,
          status: t.status,
          reservationCode: reservationCodeOf(t),
          approval: reservationApprovalOf(t),
          price: t.price?.toString() ?? '0',
          issuedAt: t.issuedAt,
          attendee: t.attendee,
          ticketType: t.ticketType,
          credential: t.credential,
        })),
        total,
        page,
        pageSize,
      },
    }
  })

  // ── Approve / reject a pending reservation ─────────────────────
  app.post('/:ticketId/decision', async (req, reply) => {
    const { eventId, ticketId } = req.params as { eventId: string; ticketId: string }
    await requirePermission(req, 'ticket.issue', { eventId })
    const { approved } = decisionSchema.parse(req.body)
    const result = await decideReservation({
      eventId,
      ticketId,
      approved,
      actorUserId: req.user.id,
      actorName: req.user.name,
    })
    logActivity(
      eventId,
      'reservation',
      `Reservation ${approved ? 'approved' : 'rejected'} · ${reservationCodeOf(result.ticket) ?? ticketId.slice(0, 8)}`,
      req.user.name,
    )
    return reply.send({ data: { ok: true, approval: approved ? 'APPROVED' : 'REJECTED', ticketId, credential: result.credential } })
  })
}