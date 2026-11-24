import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import ExcelJS from 'exceljs'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { ATTENDEE_TYPE_CODES, resolveAttendeeType } from '../../config/taxonomy.js'

const STATUSES = ['INVITED', 'REGISTERED', 'CONFIRMED', 'WAITLISTED', 'CANCELLED', 'CHECKED_IN', 'CHECKED_OUT', 'BLOCKED'] as const

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const createSchema = z.object({
  name: z.string().min(2),
  email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().optional(),
  category: z.string().optional(),
  attendeeType: z.enum(ATTENDEE_TYPE_CODES).optional().nullable(),
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
  attendeeType: z.enum(ATTENDEE_TYPE_CODES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

export async function attendeeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'attendee.view', { eventId })
    const { q, status, category, attendeeType, page, pageSize } = querySchema.parse(req.query)

    const where: any = { eventId }
    if (status) where.status = status
    if (category) where.category = category
    if (attendeeType) where.attendeeType = attendeeType
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
          id: true, name: true, email: true, phone: true, category: true, attendeeType: true, status: true,
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

    const attendeeType =
      body.attendeeType === undefined
        ? body.category
          ? resolveAttendeeType(body.category)?.code ?? null
          : null
        : body.attendeeType === null
          ? null
          : resolveAttendeeType(body.attendeeType)?.code ?? null

    const attendee = await prisma.attendee.create({
      data: {
        eventId,
        name: body.name,
        email: body.email,
        phone: body.phone,
        category: body.category,
        attendeeType,
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

    const data: Record<string, unknown> = { ...body }
    if (body.attendeeType !== undefined) {
      data.attendeeType = body.attendeeType === null ? null : resolveAttendeeType(body.attendeeType)?.code ?? null
    } else if (typeof body.category === 'string') {
      const resolved = resolveAttendeeType(body.category)?.code
      if (resolved) data.attendeeType = resolved
    }
    const updated = await prisma.attendee.update({ where: { id: attendeeId }, data: data as any })
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

  app.get('/export.csv', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'attendee.export', { eventId })
    const { q, status, category, attendeeType } = querySchema.partial().parse(req.query)
    const where: Record<string, unknown> = { eventId }
    if (status) where.status = status
    if (category) where.category = category
    if (attendeeType) where.attendeeType = attendeeType
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
      ]
    }
    const rows = await prisma.attendee.findMany({
      where: where as any,
      select: {
        name: true, email: true, phone: true, category: true, attendeeType: true, status: true, notes: true,
        createdAt: true, _count: { select: { tickets: true, credentials: true, accessLogs: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    })
    const lines = [
      ['Name', 'Email', 'Phone', 'Category', 'Attendee type', 'Status', 'Tickets', 'Credentials', 'Scans', 'Notes', 'Registered'],
      ...rows.map((a) => [
        a.name, a.email ?? '', a.phone ?? '', a.category ?? '', a.attendeeType ?? '', a.status,
        a._count.tickets, a._count.credentials, a._count.accessLogs, a.notes ?? '', a.createdAt.toISOString(),
      ]),
    ]
    const csv = `\uFEFF${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}`
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="attendees-${eventId}.csv"`)
    return reply.send(csv)
  })

  app.get('/export.xlsx', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'attendee.export', { eventId })
    const { q, status, category, attendeeType } = querySchema.partial().parse(req.query)
    const where: Record<string, unknown> = { eventId }
    if (status) where.status = status
    if (category) where.category = category
    if (attendeeType) where.attendeeType = attendeeType
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
      ]
    }
    const rows = await prisma.attendee.findMany({
      where: where as any,
      include: { tickets: { include: { busSeats: { select: { label: true, passengerName: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } }, ticketType: { select: { name: true } } }, orderBy: { issuedAt: 'desc' } }, _count: { select: { tickets: true, credentials: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    })
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Attendees')
    ws.columns = [
      { header: 'Name', key: 'name', width: 28 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Phone', key: 'phone', width: 18 },
      { header: 'Category', key: 'category', width: 16 },
      { header: 'Attendee type', key: 'attendeeType', width: 18 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Tickets', key: 'tickets', width: 10 },
      { header: 'Credentials', key: 'credentials', width: 12 },
      { header: 'Ticket Types', key: 'ticketTypes', width: 24 },
      { header: 'Seats', key: 'seats', width: 30 },
      { header: 'Seat Passengers', key: 'seatPassengers', width: 34 },
      { header: 'Notes', key: 'notes', width: 40 },
      { header: 'Created At', key: 'createdAt', width: 22 },
    ]
    for (const a of rows) {
      const seats = (a.tickets as any[]).flatMap((t: any) => (t.busSeats ?? []).map((s: any) => ({ ...s, busName: s.bus?.name ?? '' })))
      ws.addRow({
        name: a.name, email: a.email ?? '', phone: a.phone ?? '', category: a.category ?? '', attendeeType: a.attendeeType ?? '', status: a.status,
        tickets: a._count.tickets, credentials: a._count.credentials,
        ticketTypes: (a.tickets as any[]).map((t: any) => t.ticketType?.name).filter(Boolean).join(', '),
        seats: seats.map((s: any) => `${s.busName ? s.busName + ' ' : ''}${s.label}`).join(', '),
        seatPassengers: seats.map((s: any) => `${s.label}: ${s.passengerName ?? a.name}`).join('; '),
        notes: a.notes ?? '', createdAt: a.createdAt.toISOString(),
      })
    }
    const buf = await wb.xlsx.writeBuffer()
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', `attachment; filename="attendees-${eventId}.xlsx"`)
    return reply.send(Buffer.from(buf))
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
