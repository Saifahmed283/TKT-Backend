import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { AppError, errors } from '../../lib/errors.js'
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
    const { code, email, token } = req.query as { code?: string; email?: string; token?: string }
    if (!code) throw errors.badRequest('Missing reservation code')

    const ticket = await prisma.ticket.findFirst({
      where: {
        eventId,
        OR: [
          { reservationCode: code },
          { metadata: { path: ['reservationCode'], equals: code } },
        ],
      },
      select: {
        id: true,
        status: true,
        price: true,
        reservationCode: true,
        reservationEmail: true,
        metadata: true,
        approvalStatus: true,
        paymentStatus: true,
        paymentReference: true,
        paymentReviewNote: true,
        deliveryStatus: true,
        paymentProvider: { select: { id: true, name: true } },
        accessTokenHash: true,
        accessTokenExpiresAt: true,
        attendee: { select: { id: true, name: true, email: true } },
        ticketType: { select: { name: true, price: true, currency: true } },
        credential: { select: { id: true, code: true, status: true } },
      },
    })
    if (!ticket) throw errors.notFound('Reservation not found')

    // A display code alone is not proof of entitlement. Require either the
    // 128-bit capability returned at creation or the matching reservation
    // email; both together with the random code are needed for email links.
    const tokenOk = Boolean(
      token &&
      ticket.accessTokenHash &&
      hashAccessToken(token) === ticket.accessTokenHash &&
      (!ticket.accessTokenExpiresAt || ticket.accessTokenExpiresAt > new Date()),
    )
    const emailNorm = normalizeReservationEmail(email)
    const emailOk = Boolean(emailNorm && emailNorm === ticket.reservationEmail)
    if (!tokenOk && !emailOk) throw errors.notFound('Reservation not found')

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
        currency: ticket.ticketType.currency ?? 'EGP',
        ticketName: ticket.ticketType.name,
        attendeeName: ticket.attendee.name,
        qr: ticket.credential?.code ?? null,
        seats: await prisma.busSeat.findMany({ where: { ticketId: ticket.id }, select: { id: true, label: true, busId: true, passengerName: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } }).catch(() => []),
      },
    }
  })

  // ── Device-friendly PWA ticket lookup ─────────────────────
  // The reservation code is a locator, not a secret. Require the matching
  // email as a second factor and return only the minimum ticket display data.
  app.post('/reservations/status', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (req) => {
    const query = z.object({
      code: z.string().trim().min(3).max(80),
      email: z.string().email().max(254),
    }).parse(req.body)
    const email = normalizeReservationEmail(query.email)
    const ticket = await prisma.ticket.findFirst({
      where: {
        OR: [
          { reservationCode: query.code },
          { metadata: { path: ['reservationCode'], equals: query.code } },
        ],
      },
      select: {
        id: true, status: true, price: true, reservationCode: true,
        reservationEmail: true, metadata: true, approvalStatus: true, paymentStatus: true,
        attendee: { select: { name: true } },
        ticketType: { select: { name: true, price: true, currency: true } },
        event: { select: { name: true, startAt: true, endAt: true, timezone: true, venueName: true, venueAddress: true } },
        credential: { select: { code: true, status: true, validUntil: true } },
        busSeats: {
          select: { id: true, label: true, passengerName: true, bus: { select: { name: true } } },
          orderBy: { label: 'asc' },
        },
      },
    })
    // Do not reveal whether the code exists when the email does not match.
    if (!ticket || !email || email !== normalizeReservationEmail(ticket.reservationEmail)) {
      throw errors.notFound('Reservation not found')
    }
    const approval = reservationApprovalOf(ticket as any)
    const paymentStatus = reservationPaymentOf(ticket as any)
    const credentialActive = Boolean(
      ticket.credential?.status === 'ACTIVE' &&
      (!ticket.credential.validUntil || ticket.credential.validUntil > new Date()) &&
      String(ticket.status).toUpperCase() !== 'CANCELLED',
    )
    const qr = approval === 'APPROVED' && credentialActive ? ticket.credential?.code ?? null : null
    return {
      data: {
        reservationCode: reservationCodeOf(ticket as any) ?? query.code,
        attendeeName: ticket.attendee.name,
        eventName: ticket.event.name,
        eventStartAt: ticket.event.startAt,
        eventEndAt: ticket.event.endAt,
        timezone: ticket.event.timezone,
        venueName: ticket.event.venueName,
        venueAddress: ticket.event.venueAddress,
        ticketName: ticket.ticketType.name,
        price: ticket.price?.toString() ?? ticket.ticketType.price?.toString() ?? '0',
        currency: ticket.ticketType.currency ?? 'EGP',
        approval,
        paymentStatus,
        ticketStatus: ticket.status,
        credentialStatus: ticket.credential?.status ?? 'NOT_ISSUED',
        credentialValidUntil: ticket.credential?.validUntil ?? null,
        qr,
        seats: ticket.busSeats.map((seat) => ({
          id: seat.id, label: seat.label, passengerName: seat.passengerName, busName: seat.bus?.name ?? null,
        })),
      },
    }
  })

  // ── Public ticket resend (duplicate-reservation recovery) ───
  // Email-only recovery is supported for duplicate submissions where the
  // original code was never shown. Responses stay generic so the endpoint
  // cannot be used to enumerate attendees.
  app.post('/events/:eventId/reservations/resend', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
  }, async (req) => {
    const { eventId } = req.params as { eventId: string }
    const body = z.object({
      reservationCode: z.string().min(3).optional(),
      email: z.string().email(),
    }).parse(req.body)
    const code = body.reservationCode?.trim()
    const emailNorm = normalizeReservationEmail(body.email)
    if (!emailNorm) throw errors.badRequest('Email is required')

    const ticket = await prisma.ticket.findFirst({
      where: {
        eventId,
        reservationEmail: emailNorm,
        ...(code
          ? {
              OR: [
                { reservationCode: code },
                { metadata: { path: ['reservationCode'], equals: code } },
              ],
            }
          : {}),
      },
      select: { id: true },
      orderBy: { issuedAt: 'desc' },
    })
    // Same generic response for unknown email/code — no existence leak.
    if (!ticket) return { data: { ok: true, deliveryStatus: null } }

    let result: Awaited<ReturnType<typeof resendReservationCredential>>
    try {
      result = await resendReservationCredential({
        eventId,
        ticketId: ticket.id,
        actorUserId: null,
        actorName: 'Public reservation',
        toEmail: emailNorm,
      })
    } catch (error) {
      // An ineligible or missing reservation must look identical to an unknown
      // email. Only these two conflicts disclose existence/status here.
      if (error instanceof AppError && (error.statusCode === 404 || error.statusCode === 409)) {
        return { data: { ok: true, deliveryStatus: null } }
      }
      throw error
    }
    return {
      data: {
        ok: result.deliveryOk,
        deliveryStatus: result.ticket.deliveryStatus,
      },
    }
  })

}
