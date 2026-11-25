import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { AppError, errors } from '../../lib/errors.js'
import { resendReservationCredential, reservationApprovalOf, reservationCodeOf, reservationPaymentOf, normalizeReservationEmail } from '../reservations/service.js'
import { hashAccessToken } from './schemas.js'
import { appleWalletIsConfigured, createAppleWalletPass } from '../wallet/appleWallet.js'
import { canIssueReservationCredential } from '../reservations/service.js'

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
        ticketType: { select: { name: true, price: true } },
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
        ticketName: ticket.ticketType.name,
        attendeeName: ticket.attendee.name,
        qr: ticket.credential?.code ?? null,
        walletPassAvailable: appleWalletIsConfigured(),
        seats: await prisma.busSeat.findMany({ where: { ticketId: ticket.id }, select: { id: true, label: true, busId: true, passengerName: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } }).catch(() => []),
      },
    }
  })

  // ── Apple Wallet pass download ─────────────────────────────
  // The signed pass is created only for the reservation owner and only
  // after the credential is active. A display code by itself is not access.
  app.post('/events/:eventId/reservations/wallet', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    const body = z.object({
      code: z.string().min(3),
      token: z.string().min(16).optional(),
      email: z.string().email().optional(),
    }).refine((value) => Boolean(value.token || value.email), {
      message: 'A reservation access token or booking email is required',
    }).parse(req.body)

    const ticket = await prisma.ticket.findFirst({
      where: { eventId, reservationCode: body.code },
      select: {
        id: true,
        status: true,
        reservationCode: true,
        reservationEmail: true,
        accessTokenHash: true,
        accessTokenExpiresAt: true,
        approvalStatus: true,
        paymentStatus: true,
        metadata: true,
        attendee: { select: { name: true } },
        ticketType: { select: { name: true } },
        credential: { select: { code: true, status: true } },
        event: { select: { id: true, name: true, startAt: true, endAt: true, timezone: true, venueName: true, venueAddress: true } },
        busSeats: {
          select: { label: true, bus: { select: { name: true } } },
          orderBy: { label: 'asc' },
        },
      },
    })
    if (!ticket) throw errors.notFound('Reservation not found')

    const tokenOk = Boolean(
      body.token
      && ticket.accessTokenHash
      && hashAccessToken(body.token) === ticket.accessTokenHash
      && (!ticket.accessTokenExpiresAt || ticket.accessTokenExpiresAt > new Date()),
    )
    const emailNorm = normalizeReservationEmail(body.email)
    const emailOk = Boolean(emailNorm && emailNorm === ticket.reservationEmail)
    if (!tokenOk && !emailOk) throw errors.notFound('Reservation not found')

    if (!canIssueReservationCredential(ticket as any) || ticket.credential?.status !== 'ACTIVE') {
      throw errors.conflict('Apple Wallet pass is available after the ticket has been approved and issued')
    }
    if (!appleWalletIsConfigured()) {
      return reply.code(503).send({
        error: {
          code: 'APPLE_WALLET_NOT_CONFIGURED',
          message: 'Apple Wallet signing is not configured for this environment.',
        },
      })
    }

    try {
      const metadata = (ticket.metadata && typeof ticket.metadata === 'object')
        ? ticket.metadata as Record<string, unknown>
        : {}
      const pass = await createAppleWalletPass({
        ticketId: ticket.id,
        reservationCode: ticket.reservationCode ?? body.code,
        credentialCode: ticket.credential.code,
        attendeeName: ticket.attendee.name,
        ticketTypeName: ticket.ticketType.name,
        event: ticket.event,
        seats: ticket.busSeats.map((seat) => ({ label: seat.label, busName: seat.bus.name })),
        design: metadata.ticketDesign as any,
      })
      const filename = `TKT-${(ticket.reservationCode ?? body.code).replace(/[^a-zA-Z0-9-]/g, '')}.pkpass`
      return reply
        .type('application/vnd.apple.pkpass')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Cache-Control', 'private, no-store')
        .send(pass)
    } catch (error) {
      req.log.error({ error, eventId, ticketId: ticket.id }, 'apple_wallet.pass_generation_failed')
      return reply.code(500).send({
        error: {
          code: 'APPLE_WALLET_GENERATION_FAILED',
          message: 'The Apple Wallet pass could not be generated. Please try again later.',
        },
      })
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
