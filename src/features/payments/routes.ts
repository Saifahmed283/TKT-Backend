import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { AuditActions } from '../../lib/audit-actions.js'
import { logActivity } from '../../lib/activity.js'
import { issueReservationCredential, reservationCodeOf } from '../reservations/service.js'
import { publish, channelFor } from '../../lib/realtime.js'

const providerSchema = z.object({
  name: z.string().min(2),
  accountName: z.string().optional().nullable(),
  accountNumber: z.string().optional().nullable(),
  paymentPhone: z.string().optional().nullable(),
  paymentLink: z.string().url().optional().nullable().or(z.literal('')),
  instructions: z.string().optional().nullable(),
  imageUrl: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
})

const reviewSchema = z.object({
  action: z.enum(['CONFIRM', 'REJECT']),
  note: z.string().max(500).optional(),
})

export async function paymentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/providers', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'payment.view', { eventId })
    const providers = await prisma.paymentProvider.findMany({
      where: { eventId },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    })
    return { data: providers }
  })

  app.post('/providers', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'payment.view', { eventId })
    const body = providerSchema.parse(req.body)
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, orgId: true } })
    if (!event) throw errors.notFound('Event not found')
    const provider = await prisma.paymentProvider.create({
      data: {
        eventId,
        name: body.name.trim(),
        accountName: body.accountName?.trim() || null,
        accountNumber: body.accountNumber?.trim() || null,
        paymentPhone: body.paymentPhone?.trim() || null,
        paymentLink: body.paymentLink?.trim() || null,
        instructions: body.instructions?.trim() || null,
        imageUrl: body.imageUrl?.trim() || null,
        isActive: body.isActive ?? true,
      },
    })
    await writeAudit({
      organizationId: event.orgId, eventId, actorUserId: req.user.id,
      action: AuditActions.PAYMENT_PROVIDER_CREATED, resourceType: 'payment_provider', resourceId: provider.id,
      newValue: body, sourceIp: req.ip,
    })
    return reply.status(201).send({ data: provider })
  })

  app.patch('/providers/:providerId', async (req) => {
    const { eventId, providerId } = req.params as { eventId: string; providerId: string }
    await requirePermission(req, 'payment.view', { eventId })
    const body = providerSchema.partial().parse(req.body)
    const existing = await prisma.paymentProvider.findFirst({ where: { id: providerId, eventId } })
    if (!existing) throw errors.notFound('Payment provider not found')
    const provider = await prisma.paymentProvider.update({
      where: { id: providerId },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.accountName !== undefined ? { accountName: body.accountName?.trim() || null } : {}),
        ...(body.accountNumber !== undefined ? { accountNumber: body.accountNumber?.trim() || null } : {}),
        ...(body.paymentPhone !== undefined ? { paymentPhone: body.paymentPhone?.trim() || null } : {}),
        ...(body.paymentLink !== undefined ? { paymentLink: body.paymentLink?.trim() || null } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions?.trim() || null } : {}),
        ...(body.imageUrl !== undefined ? { imageUrl: body.imageUrl?.trim() || null } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    })
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    await writeAudit({
      organizationId: event?.orgId, eventId, actorUserId: req.user.id,
      action: AuditActions.PAYMENT_PROVIDER_UPDATED, resourceType: 'payment_provider', resourceId: providerId,
      previousValue: existing, newValue: body, sourceIp: req.ip,
    })
    return { data: provider }
  })

  app.delete('/providers/:providerId', async (req, reply) => {
    const { eventId, providerId } = req.params as { eventId: string; providerId: string }
    await requirePermission(req, 'payment.view', { eventId })
    const existing = await prisma.paymentProvider.findFirst({ where: { id: providerId, eventId } })
    if (!existing) throw errors.notFound('Payment provider not found')
    await prisma.paymentProvider.delete({ where: { id: providerId } })
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    await writeAudit({
      organizationId: event?.orgId, eventId, actorUserId: req.user.id,
      action: AuditActions.PAYMENT_PROVIDER_DELETED, resourceType: 'payment_provider', resourceId: providerId,
      previousValue: existing, sourceIp: req.ip,
    })
    return reply.status(204).send()
  })

  app.get('/pending', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'payment.view', { eventId })
    const rows = await prisma.ticket.findMany({
      where: {
        eventId,
        paymentStatus: 'PENDING',
        paymentSubmittedAt: { not: null },
        status: { in: ['ISSUED', 'ACTIVE'] },
      },
      orderBy: { paymentSubmittedAt: 'desc' },
      take: 200,
      select: {
        id: true, reservationCode: true, reservationName: true, reservationEmail: true, reservationPhone: true,
        status: true, approvalStatus: true, paymentStatus: true, price: true, paymentAmount: true,
        paymentReference: true, paymentProofUrl: true, paymentSubmittedAt: true, paymentReviewNote: true,
        paymentProvider: { select: { id: true, name: true } },
        attendee: { select: { id: true, name: true, email: true, phone: true } },
        ticketType: { select: { id: true, name: true, price: true } },
      },
    })
    return { data: rows }
  })

  app.get('/summary', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'report.view', { eventId })
    const [pending, confirmed, failed, revenueAgg] = await Promise.all([
      prisma.ticket.count({ where: { eventId, paymentStatus: 'PENDING' } }),
      prisma.ticket.count({ where: { eventId, paymentStatus: 'CONFIRMED' } }),
      prisma.ticket.count({ where: { eventId, paymentStatus: 'FAILED' } }),
      prisma.ticket.aggregate({ where: { eventId, paymentStatus: 'CONFIRMED' }, _sum: { paymentAmount: true, price: true } }),
    ])
    return { data: { pending, confirmed, failed, totalRevenue: Number(revenueAgg._sum.paymentAmount ?? revenueAgg._sum.price ?? 0) } }
  })

  app.post('/reservations/:ticketId/review', async (req) => {
    const { eventId, ticketId } = req.params as { eventId: string; ticketId: string }
    await requirePermission(req, 'payment.view', { eventId })
    const body = reviewSchema.parse(req.body)
    const event = await prisma.event.findUnique({ where: { id: eventId } })
    if (!event) throw errors.notFound('Event not found')
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, eventId },
      include: {
        attendee: { select: { id: true, name: true, email: true, phone: true } },
        ticketType: { select: { id: true, name: true, price: true } },
        credential: { select: { id: true, code: true, status: true } },
      },
    })
    if (!ticket) throw errors.notFound('Reservation not found')
    if (ticket.paymentStatus !== 'PENDING') throw errors.conflict('Payment is not pending review')

    if (body.action === 'CONFIRM') {
      const updated = await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          paymentStatus: 'CONFIRMED',
          paymentConfirmedAt: new Date(),
          paymentReviewedAt: new Date(),
          paymentReviewedById: req.user.id,
          paymentReviewNote: body.note?.trim() || null,
        },
        include: {
          attendee: { select: { id: true, name: true, email: true, phone: true } },
          ticketType: { select: { id: true, name: true, price: true } },
          credential: { select: { id: true, code: true, status: true } },
        },
      })
      let credential = updated.credential
      if (updated.approvalStatus === 'APPROVED' && !credential) {
        const issued = await issueReservationCredential({
          event: { id: event.id, orgId: event.orgId, name: event.name, startAt: event.startAt, endAt: event.endAt, venueName: event.venueName },
          ticket: updated as any,
          issuerUserId: req.user.id,
        })
        credential = issued.credential
      }
      await writeAudit({
        organizationId: event.orgId, eventId, actorUserId: req.user.id,
        action: AuditActions.PAYMENT_CONFIRMED, resourceType: 'ticket', resourceId: ticket.id,
        previousValue: { paymentStatus: ticket.paymentStatus }, newValue: { paymentStatus: 'CONFIRMED', note: body.note ?? null },
        sourceIp: req.ip,
      })
      logActivity(eventId, 'payment', `Payment confirmed · ${reservationCodeOf(updated as any) ?? ticket.id.slice(0, 8)}`, req.user.name)
      publish(channelFor.reservation(eventId), 'payment.confirmed', { ticketId: ticket.id })
      return { data: { ticket: await prisma.ticket.findUnique({ where: { id: ticket.id }, include: { credential: { select: { id: true, code: true, status: true } } } }), credential } }
    }

    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: { paymentStatus: 'FAILED', paymentReviewedAt: new Date(), paymentReviewedById: req.user.id, paymentReviewNote: body.note?.trim() || 'Payment rejected' },
    })
    await writeAudit({
      organizationId: event.orgId, eventId, actorUserId: req.user.id,
      action: AuditActions.PAYMENT_REJECTED, resourceType: 'ticket', resourceId: ticket.id,
      previousValue: { paymentStatus: ticket.paymentStatus }, newValue: { paymentStatus: 'FAILED', note: body.note ?? null },
      sourceIp: req.ip,
    })
    logActivity(eventId, 'payment', `Payment rejected · ${reservationCodeOf(ticket as any) ?? ticket.id.slice(0, 8)}`, req.user.name)
    publish(channelFor.reservation(eventId), 'payment.rejected', { ticketId: ticket.id })
    return { data: { ticket: updated } }
  })
}
