import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { resendReservationCredential, reservationApprovalOf, reservationCodeOf, reservationPaymentOf, normalizeReservationEmail } from '../reservations/service.js'
import { hashAccessToken } from './schemas.js'

export async function reservationStatusRoutes(app: FastifyInstance) {
// ── Reservation status lookup (re-fetch QR after approval) ──
  app.get('/events/:eventId/reservations/status', {
    // The modal auto-polls every 5s while pending (~120 calls / 10 min), then
    // stops at a decision or when the modal closes.
    config: { rateLimit: { max: 120, timeWindow: '10 minutes' } },
  }, async (req) => {
    const { eventId } = req.params as { eventId: string }
    const { code } = req.query as { code?: string }
    if (!code) throw errors.badRequest('Missing reservation code')

    const ticket = await prisma.ticket.findFirst({
      where: {
        eventId,
        OR: [
          { reservationCode: code },
          { metadata: { path: ['reservationCode'], equals: code } },
        ],
      },
      include: {
        attendee: { select: { id: true, name: true, email: true } },
        ticketType: { select: { name: true, price: true } },
        paymentProvider: { select: { id: true, name: true } },
        credential: { select: { id: true, code: true, status: true } },
      },
    })
    if (!ticket) throw errors.notFound('Reservation not found')

    return {
      data: {
        reservationCode: reservationCodeOf(ticket) ?? code,
        ticketId: ticket.id,
        attendeeId: ticket.attendee.id,
        approval: reservationApprovalOf(ticket),
        paymentStatus: reservationPaymentOf(ticket),
        paymentProvider: (ticket as any).paymentProvider ?? null,
        paymentReference: (ticket as any).paymentReference ?? null,
        paymentReviewNote: (ticket as any).paymentReviewNote ?? null,
        deliveryStatus: (ticket as any).deliveryStatus ?? null,
        ticketStatus: ticket.status,
        price: ticket.price?.toString() ?? '0',
        ticketName: ticket.ticketType.name,
        attendeeName: ticket.attendee.name,
        qr: ticket.credential?.code ?? null,
        seats: await prisma.busSeat.findMany({ where: { ticketId: ticket.id }, select: { id: true, label: true, busId: true, passengerName: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } }).catch(() => []),
      },
    }
  })

  // ── Public ticket resend (duplicate-reservation recovery) ───
  // Deliberately keyed by reservation code + email, not a ticket id: a public
  // caller has neither a session nor a ticket id, and must not be able to
  // enumerate other attendees' reservations.
  app.post('/events/:eventId/reservations/resend', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
  }, async (req) => {
    const { eventId } = req.params as { eventId: string }
    const body = z.object({ reservationCode: z.string().min(3), email: z.string().email() }).parse(req.body)
    const code = body.reservationCode.trim()
    const emailNorm = normalizeReservationEmail(body.email)
    if (!emailNorm) throw errors.badRequest('Email is required')

    const ticket = await prisma.ticket.findFirst({
      where: {
        eventId,
        reservationEmail: emailNorm,
        OR: [
          { reservationCode: code },
          { metadata: { path: ['reservationCode'], equals: code } },
        ],
      },
      select: { id: true },
    })
    // Same response for unknown code and unknown email — no existence leak.
    if (!ticket) throw errors.notFound('Reservation not found')

    const result = await resendReservationCredential({
      eventId,
      ticketId: ticket.id,
      actorUserId: null,
      actorName: 'Public reservation',
      toEmail: emailNorm,
    })
    return {
      data: {
        ok: result.deliveryOk,
        deliveryStatus: result.ticket.deliveryStatus,
      },
    }
  })

}
