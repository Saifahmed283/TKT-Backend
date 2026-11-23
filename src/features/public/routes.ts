import type { FastifyInstance } from 'fastify'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import {
  issueReservationCredential,
  reservationApprovalOf,
  reservationCodeOf,
  reservationPaymentOf,
  normalizeReservationEmail,
  normalizeReservationPhone,
  reservationStatePatch,
  type ReservationTicket,
} from '../reservations/service.js'
import { sendMail, ticketEmailShell } from '../../lib/mailer.js'
import { logActivity } from '../../lib/activity.js'
import { publish, channelFor } from '../../lib/realtime.js'
import { writeAudit } from '../../lib/audit.js'
import { AuditActions } from '../../lib/audit-actions.js'
import { canRedeemAccessCode, normalizeAccessCode, redeemAccessCode } from '../access-codes/service.js'
import { dispatchEventWebhooks } from '../integrations/dispatch.js'

// ─────────────────────────────────────────────────────────────
// Prize wheel — segment order must match the frontend wheel
// render order (index is used to land the animation).
// ─────────────────────────────────────────────────────────────
const WHEEL_SEGMENTS = [
  { reward: 'FIFTEEN_OFF', label: '15% off your ticket', weight: 30 },
  { reward: 'TWENTY_FIVE_OFF', label: '25% off your ticket', weight: 25 },
  { reward: 'GIFT', label: 'Gift from TKT', weight: 15 },
  { reward: 'RETRY', label: 'One more chance', weight: 15 },
  { reward: 'FIFTY_OFF', label: '50% off your ticket', weight: 10 },
  { reward: 'FREE_TICKET', label: 'FREE ticket — jackpot', weight: 5 },
] as const

const reservationSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().optional(),
  ticketTypeId: z.string(),
  paymentProviderId: z.string().optional().nullable(),
  paymentReference: z.string().max(200).optional().nullable(),
  paymentProofUrl: z.string().max(2_000_000).optional().nullable(),
  paymentAmount: z.coerce.number().nonnegative().optional().nullable(),
  busId: z.string().optional().nullable(),
  seatIds: z.array(z.string()).max(20).optional(),
  seatPassengers: z.array(z.object({ seatId: z.string(), name: z.string().min(2), email: z.string().email().optional().nullable(), phone: z.string().optional().nullable() })).optional(),
  holdToken: z.string().optional().nullable(),
})

const contactSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  orgName: z.string().optional(),
  eventType: z.string().optional(),
  eventDate: z.string().optional(),
  message: z.string().min(10),
})

function clientIp(req: { headers: Record<string, string | string[] | undefined>; ip?: string }): string {
  const fwd = req.headers['x-forwarded-for']
  const first = Array.isArray(fwd) ? fwd[0] : fwd
  return first?.split(',')[0]?.trim() || req.ip || 'unknown'
}

function reservationCode(): string {
  return `TKT-${randomBytes(4).toString('hex').toUpperCase()}`
}

function paidAmountMismatch(clientAmount: number | null, computedTotal: number): boolean {
  if (clientAmount == null) return false
  if (!Number.isFinite(clientAmount) || !Number.isFinite(computedTotal)) return true
  return Math.abs(clientAmount - computedTotal) > 0.01
}

// ─────────────────────────────────────────────────────────────
// Reservation availability — mirrors SAC's eventAvailability.
// States: upcoming | open | sold_out | locked | closed
// ─────────────────────────────────────────────────────────────
type RegSettings = { enabled?: boolean; open?: boolean; startAt?: string; endAt?: string }

function registrationWindow(reg: RegSettings): { start: string | null; end: string | null } {
  return {
    start: typeof reg.startAt === 'string' && reg.startAt ? reg.startAt : null,
    end: typeof reg.endAt === 'string' && reg.endAt ? reg.endAt : null,
  }
}

function availabilityOf(params: {
  reg: RegSettings
  now: Date
  eventStartAt: Date
  soldOut: boolean
}): 'upcoming' | 'open' | 'sold_out' | 'locked' | 'closed' {
  const { reg, now, eventStartAt, soldOut } = params
  const window = registrationWindow(reg)
  if (reg.enabled === false || reg.open === false) return 'locked'
  if (window.start && new Date(window.start).getTime() > now.getTime()) return 'upcoming'
  if (window.end && new Date(window.end).getTime() <= now.getTime()) return 'closed'
  if (now.getTime() >= eventStartAt.getTime()) return 'closed'
  if (soldOut) return 'sold_out'
  return 'open'
}

