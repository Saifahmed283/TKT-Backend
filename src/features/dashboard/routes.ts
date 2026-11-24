import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { updateDbContext } from '../../lib/dbContext.js'

const ACTIVE_WINDOW_MS = 5 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const RECENT_LIMIT = 60

/**
 * Platform dashboard — aggregates KPIs across every event the current
 * user can see (org-admin events + event memberships, or all events for
 * a super admin). Mirrors the SAC admin stats dashboard shape:
 * guests, check-in, pending entries, devices, today scans, plus a 14-day
 * public-reservation series and a live scan feed.
 */
export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        platformRole: true,
        orgMemberships: { select: { orgId: true, role: true } },
        eventMemberships: { select: { eventId: true } },
      },
    })
    if (!user) throw errors.unauthorized()

    const adminOrgIds = user.orgMemberships
      .filter((m: (typeof user.orgMemberships)[number]) => m.role === 'OWNER' || m.role === 'ADMIN')
      .map((m: (typeof user.orgMemberships)[number]) => m.orgId)
    const memberEventIds = user.eventMemberships.map((m: (typeof user.eventMemberships)[number]) => m.eventId)
    const eventWhere =
      user.platformRole === 'super_admin'
        ? {}
        : { OR: [{ orgId: { in: adminOrgIds } }, { id: { in: memberEventIds } }] }

    const events = await prisma.event.findMany({ where: eventWhere, select: { id: true } })
    const ids = events.map((e: (typeof events)[number]) => e.id)
    await updateDbContext({
      userId: req.user.id,
      orgId: adminOrgIds[0],
      eventIds: ids,
      isSuperAdmin: user.platformRole === 'super_admin',
    })

    const empty = {
      kpis: {
        events: ids.length,
        totalGuests: 0,
        checkedIn: 0,
        pendingEntry: 0,
        totalDevices: 0,
        activeDevices: 0,
        todayScans: 0,
        validScans: 0,
        invalidScans: 0,
      },
      reservations: [] as { date: string; count: number }[],
      recentActivity: [] as unknown[],
    }
    if (ids.length === 0) return { data: empty }

    const since = new Date(Date.now() - DAY_MS)
    const activeSince = new Date(Date.now() - ACTIVE_WINDOW_MS)
    const feedStart = new Date(Date.now() - 14 * DAY_MS)

    const [
      totalGuests,
      checkedIn,
      pendingEntry,
      totalDevices,
      activeDevices,
      todayScans,
      validScans,
      invalidScans,
      publicTickets,
      recentLogs,
    ] = await Promise.all([
      prisma.attendee.count({ where: { eventId: { in: ids } } }),
      prisma.attendee.count({ where: { eventId: { in: ids }, status: 'CHECKED_IN' } }),
      prisma.ticket.count({
        where: { eventId: { in: ids }, metadata: { path: ['approval'], equals: 'PENDING' } },
      }),
      prisma.device.count({ where: { eventId: { in: ids } } }),
      prisma.device.count({ where: { eventId: { in: ids }, lastSeenAt: { gte: activeSince } } }),
      prisma.accessLog.count({ where: { eventId: { in: ids }, timestamp: { gte: since } } }),
      prisma.accessLog.count({ where: { eventId: { in: ids }, timestamp: { gte: since }, result: 'GRANTED' } }),
      prisma.accessLog.count({ where: { eventId: { in: ids }, timestamp: { gte: since }, result: 'DENIED' } }),
      prisma.ticket.findMany({
        where: { eventId: { in: ids }, issuedAt: { gte: feedStart }, metadata: { path: ['channel'], equals: 'public' } },
        select: { issuedAt: true },
      }),
      prisma.accessLog.findMany({
        where: { eventId: { in: ids } },
        orderBy: { timestamp: 'desc' },
        take: RECENT_LIMIT,
        select: {
          id: true,
          result: true,
          reason: true,
          timestamp: true,
          offline: true,
          event: { select: { id: true, name: true } },
          area: { select: { name: true } },
          operator: { select: { name: true } },
          attendee: { select: { name: true } },
          credential: { select: { code: true } },
        },
      }),
    ])

    const counts: Record<string, number> = {}
    for (const t of publicTickets) {
      const day = t.issuedAt.toISOString().slice(0, 10)
      counts[day] = (counts[day] ?? 0) + 1
    }
    const reservations = Array.from({ length: 14 }).map((_, i) => {
      const d = new Date(Date.now() - (13 - i) * DAY_MS)
      const key = d.toISOString().slice(0, 10)
      return { date: key, count: counts[key] ?? 0 }
    })

    return {
      data: {
        kpis: {
          events: ids.length,
          totalGuests,
          checkedIn,
          pendingEntry: Math.max(totalGuests - checkedIn, 0),
          totalDevices,
          activeDevices,
          todayScans,
          validScans,
          invalidScans,
        },
        reservations,
        recentActivity: recentLogs,
      },
    }
  })
}