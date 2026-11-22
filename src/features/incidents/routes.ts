import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { publish, channelFor } from '../../lib/realtime.js'
import { logActivity } from '../../lib/activity.js'
import { dispatchEventWebhooks } from '../integrations/dispatch.js'

const TYPES = ['SECURITY', 'MEDICAL', 'TECHNICAL', 'REGISTRATION', 'ATTENDEE', 'CROWD', 'EQUIPMENT', 'OPERATIONAL', 'OTHER'] as const
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
const STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'CLOSED'] as const

const createSchema = z.object({
  type: z.enum(TYPES).default('OTHER'),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  title: z.string().min(2),
  description: z.string().optional(),
  areaId: z.string().optional(),
  assignedToId: z.string().nullable().optional(),
  evidence: z.array(z.object({ url: z.string(), label: z.string().optional() })).optional(),
})

const updateSchema = z.object({
  title: z.string().min(2).optional(),
  description: z.string().nullable().optional(),
  type: z.enum(TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(STATUSES).optional(),
  assignedTeamId: z.string().nullable().optional(),
  assignedUserId: z.string().nullable().optional(),
  areaId: z.string().nullable().optional(),
  resolution: z.string().nullable().optional(),
})

const commentSchema = z.object({ body: z.string().min(1) })

async function nextCode(eventId: string): Promise<string> {
  const last = await prisma.incident.findFirst({ where: { eventId }, orderBy: { code: 'desc' }, select: { code: true } })
  const n = last ? parseInt(last.code.replace('INC-', ''), 10) + 1 : 1
  return `INC-${String(n).padStart(4, '0')}`
}

export async function incidentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req) => {
    const { eventId } = req.params as { eventId: string }
    const ctx = await requirePermission(req, 'incident.view', { eventId })
    const { status, priority, type, q } = (req.query ?? {}) as { status?: string; priority?: string; type?: string; q?: string }
    const where: any = { eventId }
    if (status) where.status = status
    if (priority) where.priority = priority
    if (type) where.type = type
    if (q) {
      where.OR = [{ title: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }]
    }

    const incidents = await prisma.incident.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true, code: true, type: true, priority: true, status: true, title: true,
        createdAt: true, updatedAt: true, resolvedAt: true,
        area: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        comments: { select: { id: true, body: true, createdAt: true, author: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
        _count: { select: { comments: true } },
      },
    })
    return { data: incidents }
  })

  app.post('/', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    const ctx = await requirePermission(req, 'incident.create', { eventId })
    const body = createSchema.parse(req.body)
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true, name: true } })
    if (!event) throw errors.notFound('Event not found')

    if (body.areaId) {
      const area = await prisma.area.findFirst({ where: { id: body.areaId, eventId } })
      if (!area) throw errors.badRequest('Area not found in this event')
    }

    const code = await nextCode(eventId)
    let assignedUserId: string | null = null
    if (body.assignedToId) {
      const assignee = await prisma.eventMember.findFirst({ where: { id: body.assignedToId, eventId }, select: { userId: true } })
      if (!assignee) throw errors.badRequest('Assignee not found in this event')
      assignedUserId = assignee.userId
    }
    const incident = await prisma.incident.create({
      data: {
        eventId,
        code,
        type: body.type,
        priority: body.priority,
        title: body.title,
        description: body.description,
        areaId: body.areaId,
        evidence: body.evidence ?? [],
        assignedUserId,
        createdById: req.user.id,
      },
    })
    await writeAudit({ organizationId: event.orgId, eventId, actorUserId: req.user.id, action: 'incident.created', resourceType: 'incident', resourceId: incident.id, newValue: { code, title: body.title, priority: body.priority, type: body.type }, sourceIp: req.ip })

    // Notify event managers + team leads about CRITICAL incidents
    if (body.priority === 'CRITICAL' || body.priority === 'HIGH') {
      const leaders = await prisma.eventMember.findMany({
        where: { eventId, status: 'ACTIVE', role: { scope: { in: ['EVENT', 'TEAM'] } } },
        select: { userId: true },
      })
      type LeaderRow = (typeof leaders)[number]
      await prisma.notification.createMany({
        data: leaders.map((m: LeaderRow) => ({
          userId: m.userId, eventId, type: 'INCIDENT_CRITICAL',
          title: `${body.priority} incident created: ${body.title}`,
          body: `${code} Â· ${body.type} Â· ${event.name}`,
        })),
      })
    }

    publish(channelFor.incident(eventId), 'incident-created', {
      id: incident.id, code, title: body.title, priority: body.priority, type: body.type, status: 'OPEN',
    })
    void dispatchEventWebhooks(eventId, 'incident.created', { id: incident.id, code, title: body.title, priority: body.priority, type: body.type, status: 'OPEN' })
    logActivity(eventId, 'incident', `${code} opened · ${body.title}`, req.user.name)
    return reply.status(201).send({ data: incident })
  })

  app.get('/:incidentId', async (req) => {
    const { eventId, incidentId } = req.params as { eventId: string; incidentId: string }
    await requirePermission(req, 'incident.view', { eventId })
    const incident = await prisma.incident.findFirst({
      where: { id: incidentId, eventId },
      include: {
        area: true,
        assignee: { select: { id: true, name: true } },
        team: true,
        creator: { select: { id: true, name: true } },
        comments: {
          include: { author: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!incident) throw errors.notFound('Incident not found')
    return { data: incident }
  })

  app.patch('/:incidentId', async (req) => {
    const { eventId, incidentId } = req.params as { eventId: string; incidentId: string }
    const ctx = await requirePermission(req, 'incident.update', { eventId })
    const body = updateSchema.parse(req.body)
    const incident = await prisma.incident.findFirst({ where: { id: incidentId, eventId } })
    if (!incident) throw errors.notFound('Incident not found')

    if (body.status && ['RESOLVED', 'CLOSED'].includes(body.status)) {
      await requirePermission(req, 'incident.resolve', { eventId })
    }
    if (body.status === 'ESCALATED') {
      await requirePermission(req, 'incident.escalate', { eventId })
    }

    if (body.assignedTeamId) {
      const team = await prisma.team.findFirst({ where: { id: body.assignedTeamId, eventId } })
      if (!team) throw errors.badRequest('Team not found in this event')
    }

    const updated = await prisma.incident.update({
      where: { id: incidentId },
      data: {
        ...body,
        resolvedAt: body.status && ['RESOLVED', 'CLOSED'].includes(body.status) ? new Date() : body.status && body.status !== 'RESOLVED' && body.status !== 'CLOSED' ? null : undefined,
      },
    })
    await writeAudit({ eventId, actorUserId: req.user.id, action: 'incident.updated', resourceType: 'incident', resourceId: incidentId, previousValue: { status: incident.status }, newValue: body, sourceIp: req.ip })
    publish(channelFor.incident(eventId), 'incident-updated', { id: incidentId, status: updated.status, title: updated.title })
    logActivity(eventId, 'incident', `${updated.code} → ${body.status ?? 'updated'}`, req.user.name)
    return { data: updated }
  })

  app.post('/:incidentId/comments', async (req, reply) => {
    const { eventId, incidentId } = req.params as { eventId: string; incidentId: string }
    await requirePermission(req, 'incident.update', { eventId })
    const body = commentSchema.parse(req.body)
    const incident = await prisma.incident.findFirst({ where: { id: incidentId, eventId } })
    if (!incident) throw errors.notFound('Incident not found')
    const comment = await prisma.incidentComment.create({
      data: { incidentId, authorId: req.user.id, body: body.body },
      include: { author: { select: { id: true, name: true } } },
    })
    return reply.status(201).send({ data: comment })
  })
}