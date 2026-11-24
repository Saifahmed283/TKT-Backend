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

async function assertEventTeam(eventId: string, teamId?: string | null): Promise<void> {
  if (!teamId) return
  const team = await prisma.team.findFirst({ where: { id: teamId, eventId }, select: { id: true } })
  if (!team) throw errors.badRequest('Team not found in this event')
}

async function callerTeamId(eventId: string, userId: string): Promise<string | null> {
  const member = await prisma.eventMember.findUnique({
    where: { eventId_userId: { eventId, userId } },
    select: { teamId: true },
  })
  return member?.teamId ?? null
}

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
    type CommMember = (typeof members)[number]
    await prisma.notification.createMany({
      data: members.map((m: CommMember) => ({
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
    await requirePermission(req, 'event.view', { eventId })
    const teamId = await callerTeamId(eventId, req.user.id)
    const messages = await prisma.message.findMany({
      where: {
        eventId,
        OR: [
          { target: 'ALL_STAFF' },
          { target: 'TEAM', teamId: teamId ?? '__none__' },
          { target: 'USER', recipientUserId: req.user.id },
        ],
      },
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

    if (body.target === 'TEAM') {
      if (!body.teamId) throw errors.badRequest('Team is required')
      await assertEventTeam(eventId, body.teamId)
    }
    if (body.target === 'USER') {
      if (!body.recipientUserId) throw errors.badRequest('Recipient is required')
      const member = await prisma.eventMember.findFirst({
        where: { eventId, userId: body.recipientUserId, status: 'ACTIVE' },
        select: { id: true },
      })
      if (!member) throw errors.badRequest('Recipient is not an active member of this event')
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

  const alertSchema = z.object({ type: z.string().default('help'), message: z.string().min(1), teamId: z.string().optional() })
  app.get('/alerts', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'notification.read', { eventId })
    const teamId = await callerTeamId(eventId, req.user.id)
    return { data: await (prisma as any).opsAlert.findMany({
      where: { eventId, OR: [{ teamId: null }, ...(teamId ? [{ teamId }] : [])] },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }) }
  })
  app.post('/alerts', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'message.send', { eventId })
    const body = alertSchema.parse(req.body)
    await assertEventTeam(eventId, body.teamId)
    const row = await (prisma as any).opsAlert.create({ data: { eventId, type: body.type, message: body.message, teamId: body.teamId || null, createdById: req.user.id, resolved: false } })
    publish(channelFor.activity(eventId), 'alert.created', { id: row.id, type: row.type })
    return reply.status(201).send({ data: row })
  })

  const chatSchema = z.object({ text: z.string().min(1), teamId: z.string().optional() })
  app.get('/chat', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'notification.read', { eventId })
    const { teamId } = req.query as { teamId?: string }
    const myTeamId = await callerTeamId(eventId, req.user.id)
    if (teamId && teamId !== myTeamId) throw errors.forbidden('You are not a member of this team')
    const where = teamId
      ? { eventId, teamId }
      : { eventId, OR: [{ teamId: null }, ...(myTeamId ? [{ teamId: myTeamId }] : [])] }
    return { data: await (prisma as any).teamChatMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 }) }
  })
  app.post('/chat', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'message.send', { eventId })
    const body = chatSchema.parse(req.body)
    await assertEventTeam(eventId, body.teamId)
    const row = await (prisma as any).teamChatMessage.create({ data: { eventId, teamId: body.teamId || null, userId: req.user.id, text: body.text } })
    publish(channelFor.activity(eventId), 'chat.message', { id: row.id })
    return reply.status(201).send({ data: row })
  })

  app.delete('/announcements/:id', async (req, reply) => {
    const { eventId, id } = req.params as { eventId: string; id: string }
    await requirePermission(req, 'announcement.publish', { eventId })
    const existing = await prisma.announcement.findFirst({ where: { id, eventId } })
    if (!existing) throw errors.notFound('Announcement not found')
    await prisma.announcement.delete({ where: { id } })
    await writeAudit({ eventId, actorUserId: req.user.id, action: 'announcement.deleted', resourceType: 'announcement', resourceId: id, previousValue: { title: existing.title }, sourceIp: req.ip })
    return reply.status(204).send()
  })

  app.delete('/alerts/:id', async (req, reply) => {
    const { eventId, id } = req.params as { eventId: string; id: string }
    await requirePermission(req, 'notification.read', { eventId })
    const existing = await (prisma as any).opsAlert.findFirst({ where: { id, eventId } })
    if (!existing) throw errors.notFound('Alert not found')
    await (prisma as any).opsAlert.delete({ where: { id } })
    await writeAudit({ eventId, actorUserId: req.user.id, action: 'alert.deleted', resourceType: 'ops_alert', resourceId: id, previousValue: { type: existing.type }, sourceIp: req.ip })
    return reply.status(204).send()
  })

  app.delete('/chat/:id', async (req, reply) => {
    const { eventId, id } = req.params as { eventId: string; id: string }
    await requirePermission(req, 'message.send', { eventId })
    const existing = await (prisma as any).teamChatMessage.findFirst({ where: { id, eventId } })
    if (!existing) throw errors.notFound('Chat message not found')
    await (prisma as any).teamChatMessage.delete({ where: { id } })
    await writeAudit({ eventId, actorUserId: req.user.id, action: 'chat.deleted', resourceType: 'team_chat_message', resourceId: id, sourceIp: req.ip })
    return reply.status(204).send()
  })
}