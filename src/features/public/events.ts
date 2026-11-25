import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { availabilityOf, registrationWindow, type RegSettings } from './schemas.js'

export async function eventRoutes(app: FastifyInstance) {
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
        category: true,
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
          select: { id: true, name: true, description: true, category: true, tier: true, price: true, currency: true, quota: true, salesStartAt: true, salesEndAt: true, isPublic: true, transportIncluded: true, sortOrder: true, _count: { select: { tickets: true } } },
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
        type PublicTicketType = { id: string; name: string; description: string | null; category: string | null; tier: string | null; price: string; currency: string; quota: number | null; sold: number; remaining: number | null; soldOut: boolean; salesStartAt: string | null; salesEndAt: string | null; isPublic: boolean; transportIncluded: boolean }
        const ticketTypes: PublicTicketType[] = e.ticketTypes.map((t: any) => {
          const sold = t._count.tickets
          const remaining = t.quota != null ? Math.max(0, t.quota - sold) : null
          return { id: t.id, name: t.name, description: t.description ?? null, category: t.category ?? null, tier: t.tier ?? null, price: t.price?.toString() ?? '0', currency: t.currency ?? 'EGP', quota: t.quota, sold, remaining, soldOut: t.quota != null && sold >= t.quota, salesStartAt: t.salesStartAt?.toISOString() ?? null, salesEndAt: t.salesEndAt?.toISOString() ?? null, isPublic: t.isPublic !== false, transportIncluded: t.transportIncluded === true }
        })
        const soldOut = ticketTypes.some((t: PublicTicketType) => t.quota != null) && ticketTypes.every((t: PublicTicketType) => t.soldOut)
        return {
          id: e.id,
          name: e.name,
          description: e.description,
          type: e.type,
          category: e.category ?? null,
          taxonomy: settings.taxonomy ?? null,
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
        category: true,
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
          select: { id: true, name: true, description: true, category: true, tier: true, price: true, currency: true, quota: true, salesStartAt: true, salesEndAt: true, isPublic: true, transportIncluded: true, sortOrder: true, _count: { select: { tickets: true } } },
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
        tier: t.tier ?? null,
        price: t.price?.toString() ?? '0',
        currency: t.currency ?? 'EGP',
        quota: t.quota,
        sold,
        remaining: t.quota != null ? Math.max(0, t.quota - sold) : null,
        soldOut: t.quota != null && sold >= t.quota,
        salesStartAt: t.salesStartAt?.toISOString() ?? null,
        salesEndAt: t.salesEndAt?.toISOString() ?? null,
        isPublic: t.isPublic !== false,
        transportIncluded: t.transportIncluded === true,
      }
    })
    const soldOut = ticketTypes.some((t: any) => t.quota != null) && ticketTypes.every((t: any) => t.soldOut)
    return {
      data: {
        id: event.id,
        name: event.name,
        description: event.description,
        type: event.type,
        category: event.category ?? null,
        taxonomy: settings.taxonomy ?? null,
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

}
