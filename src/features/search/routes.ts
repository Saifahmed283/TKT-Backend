import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'

const querySchema = z.object({
  q: z.string().min(1),
  scope: z.enum(['EVENTS', 'ATTENDEES', 'TICKETS', 'CREDENTIALS', 'STAFF', 'TEAMS', 'TASKS', 'INCIDENTS', 'AREAS']).optional(),
})

/**
 * Global search â€” results are always filtered by the caller's
 * authorization scopes. Users never see results they cannot access.
 */
export async function searchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req) => {
    const { q, scope } = querySchema.parse(req.query)
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        platformRole: true,
        orgMemberships: { select: { orgId: true, role: true } },
        eventMemberships: { select: { eventId: true } },
      },
    })
    if (!user) return { data: {} }

    const adminOrgIds = user.orgMemberships
      .filter((m) => m.role === 'OWNER' || m.role === 'ADMIN')
      .map((m) => m.orgId)
    const memberEventIds = user.eventMemberships.map((m) => m.eventId)
    const eventAccess = user.platformRole === 'super_admin'
      ? {}
      : { OR: [{ orgId: { in: adminOrgIds } }, { id: { in: memberEventIds } }] }

    const out: Record<string, unknown[]> = {}
    const like = { contains: q, mode: 'insensitive' as const }

    if (!scope || scope === 'EVENTS') {
      out.events = await prisma.event.findMany({
        where: { ...eventAccess, OR: [{ name: like }, { venueName: like }, { description: like }] },
        select: { id: true, name: true, status: true, type: true, startAt: true },
        take: 8,
      })
    }
    if (!scope || scope === 'ATTENDEES') {
      out.attendees = await prisma.attendee.findMany({
        where: { event: eventAccess, OR: [{ name: like }, { email: like }] },
        select: { id: true, name: true, email: true, status: true, eventId: true },
        take: 8,
      })
    }
    if (!scope || scope === 'TICKETS') {
      out.tickets = await prisma.ticket.findMany({
        where: { event: eventAccess, attendee: { OR: [{ name: like }, { email: like }] } },
        select: { id: true, status: true, eventId: true, attendee: { select: { name: true } }, ticketType: { select: { name: true } } },
        take: 8,
      })
    }
    if (!scope || scope === 'CREDENTIALS') {
      out.credentials = await prisma.credential.findMany({
        where: { event: eventAccess, OR: [{ code: { contains: q } }, { attendee: { name: like } }] },
        select: { id: true, code: true, status: true, eventId: true, attendee: { select: { name: true } } },
        take: 8,
      })
    }
    if (!scope || scope === 'STAFF') {
      out.staff = await prisma.eventMember.findMany({
        where: { event: eventAccess, user: { OR: [{ name: like }, { email: like }] } },
        select: { id: true, eventId: true, user: { select: { id: true, name: true, email: true } }, role: { select: { name: true } } },
        take: 8,
      })
    }
    if (!scope || scope === 'TEAMS') {
      out.teams = await prisma.team.findMany({
        where: { event: eventAccess, name: like },
        select: { id: true, name: true, eventId: true },
        take: 8,
      })
    }
    if (!scope || scope === 'AREAS') {
      out.areas = await prisma.area.findMany({
        where: { event: eventAccess, name: like },
        select: { id: true, name: true, eventId: true, type: true },
        take: 8,
      })
    }
    if (!scope || scope === 'TASKS') {
      out.tasks = await prisma.task.findMany({
        where: { event: eventAccess, title: like },
        select: { id: true, title: true, status: true, eventId: true },
        take: 8,
      })
    }
    if (!scope || scope === 'INCIDENTS') {
      out.incidents = await prisma.incident.findMany({
        where: { event: eventAccess, OR: [{ title: like }, { code: { contains: q } }] },
        select: { id: true, code: true, title: true, status: true, priority: true, eventId: true },
        take: 8,
      })
    }
    return { data: out }
  })
}