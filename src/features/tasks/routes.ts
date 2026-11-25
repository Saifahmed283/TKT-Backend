import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { publish, channelFor } from '../../lib/realtime.js'
import { logActivity } from '../../lib/activity.js'

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
const STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'] as const

const createSchema = z.object({
  title: z.string().min(2),
  description: z.string().optional(),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  teamId: z.string().optional(),
  assigneeId: z.string().optional(),
  areaId: z.string().optional(),
  dueAt: z.coerce.date().optional(),
  checklist: z.array(z.object({ done: z.boolean(), text: z.string() })).optional(),
})

const updateSchema = z.object({
  title: z.string().min(2).optional(),
  description: z.string().nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(STATUSES).optional(),
  teamId: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  areaId: z.string().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  checklist: z.array(z.object({ done: z.boolean(), text: z.string() })).optional(),
})

const querySchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: z.string().optional(),
  teamId: z.string().optional(),
  areaId: z.string().optional(),
  q: z.string().optional(),
})

export async function taskRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  async function taskPermission(req: any, eventId: string, permission: any, target?: { teamId?: string | null; areaId?: string | null }) {
    // Task routes apply team/area filtering themselves after this capability
    // check, then make a second target-scoped check for specific resources.
    return requirePermission(req, permission, { eventId, target, allowNarrowNoTarget: true })
  }

  app.get('/', async (req) => {
    const { eventId } = req.params as { eventId: string }
    const ctx = await taskPermission(req, eventId, 'task.view')
    const { status, priority, assigneeId, teamId, areaId, q } = querySchema.parse(req.query)

    const where: any = { eventId }
    if (status) where.status = status
    if (priority) where.priority = priority
    if (assigneeId) where.assigneeId = assigneeId
    if (teamId) where.teamId = teamId
    if (areaId) where.areaId = areaId
    if (q) where.title = { contains: q, mode: 'insensitive' }

    // Team-scoped operators only see their team's tasks
    if (ctx.eventScope === 'TEAM' && ctx.teamId) where.teamId = ctx.teamId
    if (ctx.eventScope === 'AREA') {
      where.OR = [{ areaId: { in: ctx.areaIds } }, { teamId: null, areaId: null }]
    }

    const tasks = await prisma.task.findMany({
      where,
      orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true, title: true, description: true, priority: true, status: true,
        dueAt: true, checklist: true, evidence: true, createdAt: true, updatedAt: true, completedAt: true,
        team: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
    })
    return { data: tasks }
  })

  app.post('/', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await taskPermission(req, eventId, 'task.create')
    const body = createSchema.parse(req.body)
    // The preHandler check is targetless so list routes can filter. Mutations
    // must re-check the actual team/area from the body before writing.
    await taskPermission(req, eventId, 'task.create', {
      teamId: body.teamId ?? null,
      areaId: body.areaId ?? null,
    })
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    if (!event) throw errors.notFound('Event not found')

    if (body.teamId) {
      const team = await prisma.team.findFirst({ where: { id: body.teamId, eventId } })
      if (!team) throw errors.badRequest('Team not found in this event')
    }
    if (body.areaId) {
      const area = await prisma.area.findFirst({ where: { id: body.areaId, eventId } })
      if (!area) throw errors.badRequest('Area not found in this event')
    }

    const task = await prisma.task.create({
      data: {
        eventId,
        title: body.title,
        description: body.description,
        priority: body.priority,
        teamId: body.teamId,
        assigneeId: body.assigneeId,
        areaId: body.areaId,
        dueAt: body.dueAt,
        checklist: body.checklist ?? [],
        createdById: req.user.id,
      },
    })
    await prisma.taskActivity.create({
      data: { taskId: task.id, actorId: req.user.id, action: 'CREATED', note: body.title },
    })
    if (body.assigneeId) {
      await prisma.notification.create({
        data: { userId: body.assigneeId, eventId, type: 'TASK_ASSIGNED', title: 'You were assigned a task', body: body.title, data: { taskId: task.id } },
      })
    }
    await writeAudit({ organizationId: event.orgId, eventId, actorUserId: req.user.id, action: 'task.created', resourceType: 'task', resourceId: task.id, newValue: { title: body.title }, sourceIp: req.ip })
    publish(channelFor.task(eventId), 'task-created', { id: task.id, title: body.title, status: 'TODO' })
    logActivity(eventId, 'task', `Task created · ${body.title}`, req.user.name)
    return reply.status(201).send({ data: task })
  })

  app.get('/:taskId', async (req) => {
    const { eventId, taskId } = req.params as { eventId: string; taskId: string }
    await taskPermission(req, eventId, 'task.view')
    const task = await prisma.task.findFirst({
      where: { id: taskId, eventId },
      include: {
        team: true, assignee: { select: { id: true, name: true, email: true } }, area: true,
        creator: { select: { id: true, name: true } },
        activity: { include: { actor: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
      },
    })
    if (!task) throw errors.notFound('Task not found')
    await taskPermission(req, eventId, 'task.view', { teamId: task.teamId, areaId: task.areaId })
    return { data: task }
  })

  app.patch('/:taskId', async (req) => {
    const { eventId, taskId } = req.params as { eventId: string; taskId: string }
    const ctx = await taskPermission(req, eventId, 'task.update')
    const body = updateSchema.parse(req.body)
    const task = await prisma.task.findFirst({ where: { id: taskId, eventId } })
    if (!task) throw errors.notFound('Task not found')
    await taskPermission(req, eventId, 'task.update', { teamId: task.teamId, areaId: task.areaId })

    if (body.teamId) {
      const team = await prisma.team.findFirst({ where: { id: body.teamId, eventId } })
      if (!team) throw errors.badRequest('Team not found in this event')
      await taskPermission(req, eventId, 'task.update', { teamId: body.teamId, areaId: task.areaId })
    }
    if (body.areaId) {
      const area = await prisma.area.findFirst({ where: { id: body.areaId, eventId } })
      if (!area) throw errors.badRequest('Area not found in this event')
      await taskPermission(req, eventId, 'task.update', { teamId: task.teamId, areaId: body.areaId })
    }

    const statusChanged = body.status && body.status !== task.status
    const assigneeChanged = body.assigneeId !== undefined && body.assigneeId !== task.assigneeId

    const updated = await prisma.task.update({
      where: { id: taskId },
      data: {
        ...body,
        completedAt: body.status === 'DONE' ? new Date() : body.status != null ? null : undefined,
        completedById: body.status === 'DONE' ? req.user.id : undefined,
      },
    })

    await prisma.taskActivity.create({
      data: {
        taskId,
        actorId: req.user.id,
        action: statusChanged ? 'STATUS_CHANGED' : 'UPDATED',
        note: statusChanged ? `${task.status} â†’ ${body.status}` : undefined,
      },
    })
    if (assigneeChanged && body.assigneeId) {
      await prisma.notification.create({
        data: { userId: body.assigneeId, eventId, type: 'TASK_ASSIGNED', title: 'You were assigned a task', body: updated.title, data: { taskId } },
      })
    }
    await writeAudit({ eventId, actorUserId: req.user.id, action: 'task.updated', resourceType: 'task', resourceId: taskId, previousValue: { status: task.status }, newValue: body, sourceIp: req.ip })
    publish(channelFor.task(eventId), 'task-updated', { id: taskId, status: updated.status, title: updated.title })
    logActivity(eventId, 'task', `${updated.title} → ${updated.status}`, req.user.name)
    return { data: updated }
  })

  app.delete('/:taskId', async (req, reply) => {
    const { eventId, taskId } = req.params as { eventId: string; taskId: string }
    await taskPermission(req, eventId, 'task.delete')
    const task = await prisma.task.findFirst({ where: { id: taskId, eventId } })
    if (!task) throw errors.notFound('Task not found')
    await taskPermission(req, eventId, 'task.delete', { teamId: task.teamId, areaId: task.areaId })
    await prisma.task.delete({ where: { id: taskId } })
    await writeAudit({ eventId, actorUserId: req.user.id, action: 'task.deleted', resourceType: 'task', resourceId: taskId, sourceIp: req.ip })
    return reply.status(204).send()
  })
}