import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { publish, channelFor } from '../../lib/realtime.js'
import { logActivity } from '../../lib/activity.js'

const announcementSchema = z.object({
  title: z.string().min(2),
  body: z.string().min(1),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  targetAudience: z
    .object({
      scope: z.enum(['ALL_STAFF', 'TEAMS', 'ROLES']),
      teamIds: z.array(z.string()).optional(),
      roleIds: z.array(z.string()).optional(),
    })
    .default({ scope: 'ALL_STAFF' }),
})

const messageSchema = z.object({
  target: z.enum(['ALL_STAFF', 'TEAM', 'USER']).default('ALL_STAFF'),
  teamId: z.string().optional(),
  recipientUserId: z.string().optional(),
  body: z.string().min(1),
})

export async function communicationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // â”€â”€ Announcements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/announcements', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'event.view', { eventId })
    const announcements = await prisma.announcement.findMany({
      where: { eventId },
      orderBy: { createdAt: 'desc' },
      include: { author: { select: { id: true, name: true } } },
      take: 50,
    })
    return { data: announcements }
  })

  app.post('/announcements', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'announcement.publish', { eventId })
    const body = announcementSchema.parse(req.body)
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true, name: true } })
    if (!event) throw errors.notFound('Event not found')

    const announcement = await prisma.announcement.create({
      data: {
        eventId,
        authorId: req.user.id,
        title: body.title,
        body: body.body,
        priority: body.priority,
        targetAudience: body.targetAudience,
      },
    })

    // Fan out notifications to the targeted audience
    const where: any = { eventId, status: 'ACTIVE' }
    if (body.targetAudience.scope === 'TEAMS' && body.targetAudience.teamIds?.length) {
      where.teamId = { in: body.targetAudience.teamIds }
    } else if (body.targetAudience.scope === 'ROLES' && body.targetAudience.roleIds?.length) {
      where.roleId = { in: body.targetAudience.roleIds }
    }
    const members = await prisma.eventMember.findMany({ where, select: { userId: true } })
    await prisma.notification.createMany({
      data: members.map((m) => ({
        userId: m.userId, eventId, type: 'ANNOUNCEMENT',
        title: body.title,
        body: body.body.slice(0, 140),
        data: { announcementId: announcement.id, priority: body.priority },
      })),
    })

    await writeAudit({ organizationId: event.orgId, eventId, actorUserId: req.user.id, action: 'announcement.published', resourceType: 'announcement', resourceId: announcement.id, newValue: { title: body.title, priority: body.priority }, sourceIp: req.ip })
    publish(channelFor.announcement(eventId), 'announcement', { id: announcement.id, title: body.title, priority: body.priority })
    logActivity(eventId, 'announcement', `Announcement · ${body.title}`, req.user.name)
    return reply.status(201).send({ data: announcement })
  })

  // â”€â”€ Team messages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/messages', async (req) => {
    const { eventId } = req.params as { eventId: string }
    const ctx = await requirePermission(req, 'event.view', { eventId })
    const messages = await prisma.message.findMany({
      where: { eventId },
      orderBy: { createdAt: 'desc' },
      include: { sender: { select: { id: true, name: true } } },
      take: 100,
    })
    return { data: messages }
  })

  app.post('/messages', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    const ctx = await requirePermission(req, 'message.send', { eventId })
    const body = messageSchema.parse(req.body)
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    if (!event) throw errors.notFound('Event not found')

    if (body.target === 'TEAM' && body.teamId) {
      const team = await prisma.team.findFirst({ where: { id: body.teamId, eventId } })
      if (!team) throw errors.badRequest('Team not found in this event')
    }

    const message = await prisma.message.create({
      data: {
        eventId,
        senderId: req.user.id,
        target: body.target,
        teamId: body.target === 'TEAM' ? body.teamId : null,
        recipientUserId: body.target === 'USER' ? body.recipientUserId : null,
        body: body.body,
      },
    })
    return reply.status(201).send({ data: message })
  })

  // â”€â”€ Notifications (mine) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/notifications', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'event.view', { eventId })
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id, eventId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    return { data: notifications }
  })

  app.post('/notifications/read', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'notification.read', { eventId })
    const { ids } = (req.body ?? {}) as { ids?: string[] }
    await prisma.notification.updateMany({
      where: ids?.length
        ? { id: { in: ids }, userId: req.user.id }
        : { userId: req.user.id, eventId },
      data: { readAt: new Date() },
    })
    return { data: { ok: true } }
  })

  // â”€â”€ Global notifications (across my events) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/all', async (req) => {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { event: { select: { id: true, name: true } } },
    })
    return { data: notifications }
  })
}