export async function publicRoutes(app: FastifyInstance) {
  // ── Events (upcoming / past works) ────────────────────────
  app.get('/events', async (req) => {
    const query = req.query as { scope?: string }
    const scope = query.scope === 'past' ? 'past' : 'upcoming'
    const now = new Date()

    const where: Prisma.EventWhereInput =
      scope === 'past'
        ? { status: { in: ['COMPLETED', 'ARCHIVED'] as any } }
        : { status: 'PUBLISHED' as any, startAt: { gte: now } }

    const events = await prisma.event.findMany({
      where,
      select: {
        id: true,
        name: true,
        description: true,
        type: true,
        status: true,
        startAt: true,
        endAt: true,
        timezone: true,
        venueName: true,
        venueAddress: true,
        coverImageUrl: true,
        settings: true,
        org: { select: { id: true, name: true, logoUrl: true } },
        ticketTypes: {
          where: { active: true },
          select: { id: true, name: true, description: true, category: true, price: true, currency: true, quota: true, salesStartAt: true, salesEndAt: true, isPublic: true, sortOrder: true, _count: { select: { tickets: true } } },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
        buses: {
          where: { isActive: true },
          select: { id: true, name: true, layout: true, seats: { select: { id: true, label: true, row: true, col: true, state: true, holderName: true } }, _count: { select: { seats: true } } },
          orderBy: { createdAt: 'asc' },
        },
        _count: { select: { attendees: true, tickets: true, accessLogs: true } },
      },
      orderBy: scope === 'past' ? { startAt: 'desc' } : { startAt: 'asc' },
    })

    return {
      data: events.map((e: (typeof events)[number]) => {
        const settings = (e.settings as Record<string, any>) ?? {}
        const reg = (settings.registration as RegSettings) ?? {}
        type EventTicketType = (typeof e.ticketTypes)[number]
        type PublicTicketType = { id: string; name: string; description: string | null; category: string | null; price: string; currency: string; quota: number | null; sold: number; remaining: number | null; soldOut: boolean; salesStartAt: string | null; salesEndAt: string | null; isPublic: boolean }
        const ticketTypes: PublicTicketType[] = e.ticketTypes.map((t: any) => {
          const sold = t._count.tickets
          const remaining = t.quota != null ? Math.max(0, t.quota - sold) : null
          return { id: t.id, name: t.name, description: t.description ?? null, category: t.category ?? null, price: t.price?.toString() ?? '0', currency: t.currency ?? 'EGP', quota: t.quota, sold, remaining, soldOut: t.quota != null && sold >= t.quota, salesStartAt: t.salesStartAt?.toISOString() ?? null, salesEndAt: t.salesEndAt?.toISOString() ?? null, isPublic: t.isPublic !== false }
        })
        const soldOut = ticketTypes.some((t: PublicTicketType) => t.quota != null) && ticketTypes.every((t: PublicTicketType) => t.soldOut)
        return {
          id: e.id,
          name: e.name,
          description: e.description,
          type: e.type,
          status: e.status,
          startAt: e.startAt,
          endAt: e.endAt,
          timezone: e.timezone,
          venueName: e.venueName,
          venueAddress: e.venueAddress,
          coverImageUrl: e.coverImageUrl,
          organization: e.org,
          registration: {
            open: reg.open !== false && reg.enabled !== false,
            window: registrationWindow(reg),
            availability: availabilityOf({ reg, now: new Date(), eventStartAt: e.startAt, soldOut }),
          },
          ticketTypes,
          attendeeCount: e._count.attendees,
          ticketCount: e._count.tickets,
          scanCount: e._count.accessLogs,
          buses: ((e as any).buses ?? []).map((b: any) => ({
            id: b.id, name: b.name, layout: b.layout, totalSeats: b._count?.seats ?? b.seats?.length ?? 0,
            availableSeats: (b.seats ?? []).filter((s: any) => s.state === 'AVAILABLE').length,
            seats: (b.seats ?? []).map((s: any) => ({ id: s.id, label: s.label, row: s.row, col: s.col, state: s.state, holderName: s.state === 'RESERVED' ? (s.holderName ?? 'Reserved') : null })),
          })),
        }
      }),
    }
  })

  app.get('/events/:eventId', async (req) => {
    const { eventId } = req.params as { eventId: string }
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        description: true,
        type: true,
        status: true,
        startAt: true,
        endAt: true,
        timezone: true,
        venueName: true,
        venueAddress: true,
        coverImageUrl: true,
        settings: true,
        org: { select: { id: true, name: true, logoUrl: true } },
        ticketTypes: {
          where: { active: true },
          select: { id: true, name: true, description: true, category: true, price: true, currency: true, quota: true, salesStartAt: true, salesEndAt: true, isPublic: true, sortOrder: true, _count: { select: { tickets: true } } },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
        paymentProviders: {
          where: { isActive: true },
          select: { id: true, name: true, accountName: true, accountNumber: true, paymentPhone: true, paymentLink: true, instructions: true, imageUrl: true },
          orderBy: { createdAt: 'asc' },
        },
        buses: {
          where: { isActive: true },
          select: { id: true, name: true, layout: true, seats: { select: { id: true, label: true, row: true, col: true, state: true, holderName: true } }, _count: { select: { seats: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!event || !['PUBLISHED', 'COMPLETED', 'ARCHIVED'].includes(event.status)) {
      throw errors.notFound('Event not found')
    }
    const settings = (event.settings as Record<string, any>) ?? {}
    const reg = (settings.registration as RegSettings) ?? {}
    const ticketTypes = event.ticketTypes.map((t: any) => {
      const sold = t._count.tickets
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        category: t.category ?? null,
        price: t.price?.toString() ?? '0',
        currency: t.currency ?? 'EGP',
        quota: t.quota,
        sold,
        remaining: t.quota != null ? Math.max(0, t.quota - sold) : null,
        soldOut: t.quota != null && sold >= t.quota,
        salesStartAt: t.salesStartAt?.toISOString() ?? null,
        salesEndAt: t.salesEndAt?.toISOString() ?? null,
        isPublic: t.isPublic !== false,
      }
    })
    const soldOut = ticketTypes.some((t: any) => t.quota != null) && ticketTypes.every((t: any) => t.soldOut)
    return {
      data: {
        id: event.id,
        name: event.name,
        description: event.description,
        type: event.type,
        status: event.status,
        startAt: event.startAt,
        endAt: event.endAt,
        timezone: event.timezone,
        venueName: event.venueName,
        venueAddress: event.venueAddress,
        coverImageUrl: event.coverImageUrl,
        organization: event.org,
        registration: {
          open: reg.open !== false && reg.enabled !== false,
          window: registrationWindow(reg),
          availability: availabilityOf({ reg, now: new Date(), eventStartAt: event.startAt, soldOut }),
        },
        ticketTypes,
        paymentProviders: (event as any).paymentProviders ?? [],
        buses: ((event as any).buses ?? []).map((b: any) => ({
          id: b.id, name: b.name, layout: b.layout, totalSeats: b._count?.seats ?? b.seats?.length ?? 0,
          availableSeats: (b.seats ?? []).filter((s: any) => s.state === 'AVAILABLE').length,
          seatPrice: b.seatPrice != null ? String(b.seatPrice) : '0',
          currency: b.currency ?? 'EGP',
          seats: (b.seats ?? []).map((s: any) => ({ id: s.id, label: s.label, row: s.row, col: s.col, state: s.state, holderName: s.state === 'RESERVED' ? (s.holderName ?? 'Reserved') : null, passengerName: s.passengerName ?? null })),
        })),
      },
    }
  })

  app.post('/events/:eventId/buses/:busId/hold', async (req) => {
    const { eventId, busId } = req.params as { eventId: string; busId: string }
    const body = z.object({ seatIds: z.array(z.string()).min(1).max(20), sessionId: z.string().min(8).max(120), holdMinutes: z.number().int().min(1).max(20).optional() }).parse(req.body)
    const holdExpiresAt = new Date(Date.now() + (body.holdMinutes ?? 10) * 60_000)
    const now = new Date()
    const seats = await prisma.$transaction(async (tx) => {
      const rows = await tx.busSeat.findMany({ where: { id: { in: body.seatIds }, busId, bus: { eventId, isActive: true } } })
      if (rows.length !== body.seatIds.length) throw errors.notFound('One or more seats not found')
      const blocked = rows.filter(s => !(s.state === 'AVAILABLE' || (s.state === 'HELD' && s.holdToken === body.sessionId && s.holdExpiresAt && s.holdExpiresAt > now)))
      if (blocked.length) throw errors.conflict(`Seats unavailable: ${blocked.map(s => s.label).join(', ')}`)
      for (const id of body.seatIds) {
        await tx.busSeat.update({ where: { id }, data: { state: 'HELD', holdToken: body.sessionId, holdExpiresAt, ticketId: null, groupId: null, reservedAt: null } })
      }
      return tx.busSeat.findMany({ where: { id: { in: body.seatIds } }, select: { id: true, label: true, row: true, col: true, state: true, holdExpiresAt: true } })
    })
    return { data: { holdToken: body.sessionId, holdExpiresAt: holdExpiresAt.toISOString(), seats } }
  })

  app.post('/events/:eventId/buses/:busId/release-hold', async (req) => {
    const { eventId, busId } = req.params as { eventId: string; busId: string }
    const body = z.object({ seatIds: z.array(z.string()).min(1).max(20), sessionId: z.string().min(8).max(120) }).parse(req.body)
    await prisma.busSeat.updateMany({
      where: { id: { in: body.seatIds }, busId, bus: { eventId }, state: 'HELD', holdToken: body.sessionId },
      data: { state: 'AVAILABLE', holdToken: null, holdExpiresAt: null, holderName: null, passengerName: null, passengerEmail: null, passengerPhone: null, groupId: null, ticketId: null, reservedAt: null },
    })
    return { data: { ok: true } }
  })

  // ── Public reservation ────────────────────────────────────
  app.post('/events/:eventId/reservations', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    const body = reservationSchema.parse(req.body)

    const event = await prisma.event.findUnique({ where: { id: eventId } })
    if (!event) throw errors.notFound('Event not found')
    if (event.status !== 'PUBLISHED') throw errors.badRequest('Reservations are closed for this event')
    if (event.startAt.getTime() <= Date.now()) throw errors.badRequest('This event has already started')

    const settings = (event.settings as Record<string, any>) ?? {}
    const reg = (settings.registration as RegSettings) ?? {}
    if (reg.enabled === false || reg.open === false) {
      throw errors.badRequest('Reservations are locked — this event is at capacity')
    }
    const window = registrationWindow(reg)
    if (window.start && new Date(window.start).getTime() > Date.now()) {
      throw errors.badRequest('Reservations open soon — check back shortly')
    }
    if (window.end && new Date(window.end).getTime() <= Date.now()) {
      throw errors.badRequest('Reservation window has closed')
    }

    const ticketType = await prisma.ticketType.findFirst({
      where: { id: body.ticketTypeId, eventId, active: true },
    }) as any
    if (!ticketType) throw errors.badRequest('Ticket type not found')
    if (ticketType.isPublic === false) throw errors.badRequest('This ticket type is not available for public reservation')
    const nowTs = Date.now()
    if (ticketType.salesStartAt && nowTs < ticketType.salesStartAt.getTime()) throw errors.badRequest('Ticket sales have not started yet')
    if (ticketType.salesEndAt && nowTs > ticketType.salesEndAt.getTime()) throw errors.badRequest('Ticket sales have ended')

    const soldCount = async () =>
      prisma.ticket.count({
        where: { ticketTypeId: ticketType.id, status: { in: ['ISSUED', 'ACTIVE', 'CONSUMED'] } },
      })
    if (ticketType.quota != null && (await soldCount()) >= ticketType.quota) {
      throw errors.badRequest('This ticket type has sold out')
    }

    const seatIds = Array.isArray(body.seatIds) ? [...new Set(body.seatIds)] : []
    const code = reservationCode()
    const ticketPrice = Number(ticketType.price ?? 0)
    const bus = seatIds.length
      ? await prisma.bus.findUnique({ where: { id: body.busId ?? '' }, select: { id: true, eventId: true, seatPrice: true, currency: true, isActive: true } }).catch(() => null)
      : null
    if (seatIds.length && (!body.busId || !bus || bus.eventId !== eventId || !bus.isActive)) {
      throw errors.badRequest('Valid bus is required for seat reservations')
    }
    const busSeatUnitPriceForPricing = seatIds.length ? Number(bus?.seatPrice ?? 0) : 0
    const computedTotalForPricing = (Number.isFinite(ticketPrice) ? ticketPrice : 0) + (seatIds.length * (Number.isFinite(busSeatUnitPriceForPricing) ? busSeatUnitPriceForPricing : 0))
    const clientPaymentAmount = body.paymentAmount == null ? null : Number(body.paymentAmount)
    if (paidAmountMismatch(clientPaymentAmount, computedTotalForPricing)) {
      throw errors.badRequest('Payment amount does not match ticket and seat total')
    }
    const paid = computedTotalForPricing > 0
    const state = reservationStatePatch({ paid, approved: !paid })
    const emailNorm = normalizeReservationEmail(body.email)
    const phoneNorm = normalizeReservationPhone(body.phone)
    let paymentProvider: { id: string; name: string } | null = null
    if (paid) {
      if (body.paymentProviderId) {
        paymentProvider = await prisma.paymentProvider.findFirst({ where: { id: body.paymentProviderId, eventId, isActive: true }, select: { id: true, name: true } })
        if (!paymentProvider) throw errors.badRequest('Payment provider not found')
      }
      if (body.paymentProofUrl && !(body.paymentProofUrl.startsWith('data:image/') || body.paymentProofUrl.startsWith('https://'))) {
        throw errors.badRequest('Payment proof must be an image data URL or https URL')
      }
    }

    let attendee: any
    let ticket: any
    let reservedSeats: { id: string; label: string; busId: string }[] = []
    try {
      const created = await prisma.$transaction(async (tx) => {
        const existing = await tx.ticket.findFirst({
          where: {
            eventId,
            reservationEmail: emailNorm,
            status: { in: ['ISSUED', 'ACTIVE', 'CONSUMED'] },
            approvalStatus: { in: ['PENDING', 'APPROVED'] },
          },
          include: { credential: { select: { code: true } } },
        })
        if (existing) {
          throw Object.assign(new Error('DUPLICATE_RESERVATION'), { existing })
        }

        let seatRows: any[] = []
        if (seatIds.length > 0) {
          if (!body.busId) throw errors.badRequest('busId is required when reserving seats')
          seatRows = await tx.busSeat.findMany({ where: { id: { in: seatIds }, busId: body.busId, bus: { eventId, isActive: true } } })
          if (seatRows.length !== seatIds.length) throw errors.badRequest('One or more seats are invalid')
          const now = new Date()
          const blocked = seatRows.filter((s: any) => {
            if (s.state === 'AVAILABLE') return false
            if (s.state === 'HELD' && body.holdToken && s.holdToken === body.holdToken && s.holdExpiresAt && s.holdExpiresAt > now) return false
            return true
          })
          if (blocked.length) throw errors.conflict(`Seats no longer available: ${blocked.map((s: any) => s.label).join(', ')}`)
        }

        const attendee = await tx.attendee.create({
          data: {
            eventId,
            name: body.name,
            email: body.email,
            phone: body.phone,
            status: paid ? 'REGISTERED' : 'CONFIRMED',
            metadata: { source: 'public' },
          },
        })

        const ticket = await tx.ticket.create({
          data: {
            eventId,
            attendeeId: attendee.id,
            ticketTypeId: ticketType.id,
            price: computedTotalForPricing,
            status: paid ? 'ISSUED' : 'ACTIVE',
            reservationCode: code,
            reservationEmail: emailNorm,
            reservationPhone: phoneNorm,
            reservationName: body.name.trim(),
            deliveryChannel: 'EMAIL',
            deliveryStatus: 'PENDING',
            paymentProviderId: paid ? (paymentProvider?.id ?? null) : null,
            paymentReference: paid ? (body.paymentReference?.trim() || null) : null,
            paymentProofUrl: paid ? (body.paymentProofUrl || null) : null,
            paymentAmount: paid ? computedTotalForPricing : null,
            paymentSubmittedAt: paid && (body.paymentReference || body.paymentProofUrl || body.paymentProviderId) ? new Date() : null,
            ...state,
            metadata: {
              reservationCode: code,
              channel: 'public',
              approval: paid ? 'PENDING' : 'APPROVED',
              email: body.email,
              phone: body.phone ?? null,
              name: body.name,
              paymentProviderId: paid ? (paymentProvider?.id ?? null) : null,
              paymentReference: paid ? (body.paymentReference?.trim() || null) : null,
              busId: body.busId ?? null,
              seatIds,
            },
          },
        })

        if (seatIds.length > 0) {
          const groupId = randomUUID()
          const now = new Date()
          for (const id of seatIds) {
            const passenger = body.seatPassengers?.find(p => p.seatId === id)
            const updated = await tx.busSeat.updateMany({
              where: { id, busId: body.busId!, OR: [{ state: 'AVAILABLE' }, { state: 'HELD', holdToken: body.holdToken ?? undefined, holdExpiresAt: { gt: now } }] },
              data: {
                state: 'RESERVED',
                holderName: body.name.trim(),
                passengerName: passenger?.name?.trim() || body.name.trim(),
                passengerEmail: passenger?.email?.trim() || body.email.trim(),
                passengerPhone: passenger?.phone?.trim() || body.phone?.trim() || null,
                groupId,
                ticketId: ticket.id,
                holdToken: null,
                holdExpiresAt: null,
                reservedAt: new Date(),
              },
            })
            if (updated.count !== 1) throw errors.conflict('Seat reservation conflict — please reselect seats')
          }
          seatRows = await tx.busSeat.findMany({ where: { id: { in: seatIds } } })
        }

        return { attendee, ticket, seatRows }
      })
      attendee = created.attendee
      ticket = created.ticket
      reservedSeats = (created.seatRows ?? []).map((s: any) => ({ id: s.id, label: s.label, busId: s.busId }))
    } catch (err: any) {
      if (err?.message === 'DUPLICATE_RESERVATION' && err.existing) {
        const existing = err.existing
        return reply.code(409).send({
          error: {
            code: 'RESERVATION_EXISTS',
            message: 'A reservation for this email already exists for this event.',
          },
          data: {
            reservationCode: reservationCodeOf(existing),
            approval: reservationApprovalOf(existing),
            paymentStatus: reservationPaymentOf(existing),
            qr: existing.credential?.code ?? null,
          },
        })
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw errors.conflict('A reservation for this email already exists for this event.')
      }
      throw err
    }

    // Free tickets → instant QR credential + email. Paid → pending approval/payment review.
    let qr: string | null = null
    if (paid) {
      const submittedPayment = Boolean(body.paymentReference || body.paymentProofUrl || paymentProvider)
      const sent = await sendMail({
        to: body.email,
        subject: `Reservation received — ${event.name}`,
        html: ticketEmailShell({
          preheader: `Your reservation for ${event.name} is ${submittedPayment ? 'awaiting payment review' : 'awaiting approval'}`,
          title: 'Reservation received',
          body: `Your reservation for <strong>${event.name}</strong> is in. ${submittedPayment ? 'Your payment proof was received and will be reviewed by the event team.' : 'The event team will review it shortly.'} Your QR ticket arrives by email once approved.`,
          rows: [
            { label: 'Event', value: event.name },
            { label: 'Ticket', value: ticketType.name },
            { label: 'Reservation', value: code },
            ...(paymentProvider ? [{ label: 'Payment method', value: paymentProvider.name }] : []),
            ...(body.paymentReference?.trim() ? [{ label: 'Payment reference', value: body.paymentReference.trim() }] : []),
            { label: 'Status', value: submittedPayment ? 'Awaiting payment review' : 'Awaiting approval' },
          ],
          footer: 'TKT · Control center for live events',
        }),
      })
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { deliveryStatus: sent.ok ? 'SENT' : 'FAILED', lastDeliveryAt: sent.ok ? new Date() : undefined, deliveryAttempts: { increment: 1 } },
      }).catch(() => {})
      await prisma.credentialDeliveryAttempt.create({
        data: {
          eventId,
          ticketId: ticket.id,
          channel: 'EMAIL',
          status: sent.ok ? 'SENT' : 'FAILED',
          recipient: body.email,
          provider: 'smtp',
          providerMessageId: sent.messageId ?? null,
          error: sent.error ?? null,
          attempt: 1,
          metadata: { source: 'public_reservation_pending', submittedPayment },
        } as any,
      }).catch(() => {})
      if (submittedPayment) {
        await writeAudit({
          organizationId: event.orgId, eventId, actorUserId: null,
          action: AuditActions.PAYMENT_SUBMITTED, resourceType: 'ticket', resourceId: ticket.id,
          newValue: { paymentProviderId: paymentProvider?.id ?? null, paymentReference: body.paymentReference?.trim() || null, hasProof: Boolean(body.paymentProofUrl) },
          sourceIp: req.ip,
        }).catch(() => {})
      }
    } else {
      const reservationTicket: ReservationTicket = {
        id: ticket.id,
        eventId,
        metadata: ticket.metadata,
        price: ticket.price,
        status: ticket.status,
        reservationCode: ticket.reservationCode,
        approvalStatus: ticket.approvalStatus,
        paymentStatus: ticket.paymentStatus,
        attendee: { id: attendee.id, name: body.name, email: body.email, phone: body.phone ?? null },
        ticketType: { id: ticketType.id, name: ticketType.name, price: ticketType.price },
      }
      const issued = await issueReservationCredential({
        event: { id: event.id, orgId: event.orgId, name: event.name, startAt: event.startAt, endAt: event.endAt, venueName: event.venueName },
        ticket: reservationTicket,
      })
      qr = issued.qrCode
    }

    const busSeatUnitPrice = reservedSeats.length ? Number(bus?.seatPrice ?? 0) : 0
    const computedTotal = (Number(ticketType.price ?? 0) || 0) + (reservedSeats.length * (Number.isFinite(busSeatUnitPrice) ? busSeatUnitPrice : 0))
    if (reservedSeats.length && Math.abs(computedTotal - computedTotalForPricing) > 0.01) {
      await prisma.busSeat.updateMany({
        where: { id: { in: reservedSeats.map((s) => s.id) }, holdToken: body.holdToken ?? undefined },
        data: { state: 'AVAILABLE', holderName: null, groupId: null, ticketId: null, passengerName: null, passengerEmail: null, passengerPhone: null, holdToken: null, holdExpiresAt: null },
      }).catch(() => null)
      throw errors.conflict('Seat pricing changed; please retry')
    }
    const seatSuffix = reservedSeats.length ? ` · seats ${reservedSeats.map((s) => s.label).join(', ')}` : ''
    logActivity(eventId, 'reservation', `${body.name} reserved ${ticketType.name} · ${code}${seatSuffix}`, body.name)
    publish(channelFor.reservation(eventId), 'reservation.created', {
      ticketId: ticket.id,
      reservationCode: code,
      approval: paid ? 'PENDING' : 'APPROVED',
      paymentStatus: paid ? 'PENDING' : 'NOT_REQUIRED',
    })
    void dispatchEventWebhooks(eventId, 'reservation.created', {
      ticketId: ticket.id,
      reservationCode: code,
      approval: paid ? 'PENDING' : 'APPROVED',
      paymentStatus: paid ? 'PENDING' : 'NOT_REQUIRED',
      attendee: { name: body.name, email: body.email },
      ticketType: { id: ticketType.id, name: ticketType.name },
    })

    // Capacity reached → lock the reservation pipeline.
    if (ticketType.quota != null && (await soldCount()) >= ticketType.quota) {
      await prisma.event.update({
        where: { id: eventId },
        data: { settings: { ...settings, registration: { ...reg, open: false } } },
      })
      publish(channelFor.reservation(eventId), 'reservation.capacity_locked', { ticketTypeId: ticketType.id })
    }

    return reply.code(201).send({
      data: {
        attendeeId: attendee.id,
        ticketId: ticket.id,
        reservationCode: code,
        price: computedTotal.toString(),
        approval: paid ? 'PENDING' : 'APPROVED',
        paymentStatus: paid ? 'PENDING' : 'NOT_REQUIRED',
        qr,
        seats: reservedSeats,
      },
    })
  })

  // ── Access code lookup / redemption (VIP / guest controls) ──
  app.get('/events/:eventId/access-codes/:code', async (req) => {
    const { eventId, code } = req.params as { eventId: string; code: string }
    const email = String((req.query as any)?.email ?? '').trim().toLowerCase()
    const phone = String((req.query as any)?.phone ?? '').trim()
    const normalized = normalizeAccessCode(code)
    if (!normalized) throw errors.badRequest('Invalid access code')

    const accessCode = await prisma.accessCode.findFirst({
      where: { eventId, code: normalized },
      select: { id: true, code: true, type: true, status: true, fullName: true, email: true, phone: true, attendeeCategory: true, ticketTypeId: true, maxRedemptions: true, redemptionCount: true, expiresAt: true },
    })
    if (!accessCode) throw errors.notFound('Access code not found')

    // Protect PII: if code is bound to identity, require matching email or phone query param.
    const boundEmail = String(accessCode.email ?? '').trim().toLowerCase()
    const boundPhone = String(accessCode.phone ?? '').replace(/\D/g, '')
    const claimedPhone = phone.replace(/\D/g, '')
    if (boundEmail || boundPhone) {
      const emailOk = boundEmail && email && email === boundEmail
      const phoneOk = boundPhone && claimedPhone.length >= 6 && claimedPhone === boundPhone
      if (!emailOk && !phoneOk) throw errors.notFound('Access code not found')
    }

    const redeemable = canRedeemAccessCode(accessCode)
    return {
      data: {
        id: accessCode.id,
        code: accessCode.code,
        type: accessCode.type,
        status: accessCode.status,
        fullName: accessCode.fullName,
        attendeeCategory: accessCode.attendeeCategory,
        ticketTypeId: accessCode.ticketTypeId,
        maxRedemptions: accessCode.maxRedemptions,
        redemptionCount: accessCode.redemptionCount,
        expiresAt: accessCode.expiresAt,
        redeemable: redeemable.ok,
        reason: redeemable.ok ? null : redeemable.reason,
      },
    }
  })

  app.post('/events/:eventId/access-codes/redeem', async (req) => {
    const { eventId } = req.params as { eventId: string }
    const body = z.object({
      code: z.string().min(3),
      name: z.string().min(2),
      email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
      phone: z.string().optional(),
    }).parse(req.body)

    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, status: true } })
    if (!event || !['PUBLISHED', 'LIVE', 'COMPLETED'].includes(event.status)) throw errors.notFound('Event not found')

    const result = await redeemAccessCode({
      eventId,
      codeRaw: body.code,
      fullName: body.name,
      email: body.email ?? null,
      phone: body.phone ?? null,
      sourceIp: req.ip,
    })
    return { data: { ok: true, reservationCode: result.ticket.reservationCode ?? null, credentialCode: result.credential.code, attendeeId: result.attendee.id, ticketId: result.ticket.id } }
  })

  // ── Reservation status lookup (re-fetch QR after approval) ──
  app.get('/events/:eventId/reservations/status', async (req) => {
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
        attendee: { select: { name: true, email: true } },
        ticketType: { select: { name: true, price: true } },
        paymentProvider: { select: { id: true, name: true } },
        credential: { select: { id: true, code: true, status: true } },
      },
    })
    if (!ticket) throw errors.notFound('Reservation not found')

    return {
      data: {
        reservationCode: reservationCodeOf(ticket) ?? code,
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
        seats: await prisma.busSeat.findMany({ where: { ticketId: ticket.id }, select: { id: true, label: true, busId: true } }).catch(() => []),
      },
    }
  })

  // ── Stats (About) ─────────────────────────────────────────
  app.get('/stats', async () => {
    const [
      eventsTotal,
      eventsUpcoming,
      eventsCompleted,
      attendees,
      tickets,
      scans,
      orgs,
      reviews,
    ] = await Promise.all([
      prisma.event.count({ where: { status: { in: ['PUBLISHED', 'LIVE', 'COMPLETED', 'ARCHIVED'] } } }),
      prisma.event.count({ where: { status: 'PUBLISHED', startAt: { gte: new Date() } } }),
      prisma.event.count({ where: { status: { in: ['COMPLETED', 'ARCHIVED'] } } }),
      prisma.attendee.count({ where: { status: { notIn: ['CANCELLED', 'BLOCKED'] } } }),
      prisma.ticket.count({ where: { status: { in: ['ISSUED', 'ACTIVE', 'CONSUMED'] } } }),
      prisma.accessLog.count({ where: { result: 'GRANTED' } }),
      prisma.organization.count({ where: { status: 'ACTIVE' } }),
      prisma.publicReview.aggregate({ where: { visible: true }, _count: true, _avg: { rating: true } }),
    ])

    const topEvents = await prisma.event.findMany({
      where: { status: { in: ['COMPLETED', 'ARCHIVED', 'LIVE', 'PUBLISHED'] } },
      select: {
        id: true,
        name: true,
        type: true,
        venueName: true,
        startAt: true,
        _count: { select: { attendees: true, accessLogs: true } },
      },
      orderBy: { attendees: { _count: 'desc' } },
      take: 4,
    })

    return {
      data: {
        eventsTotal,
        eventsUpcoming,
        eventsCompleted,
        attendees,
        tickets,
        scans,
        orgs,
        reviews: { count: reviews._count, average: reviews._avg.rating ?? 0 },
        topEvents: topEvents.map((e: (typeof topEvents)[number]) => ({
          id: e.id,
          name: e.name,
          type: e.type,
          venueName: e.venueName,
          startAt: e.startAt,
          attendeeCount: e._count.attendees,
          scanCount: e._count.accessLogs,
        })),
      },
    }
  })

  // ── Reviews ───────────────────────────────────────────────
  app.get('/reviews', async () => {
    const reviews = await prisma.publicReview.findMany({
      where: { visible: true },
      select: { id: true, author: true, role: true, content: true, rating: true, eventName: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    return { data: reviews }
  })

  // ── Contact ───────────────────────────────────────────────
  app.post('/contact', async (req, reply) => {
    const body = contactSchema.parse(req.body)
    const message = await prisma.contactMessage.create({
      data: {
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

  // ── Prize wheel ───────────────────────────────────────────
  app.get('/wheel/segments', async () => {
    return {
      data: WHEEL_SEGMENTS.map((s) => ({ reward: s.reward, label: s.label })),
    }
  })

  app.get('/wheel/status', async (req) => {
    const ip = clientIp(req)
    const record = await prisma.wheelSpin.findUnique({ where: { ip } })
    if (!record) {
      return { data: { canSpin: true, spinsUsed: 0, remainingSpins: 1, lastReward: null, lastLabel: null, lastCode: null } }
    }
    const maxSpins = record.lastReward === 'RETRY' ? 2 : 1
    return {
      data: {
        canSpin: record.spins < maxSpins,
        spinsUsed: record.spins,
        remainingSpins: Math.max(0, maxSpins - record.spins),
        lastReward: record.lastReward,
        lastLabel: record.lastLabel,
        lastCode: record.lastCode,
      },
    }
  })

  app.post('/wheel/spin', async (req, reply) => {
    const ip = clientIp(req)
    const record = await prisma.wheelSpin.upsert({ where: { ip }, update: {}, create: { ip } })
    const maxSpins = record.lastReward === 'RETRY' ? 2 : 1
    if (record.spins >= maxSpins) {
      return reply.code(409).send({
        error: { code: 'WHEEL_LIMIT', message: 'Your free spin is used up. Come back for the next campaign.' },
      })
    }

    const total = WHEEL_SEGMENTS.reduce((sum, s) => sum + s.weight, 0)
    let roll = Math.random() * total
    let index = WHEEL_SEGMENTS.length - 1
    for (let i = 0; i < WHEEL_SEGMENTS.length; i++) {
      const seg = WHEEL_SEGMENTS[i]!
      roll -= seg.weight
      if (roll <= 0) {
        index = i
        break
      }
    }
    const segment = WHEEL_SEGMENTS[index]!
    const code = segment.reward === 'RETRY' ? null : reservationCode()
    const updated = await prisma.wheelSpin.update({
      where: { id: record.id },
      data: { spins: record.spins + 1, lastReward: segment.reward, lastLabel: segment.label, lastCode: code },
    })

    const remaining = segment.reward === 'RETRY' && record.spins === 0 ? 1 : 0
    return reply.send({
      data: {
        index,
        reward: segment.reward,
        label: segment.label,
        code,
        spinsUsed: updated.spins,
        remainingSpins: remaining,
      },
    })
  })
}


