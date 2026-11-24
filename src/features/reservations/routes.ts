import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import ExcelJS from 'exceljs'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { publish, channelFor } from '../../lib/realtime.js'
import { decideReservation, isPaidTicket, resendReservationCredential, reservationApprovalOf, reservationCodeOf, reservationPaymentOf } from './service.js'

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
          ticketType: { select: { id: true, name: true, price: true, tier: true } },
          credential: { select: { id: true, code: true, status: true } },
          paymentProvider: { select: { id: true, name: true } },
          busSeats: { select: { id: true, label: true, busId: true, passengerName: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } },
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
          paymentAmount: (t as any).paymentAmount?.toString?.() ?? null,
          paymentReference: (t as any).paymentReference ?? null,
          paymentProofUrl: (t as any).paymentProofUrl ?? null,
          paymentSubmittedAt: (t as any).paymentSubmittedAt ?? null,
          paymentReviewedAt: (t as any).paymentReviewedAt ?? null,
          paymentReviewNote: (t as any).paymentReviewNote ?? null,
          paymentProvider: (t as any).paymentProvider ?? null,
          seats: ((t as any).busSeats ?? []).map((s: any) => ({ id: s.id, label: s.label, busId: s.busId, passengerName: s.passengerName ?? null, busName: s.bus?.name ?? null })),
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
    if (approved) {
      const current = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { eventId: true, price: true, paymentStatus: true, metadata: true, ticketType: { select: { price: true } } },
      })
      if (!current || current.eventId !== eventId) throw errors.notFound('Reservation not found')
      if (isPaidTicket(current) && reservationPaymentOf(current) === 'PENDING') {
        throw errors.conflict('Confirm payment proof before approving this paid reservation')
      }
    }
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
    const body = z.object({ toEmail: z.string().email().optional() }).parse(req.body ?? {})
    const result = await resendReservationCredential({
      eventId,
      ticketId,
      actorUserId: req.user.id,
      actorName: req.user.name,
      toEmail: body.toEmail,
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

  app.get('/export.xlsx', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'report.export', { eventId })
    const { status, q } = listQuerySchema.partial().parse(req.query)
    const where: Record<string, unknown> = { eventId, metadata: { path: ['channel'], equals: 'public' } }
    if (status && status !== 'ALL') {
      if (status === 'PENDING') where.OR = [{ approvalStatus: 'PENDING' }, { paymentStatus: 'PENDING' }]
      else if (status === 'APPROVED') where.approvalStatus = 'APPROVED'
      else if (status === 'REJECTED') where.approvalStatus = 'REJECTED'
    }
    if (q) {
      where.OR = [
        { reservationCode: { contains: q, mode: 'insensitive' } },
        { reservationName: { contains: q, mode: 'insensitive' } },
        { reservationEmail: { contains: q, mode: 'insensitive' } },
        { reservationPhone: { contains: q, mode: 'insensitive' } },
      ]
    }
    const rows = await prisma.ticket.findMany({ where: where as any, include: { attendee: true, ticketType: true, busSeats: { select: { label: true, passengerName: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } } }, orderBy: { issuedAt: 'desc' }, take: 5000 })
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Reservations')
    ws.columns = [
      { header: 'Reservation Code', key: 'reservationCode', width: 24 },
      { header: 'Name', key: 'name', width: 26 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Phone', key: 'phone', width: 18 },
      { header: 'Ticket Type', key: 'ticketType', width: 20 },
      { header: 'Seats', key: 'seats', width: 28 },
      { header: 'Seat Passengers', key: 'seatPassengers', width: 34 },
      { header: 'Amount', key: 'price', width: 12 },
      { header: 'Approval', key: 'approval', width: 14 },
      { header: 'Payment', key: 'payment', width: 14 },
      { header: 'Delivery', key: 'delivery', width: 14 },
      { header: 'Issued At', key: 'issuedAt', width: 22 },
    ]
    for (const t of rows as any[]) {
      const meta = (t.metadata ?? {}) as Record<string, any>
      const seats = t.busSeats ?? []
      ws.addRow({
        reservationCode: t.reservationCode ?? meta.reservationCode ?? '',
        name: t.reservationName ?? t.attendee?.name ?? '',
        email: t.reservationEmail ?? t.attendee?.email ?? '',
        phone: t.reservationPhone ?? t.attendee?.phone ?? '',
        ticketType: t.ticketType?.name ?? '',
        seats: seats.map((s: any) => `${s.bus?.name ? s.bus.name + ' ' : ''}${s.label}`).join(', '),
        seatPassengers: seats.map((s: any) => `${s.label}: ${s.passengerName ?? t.attendee?.name ?? ''}`).join('; '),
        price: Number(t.price ?? 0),
        approval: t.approvalStatus ?? meta.approval ?? '',
        payment: t.paymentStatus ?? meta.paymentStatus ?? '',
        delivery: t.deliveryStatus ?? '',
        issuedAt: t.issuedAt.toISOString(),
      })
    }
    const buf = await wb.xlsx.writeBuffer()
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', `attachment; filename="reservations-${eventId}.xlsx"`)
    return reply.send(Buffer.from(buf))
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

  app.get('/deliveries/export.xlsx', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'report.export', { eventId })
    const rows = await prisma.credentialDeliveryAttempt.findMany({
      where: { eventId },
      orderBy: { createdAt: 'desc' },
      take: 5000,
      include: { ticket: { select: { reservationCode: true, reservationName: true, reservationEmail: true } } },
    })
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Deliveries')
    ws.columns = [
      { header: 'Created At', key: 'createdAt', width: 22 }, { header: 'Reservation', key: 'reservation', width: 22 }, { header: 'Recipient', key: 'recipient', width: 28 },
      { header: 'Channel', key: 'channel', width: 12 }, { header: 'Status', key: 'status', width: 12 }, { header: 'Provider', key: 'provider', width: 16 },
      { header: 'Attempt', key: 'attempt', width: 10 }, { header: 'Error', key: 'error', width: 40 }, { header: 'Ticket ID', key: 'ticketId', width: 28 },
    ]
    for (const r of rows as any[]) {
      ws.addRow({ createdAt: r.createdAt.toISOString(), reservation: r.ticket?.reservationCode ?? '', recipient: r.recipient ?? r.ticket?.reservationEmail ?? '', channel: r.channel, status: r.status, provider: r.provider ?? '', attempt: r.attempt, error: r.error ?? '', ticketId: r.ticketId })
    }
    const buf = await wb.xlsx.writeBuffer()
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', `attachment; filename="deliveries-${eventId}.xlsx"`)
    return reply.send(Buffer.from(buf))
  })
}