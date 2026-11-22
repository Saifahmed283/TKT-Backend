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
          select: { id: true, name: true, price: true, quota: true, _count: { select: { tickets: true } } },
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
        type PublicTicketType = { id: string; name: string; price: string; quota: number | null; sold: number; remaining: number | null; soldOut: boolean }
        const ticketTypes: PublicTicketType[] = e.ticketTypes.map((t: EventTicketType) => {
          const sold = t._count.tickets
          const remaining = t.quota != null ? Math.max(0, t.quota - sold) : null
          return { id: t.id, name: t.name, price: t.price?.toString() ?? '0', quota: t.quota, sold, remaining, soldOut: t.quota != null && sold >= t.quota }
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
          select: { id: true, name: true, description: true, price: true, quota: true, _count: { select: { tickets: true } } },
        },
      },
    })
    if (!event || !['PUBLISHED', 'COMPLETED', 'ARCHIVED'].includes(event.status)) {
      throw errors.notFound('Event not found')
    }
    const settings = (event.settings as Record<string, any>) ?? {}
    const reg = (settings.registration as RegSettings) ?? {}
    type DetailTicketType = (typeof event.ticketTypes)[number]
    type DetailPublicTicket = { id: string; name: string; description: string | null; price: string; quota: number | null; sold: number; remaining: number | null; soldOut: boolean }
    const ticketTypes: DetailPublicTicket[] = event.ticketTypes.map((t: DetailTicketType) => {
      const sold = t._count.tickets
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        price: t.price?.toString() ?? '0',
        quota: t.quota,
        sold,
        remaining: t.quota != null ? Math.max(0, t.quota - sold) : null,
        soldOut: t.quota != null && sold >= t.quota,
      }
    })
    const soldOut = ticketTypes.some((t: DetailPublicTicket) => t.quota != null) && ticketTypes.every((t: DetailPublicTicket) => t.soldOut)
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
      },
    }
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
    })
    if (!ticketType) throw errors.badRequest('Ticket type not found')

    const soldCount = async () =>
      prisma.ticket.count({
        where: { ticketTypeId: ticketType.id, status: { in: ['ISSUED', 'ACTIVE', 'CONSUMED'] } },
      })
    if (ticketType.quota != null && (await soldCount()) >= ticketType.quota) {
      throw errors.badRequest('This ticket type has sold out')
    }

    const code = reservationCode()
    const price = Number(ticketType.price ?? 0)
    const paid = Number.isFinite(price) && price > 0
    const state = reservationStatePatch({ paid, approved: !paid })
    const emailNorm = normalizeReservationEmail(body.email)
    const phoneNorm = normalizeReservationPhone(body.phone)

    let attendee: any
    let ticket: any
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
            price: ticketType.price,
            status: paid ? 'ISSUED' : 'ACTIVE',
            reservationCode: code,
            reservationEmail: emailNorm,
            reservationPhone: phoneNorm,
            reservationName: body.name.trim(),
            deliveryChannel: 'EMAIL',
            deliveryStatus: 'PENDING',
            ...state,
            metadata: {
              reservationCode: code,
              channel: 'public',
              approval: paid ? 'PENDING' : 'APPROVED',
              email: body.email,
              phone: body.phone ?? null,
              name: body.name,
            },
          },
        })

        return { attendee, ticket }
      })
      attendee = created.attendee
      ticket = created.ticket
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

    // Free tickets → instant QR credential + email. Paid → pending approval.
    let qr: string | null = null
    if (paid) {
      const sent = await sendMail({
        to: body.email,
        subject: `Reservation received — ${event.name}`,
        html: ticketEmailShell({
          preheader: `Your reservation for ${event.name} is awaiting approval`,
          title: 'Reservation received',
          body: `Your reservation for <strong>${event.name}</strong> is in. The event team will review it shortly — your QR ticket arrives by email once approved.`,
          rows: [
            { label: 'Event', value: event.name },
            { label: 'Ticket', value: ticketType.name },
            { label: 'Reservation', value: code },
            { label: 'Status', value: 'Awaiting approval' },
          ],
          footer: 'TKT · Control center for live events',
        }),
      })
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { deliveryStatus: sent ? 'SENT' : 'FAILED', lastDeliveryAt: sent ? new Date() : undefined, deliveryAttempts: { increment: 1 } },
      }).catch(() => {})
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

    logActivity(eventId, 'reservation', `${body.name} reserved ${ticketType.name} · ${code}`, body.name)

    // Capacity reached → lock the reservation pipeline.
    if (ticketType.quota != null && (await soldCount()) >= ticketType.quota) {
      await prisma.event.update({
        where: { id: eventId },
        data: { settings: { ...settings, registration: { ...reg, open: false } } },
      })
    }

    return reply.code(201).send({
      data: {
        attendeeId: attendee.id,
        ticketId: ticket.id,
        reservationCode: code,
        price: ticketType.price?.toString() ?? '0',
        approval: paid ? 'PENDING' : 'APPROVED',
        paymentStatus: paid ? 'PENDING' : 'NOT_REQUIRED',
        qr,
      },
    })
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
        credential: { select: { id: true, code: true, status: true } },
      },
    })
    if (!ticket) throw errors.notFound('Reservation not found')

    return {
      data: {
        reservationCode: reservationCodeOf(ticket) ?? code,
        approval: reservationApprovalOf(ticket),
        paymentStatus: reservationPaymentOf(ticket),
        ticketStatus: ticket.status,
        price: ticket.price?.toString() ?? '0',
        ticketName: ticket.ticketType.name,
        attendeeName: ticket.attendee.name,
        qr: ticket.credential?.code ?? null,
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
