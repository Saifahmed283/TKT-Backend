import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'

const STATUSES = ['INVITED', 'REGISTERED', 'CONFIRMED', 'WAITLISTED', 'CANCELLED', 'CHECKED_IN', 'CHECKED_OUT', 'BLOCKED'] as const

const createSchema = z.object({
  name: z.string().min(2),
  email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().optional(),
  category: z.string().optional(),
  notes: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const updateSchema = createSchema.partial().extend({
  status: z.enum(STATUSES).optional(),
})

const querySchema = z.object({
  q: z.string().optional(),
  status: z.enum(STATUSES).optional(),
  category: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

export async function attendeeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'attendee.view', { eventId })
    const { q, status, category, page, pageSize } = querySchema.parse(req.query)

    const where: any = { eventId }
    if (status) where.status = status
    if (category) where.category = category
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { id: q },
      ]
    }

    const [total, rows] = await Promise.all([
      prisma.attendee.count({ where }),
      prisma.attendee.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, name: true, email: true, phone: true, category: true, status: true,
          notes: true, createdAt: true, updatedAt: true,
          _count: { select: { tickets: true, credentials: true, accessLogs: true } },
        },
      }),
    ])
    return { data: { rows, total, page, pageSize } }
  })

  app.post('/', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'attendee.create', { eventId })
    const body = createSchema.parse(req.body)
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    if (!event) throw errors.notFound('Event not found')

    const attendee = await prisma.attendee.create({
      data: {
        eventId,
        name: body.name,
        email: body.email,
        phone: body.phone,
        category: body.category,
        notes: body.notes,
        metadata: body.metadata,
        registeredById: req.user.id,
        status: 'REGISTERED',
      } as any,
    })
    await writeAudit({
      organizationId: event.orgId,
      eventId,
      actorUserId: req.user.id,
      action: 'attendee.created',
      resourceType: 'attendee',
      resourceId: attendee.id,
      newValue: { name: body.name, email: body.email },
      sourceIp: req.ip,
    })
    return reply.status(201).send({ data: attendee })
  })

  app.get('/:attendeeId', async (req) => {
    const { eventId, attendeeId } = req.params as { eventId: string; attendeeId: string }
    await requirePermission(req, 'attendee.view', { eventId })
    const attendee = await prisma.attendee.findFirst({
      where: { id: attendeeId, eventId },
      include: {
        tickets: { include: { ticketType: { select: { name: true, price: true } } } },
        credentials: true,
        accessLogs: { orderBy: { timestamp: 'desc' }, take: 20 },
        registeredBy: { select: { name: true } },
      },
    })
    if (!attendee) throw errors.notFound('Attendee not found')
    return { data: attendee }
  })

  app.patch('/:attendeeId', async (req) => {
    const { eventId, attendeeId } = req.params as { eventId: string; attendeeId: string }
    await requirePermission(req, 'attendee.update', { eventId })
    const body = updateSchema.parse(req.body)
    const attendee = await prisma.attendee.findFirst({ where: { id: attendeeId, eventId } })
    if (!attendee) throw errors.notFound('Attendee not found')

    const updated = await prisma.attendee.update({ where: { id: attendeeId }, data: body as any })
    await writeAudit({
      eventId,
      actorUserId: req.user.id,
      action: 'attendee.updated',
      resourceType: 'attendee',
      resourceId: attendeeId,
      previousValue: { status: attendee.status },
      newValue: body,
      sourceIp: req.ip,
    })
    return { data: updated }
  })

  app.get('/:attendeeId/access-history', async (req) => {
    const { eventId, attendeeId } = req.params as { eventId: string; attendeeId: string }
    await requirePermission(req, 'access.logs.view', { eventId })
    const logs = await prisma.accessLog.findMany({
      where: { eventId, attendeeId },
      orderBy: { timestamp: 'desc' },
      include: { area: { select: { name: true } }, operator: { select: { name: true } } },
    })
    return { data: logs }
  })

  app.delete('/:attendeeId', async (req, reply) => {
    const { eventId, attendeeId } = req.params as { eventId: string; attendeeId: string }
    await requirePermission(req, 'attendee.delete', { eventId })
    const attendee = await prisma.attendee.findFirst({ where: { id: attendeeId, eventId }, include: { _count: { select: { tickets: true, credentials: true, accessLogs: true } } } })
    if (!attendee) throw errors.notFound('Attendee not found')
    if (attendee._count.tickets > 0 || attendee._count.credentials > 0 || attendee._count.accessLogs > 0) {
      throw errors.conflict('Cannot delete attendee with tickets, credentials, or access history; cancel/block instead')
    }
    await prisma.attendee.delete({ where: { id: attendeeId } })
    await writeAudit({ eventId, actorUserId: req.user.id, action: 'attendee.deleted', resourceType: 'attendee', resourceId: attendeeId, previousValue: { name: attendee.name, email: attendee.email }, sourceIp: req.ip })
    return reply.status(204).send()
  })
}