import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/db.js'

export async function statsRoutes(app: FastifyInstance) {
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
}
