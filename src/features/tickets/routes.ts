import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'

const typeSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  price: z.coerce.number().nonnegative().optional(),
  quota: z.number().int().positive().optional(),
})

const issueSchema = z.object({
  attendeeId: z.string(),
  ticketTypeId: z.string(),
  price: z.coerce.number().nonnegative().optional(),
})

export async function ticketRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/types', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'ticket.view', { eventId })
    const types = await prisma.ticketType.findMany({
      where: { eventId },
      select: {
        id: true, name: true, description: true, price: true, quota: true, active: true,
        _count: { select: { tickets: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
    return { data: types }
  })

  app.post('/types', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'ticket.issue', { eventId })
    const body = typeSchema.parse(req.body)
    const type = await prisma.ticketType.create({ data: { eventId, ...body } })
    await writeAudit({ eventId, actorUserId: req.user.id, action: 'ticket.type_created', resourceType: 'ticket_type', resourceId: type.id, newValue: body, sourceIp: req.ip })
    return reply.status(201).send({ data: type })
  })

  app.patch('/types/:typeId', async (req) => {
    const { eventId, typeId } = req.params as { eventId: string; typeId: string }
    await requirePermission(req, 'ticket.issue', { eventId })
    const body = typeSchema.partial().extend({ active: z.boolean().optional() }).parse(req.body)
    const type = await prisma.ticketType.findFirst({ where: { id: typeId, eventId } })
    if (!type) throw errors.notFound('Ticket type not found')
    const updated = await prisma.ticketType.update({ where: { id: typeId }, data: body })
    await writeAudit({ eventId, actorUserId: req.user.id, action: 'ticket.type_updated', resourceType: 'ticket_type', resourceId: typeId, newValue: body, sourceIp: req.ip })
    return { data: updated }
  })

  app.get('/', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'ticket.view', { eventId })
    const { q, page = 1, pageSize = 25 } = (req.query ?? {}) as { q?: string; page?: number; pageSize?: number }
    const where: any = { eventId }
    if (q) {
      where.OR = [
        { attendee: { name: { contains: q, mode: 'insensitive' } } },
        { attendee: { email: { contains: q, mode: 'insensitive' } } },
        { credential: { code: { contains: q } } },
        { id: q },
      ]
    }
    const [total, rows] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: (Number(page) - 1) * Number(pageSize),
        take: Number(pageSize),
        select: {
          id: true, status: true, price: true, issuedAt: true,
          attendee: { select: { id: true, name: true, email: true } },
          ticketType: { select: { id: true, name: true } },
          credential: { select: { id: true, code: true, status: true } },
        },
      }),
    ])
    return { data: { rows, total } }
  })

  app.post('/', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'ticket.issue', { eventId })
    const body = issueSchema.parse(req.body)
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    if (!event) throw errors.notFound('Event not found')

    const attendee = await prisma.attendee.findFirst({ where: { id: body.attendeeId, eventId } })
    if (!attendee) throw errors.badRequest('Attendee not found in this event')
    const type = await prisma.ticketType.findFirst({ where: { id: body.ticketTypeId, eventId } })
    if (!type) throw errors.badRequest('Ticket type not found in this event')

    const ticket = await prisma.ticket.create({
      data: {
        eventId,
        attendeeId: body.attendeeId,
        ticketTypeId: body.ticketTypeId,
        price: body.price ?? type.price,
        issuedById: req.user.id,
        status: 'ACTIVE',
      },
    })
    await writeAudit({
      organizationId: event.orgId,
      eventId,
      actorUserId: req.user.id,
      action: 'ticket.issued',
      resourceType: 'ticket',
      resourceId: ticket.id,
      newValue: { attendeeId: body.attendeeId, ticketTypeId: body.ticketTypeId },
      sourceIp: req.ip,
    })
    return reply.status(201).send({ data: ticket })
  })

  app.post('/:ticketId/cancel', async (req) => {
    const { eventId, ticketId } = req.params as { eventId: string; ticketId: string }
    await requirePermission(req, 'ticket.cancel', { eventId })
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, eventId } })
    if (!ticket) throw errors.notFound('Ticket not found')
    const updated = await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'CANCELLED' } })
    await prisma.credential.updateMany({ where: { ticketId }, data: { status: 'REVOKED' } })
    await writeAudit({ eventId, actorUserId: req.user.id, action: 'ticket.cancelled', resourceType: 'ticket', resourceId: ticketId, previousValue: { status: ticket.status }, newValue: { status: 'CANCELLED' }, sourceIp: req.ip })
    return { data: updated }
  })

  app.post('/:ticketId/refund', async (req) => {
    const { eventId, ticketId } = req.params as { eventId: string; ticketId: string }
    await requirePermission(req, 'ticket.refund', { eventId })
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, eventId } })
    if (!ticket) throw errors.notFound('Ticket not found')
    const updated = await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'REFUNDED' } })
    await prisma.credential.updateMany({ where: { ticketId }, data: { status: 'REVOKED' } })
    await writeAudit({ eventId, actorUserId: req.user.id, action: 'ticket.refunded', resourceType: 'ticket', resourceId: ticketId, previousValue: { status: ticket.status }, newValue: { status: 'REFUNDED' }, sourceIp: req.ip })
    return { data: updated }
  })
}