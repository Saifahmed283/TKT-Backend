import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { publish, channelFor } from '../../lib/realtime.js'
import { decideReservation, resendReservationCredential, reservationApprovalOf, reservationCodeOf, reservationPaymentOf } from './service.js'

const listQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).default('PENDING'),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

const decisionSchema = z.object({
  approved: z.boolean(),
  reason: z.string().max(280).optional(),
})

export async function reservationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // ── Reservation inbox (public registrations per event) ─────────
  app.get('/', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'event.view', { eventId })
    const { status, q, page, pageSize } = listQuerySchema.parse(req.query)

    const where: any = {
      eventId,
      OR: [
        { metadata: { path: ['channel'], equals: 'public' } },
        { reservationCode: { not: null } },
        { approvalStatus: { in: ['PENDING', 'APPROVED', 'REJECTED'] } },
      ],
    }

    if (status !== 'ALL') {
      where.approvalStatus = status
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
          paymentStatus: reservationPaymentOf(t),
          deliveryStatus: t.deliveryStatus ?? 'PENDING',
          deliveryChannel: t.deliveryChannel ?? 'EMAIL',
          price: t.price?.toString() ?? '0',
          issuedAt: t.issuedAt,
          approvedAt: t.approvedAt,
          rejectedReason: t.rejectedReason,
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
    const { approved, reason } = decisionSchema.parse(req.body)
    const result = await decideReservation({
      eventId,
      ticketId,
      approved,
      actorUserId: req.user.id,
      actorName: req.user.name,
      reason,
    })
    publish(channelFor.reservation(eventId), approved ? 'reservation.approved' : 'reservation.rejected', {
      ticketId,
      approval: approved ? 'APPROVED' : 'REJECTED',
      alreadyDecided: result.alreadyDecided,
    })
    return reply.send({
      data: {
        ok: true,
        approval: approved ? 'APPROVED' : 'REJECTED',
        ticketId,
        credential: result.credential,
        alreadyDecided: result.alreadyDecided,
      },
    })
  })

  app.post('/:ticketId/resend', async (req, reply) => {
    const { eventId, ticketId } = req.params as { eventId: string; ticketId: string }
    await requirePermission(req, 'ticket.issue', { eventId })
    const result = await resendReservationCredential({
      eventId,
      ticketId,
      actorUserId: req.user.id,
      actorName: req.user.name,
    })
    publish(channelFor.reservation(eventId), result.deliveryOk ? 'credential.delivery.sent' : 'credential.delivery.failed', {
      ticketId,
      deliveryOk: result.deliveryOk,
      deliveryStatus: result.ticket.deliveryStatus,
    })
    return reply.send({
      data: {
        ok: true,
        ticketId,
        deliveryOk: result.deliveryOk,
        credential: result.credential,
        deliveryStatus: result.ticket.deliveryStatus,
      },
    })
  })

  app.get('/:ticketId/deliveries', async (req) => {
    const { eventId, ticketId } = req.params as { eventId: string; ticketId: string }
    await requirePermission(req, 'ticket.view', { eventId })
    const rows = await prisma.credentialDeliveryAttempt.findMany({
      where: { eventId, ticketId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        channel: true,
        status: true,
        recipient: true,
        provider: true,
        providerMessageId: true,
        error: true,
        attempt: true,
        createdAt: true,
      },
    })
    return { data: rows }
  })
}