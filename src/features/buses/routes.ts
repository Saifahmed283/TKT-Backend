import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import crypto from 'node:crypto'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'

const seatDefSchema = z.object({
  label: z.string().min(1).max(16),
  row: z.number().int().min(1).max(80),
  col: z.number().int().min(1).max(20),
  state: z.enum(['AVAILABLE', 'UNAVAILABLE']).optional(),
  kind: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
})

const layoutSchema = z.object({
  template: z.enum(['grid', 'mect49', 'coaster21', 'custom']).optional(),
  look: z.string().optional(),
  rows: z.number().int().min(1).max(80),
  cols: z.number().int().min(1).max(20),
  aisleAfterCol: z.number().int().min(0).max(20).optional(),
  unavailable: z.array(z.object({ row: z.number().int(), col: z.number().int() })).optional(),
  seats: z.array(seatDefSchema).max(200).optional(),
})

const busSchema = z.object({
  name: z.string().min(2),
  layout: layoutSchema,
  seatPrice: z.coerce.number().nonnegative().optional(),
  currency: z.string().min(3).max(8).optional(),
  isActive: z.boolean().optional(),
})

const passengerSchema = z.object({
  seatId: z.string(),
  name: z.string().min(2),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
})

const reserveSchema = z.object({
  seatIds: z.array(z.string()).min(1).max(20),
  ticketId: z.string().optional(),
  holderName: z.string().min(2),
  groupId: z.string().optional(),
  passengers: z.array(passengerSchema).optional(),
})

function templateSeats(template: string): { label: string; row: number; col: number; state: 'AVAILABLE' | 'UNAVAILABLE' }[] {
  if (template === 'mect49') {
    const seats: { label: string; row: number; col: number; state: 'AVAILABLE' | 'UNAVAILABLE' }[] = []
    let n = 1
    seats.push({ label: String(n++), row: 1, col: 3, state: 'AVAILABLE' })
    seats.push({ label: String(n++), row: 1, col: 4, state: 'AVAILABLE' })
    seats.push({ label: String(n++), row: 2, col: 3, state: 'AVAILABLE' })
    seats.push({ label: String(n++), row: 2, col: 4, state: 'AVAILABLE' })
    for (let r = 3; r <= 12; r++) for (const c of [1, 2, 3, 4]) seats.push({ label: String(n++), row: r, col: c, state: 'AVAILABLE' })
    for (let c = 1; c <= 5; c++) seats.push({ label: String(n++), row: 13, col: c, state: 'AVAILABLE' })
    return seats
  }
  if (template === 'coaster21') {
    const seats: { label: string; row: number; col: number; state: 'AVAILABLE' | 'UNAVAILABLE' }[] = []
    let n = 1
    seats.push({ label: String(n++), row: 1, col: 1, state: 'AVAILABLE' })
    seats.push({ label: String(n++), row: 1, col: 3, state: 'AVAILABLE' })
    seats.push({ label: String(n++), row: 1, col: 4, state: 'AVAILABLE' })
    for (let r = 2; r <= 5; r++) for (const c of [1, 2, 3, 4]) seats.push({ label: String(n++), row: r, col: c, state: 'AVAILABLE' })
    seats.push({ label: String(n++), row: 6, col: 1, state: 'AVAILABLE' })
    seats.push({ label: String(n++), row: 6, col: 4, state: 'AVAILABLE' })
    return seats
  }
  return []
}

function buildSeats(layout: z.infer<typeof layoutSchema>) {
  if (Array.isArray(layout.seats) && layout.seats.length) {
    return layout.seats.map(s => ({ label: String(s.label), row: Number(s.row), col: Number(s.col), state: (s.state === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'AVAILABLE') as 'AVAILABLE' | 'UNAVAILABLE' }))
  }
  const fromTemplate = layout.template ? templateSeats(layout.template) : []
  if (fromTemplate.length) return fromTemplate
  const unavailable = new Set((layout.unavailable ?? []).map(s => `${s.row}:${s.col}`))
  const seats: { label: string; row: number; col: number; state: 'AVAILABLE' | 'UNAVAILABLE' }[] = []
  let n = 1
  for (let row = 1; row <= layout.rows; row++) {
    for (let col = 1; col <= layout.cols; col++) {
      const isUnavailable = unavailable.has(`${row}:${col}`)
      seats.push({ label: String(n++), row, col, state: isUnavailable ? 'UNAVAILABLE' : 'AVAILABLE' })
    }
  }
  return seats
}


async function lockBusForSeatMutation(tx: Prisma.TransactionClient, busId: string, eventId: string, activeOnly = false) {
  const activeClause = activeOnly ? Prisma.sql`AND "isActive" = TRUE` : Prisma.empty
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Bus"
    WHERE "id" = ${busId} AND "eventId" = ${eventId} ${activeClause}
    FOR UPDATE
  `)
  return rows.length > 0
}

export async function busRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'bus.view', { eventId })
    const buses = await prisma.bus.findMany({ where: { eventId }, include: { _count: { select: { seats: true } } }, orderBy: { createdAt: 'asc' } })
    return { data: buses }
  })

  app.post('/', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'bus.manage', { eventId })
    const body = busSchema.parse(req.body)
    const seats = buildSeats(body.layout)
    const bus = await prisma.bus.create({
      data: {
        eventId, name: body.name, layout: body.layout as any, seatPrice: body.seatPrice ?? 0, currency: body.currency ?? 'EGP', isActive: body.isActive ?? true,
        seats: { create: seats.map(s => ({ label: s.label, row: s.row, col: s.col, state: s.state })) },
      },
      include: { seats: true },
    })
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    await writeAudit({ organizationId: event?.orgId, eventId, actorUserId: req.user.id, action: 'bus.created', resourceType: 'bus', resourceId: bus.id, newValue: { name: bus.name, seats: seats.length }, sourceIp: req.ip })
    return reply.status(201).send({ data: bus })
  })

  app.get('/:busId/seats', async (req) => {
    const { eventId, busId } = req.params as { eventId: string; busId: string }
    await requirePermission(req, 'bus.view', { eventId })
    const bus = await prisma.bus.findFirst({ where: { id: busId, eventId }, include: { seats: { orderBy: [{ row: 'asc' }, { col: 'asc' }] } } })
    if (!bus) throw errors.notFound('Bus not found')
    return { data: bus }
  })

  app.patch('/:busId', async (req) => {
    const { eventId, busId } = req.params as { eventId: string; busId: string }
    await requirePermission(req, 'bus.manage', { eventId })
    const body = busSchema.partial().parse(req.body)
    const updated = await prisma.$transaction(async (tx) => {
      if (!(await lockBusForSeatMutation(tx, busId, eventId))) throw errors.notFound('Bus not found')
      const bus = await tx.bus.findFirst({ where: { id: busId, eventId } })
      if (!bus) throw errors.notFound('Bus not found')

      if (body.layout) {
        const now = new Date()
        const protectedSeats = await tx.busSeat.count({
          where: {
            busId,
            OR: [
              { state: 'RESERVED' },
              { state: 'HELD', holdExpiresAt: { gt: now } },
            ],
          },
        })
        if (protectedSeats > 0) throw errors.conflict('Cannot rebuild layout while seats are reserved or actively held')
        const seats = buildSeats(body.layout)
        await tx.busSeat.deleteMany({ where: { busId } })
        await tx.busSeat.createMany({ data: seats.map(s => ({ busId, label: s.label, row: s.row, col: s.col, state: s.state })) })
      }

      await tx.bus.update({
        where: { id: busId },
        data: {
          name: body.name ?? bus.name,
          layout: body.layout ? body.layout as any : undefined,
          seatPrice: body.seatPrice ?? bus.seatPrice,
          currency: body.currency ?? bus.currency,
          isActive: body.isActive ?? bus.isActive,
        },
      })
      return tx.bus.findUnique({ where: { id: busId }, include: { seats: true } })
    })
    return { data: updated }
  })

  app.delete('/:busId', async (req, reply) => {
    const { eventId, busId } = req.params as { eventId: string; busId: string }
    await requirePermission(req, 'bus.manage', { eventId })
    await prisma.$transaction(async (tx) => {
      if (!(await lockBusForSeatMutation(tx, busId, eventId))) throw errors.notFound('Bus not found')
      const now = new Date()
      const protectedSeats = await tx.busSeat.count({
        where: {
          busId,
          OR: [
            { state: 'RESERVED' },
            { state: 'HELD', holdExpiresAt: { gt: now } },
          ],
        },
      })
      if (protectedSeats > 0) throw errors.conflict('Cannot delete bus with reserved or actively held seats')
      await tx.bus.delete({ where: { id: busId } })
    })
    return reply.status(204).send()
  })

  app.patch('/:busId/seats/:seatId', async (req) => {
    const { eventId, busId, seatId } = req.params as { eventId: string; busId: string; seatId: string }
    await requirePermission(req, 'bus.manage', { eventId })
    const body = z.object({ state: z.enum(['AVAILABLE', 'UNAVAILABLE']) }).parse(req.body)
    const updated = await prisma.$transaction(async (tx) => {
      if (!(await lockBusForSeatMutation(tx, busId, eventId))) throw errors.notFound('Bus not found')
      const seat = await tx.busSeat.findFirst({ where: { id: seatId, busId, bus: { eventId } } })
      if (!seat) throw errors.notFound('Seat not found')
      if (seat.state === 'RESERVED' || seat.ticketId) {
        throw errors.conflict('Ticket-linked or reserved seats cannot be changed directly; use the ticket cancellation or refund workflow')
      }
      if (seat.state === 'HELD' && seat.holdExpiresAt && seat.holdExpiresAt > new Date()) {
        throw errors.conflict('An actively held seat cannot be changed')
      }
      return tx.busSeat.update({
        where: { id: seatId },
        data: {
          state: body.state,
          holderName: null,
          passengerName: null,
          passengerEmail: null,
          passengerPhone: null,
          groupId: null,
          ticketId: null,
          holdToken: null,
          holdExpiresAt: null,
          reservedAt: null,
        },
      })
    })
    return { data: updated }
  })

  app.post('/:busId/reserve', async (req) => {
    const { eventId, busId } = req.params as { eventId: string; busId: string }
    await requirePermission(req, 'bus.reserve', { eventId })
    const body = reserveSchema.parse(req.body)
    if (new Set(body.seatIds).size !== body.seatIds.length) throw errors.badRequest('Duplicate seat IDs are not allowed')
    const groupId = body.groupId ?? crypto.randomUUID()

    const result = await prisma.$transaction(async (tx) => {
      if (!(await lockBusForSeatMutation(tx, busId, eventId, true))) throw errors.notFound('Active bus not found')
      const seats = await tx.busSeat.findMany({ where: { id: { in: body.seatIds }, busId, bus: { eventId, isActive: true } } })
      if (seats.length !== body.seatIds.length) throw errors.notFound('One or more seats not found')
      const blocked = seats.filter(s => s.state !== 'AVAILABLE')
      if (blocked.length) throw errors.conflict(`Seats already reserved or unavailable: ${blocked.map(s => s.label).join(', ')}`)
      if (body.ticketId) {
        const ticket = await tx.ticket.findFirst({ where: { id: body.ticketId, eventId } })
        if (!ticket) throw errors.notFound('Ticket not found')
        const existing = await tx.busSeat.findFirst({ where: { ticketId: body.ticketId } })
        if (existing) throw errors.conflict('Ticket already has a seat assigned')
      }
      for (const id of body.seatIds) {
        const p = body.passengers?.find(x => x.seatId === id)
        const updated = await tx.busSeat.updateMany({
          where: { id, busId, state: 'AVAILABLE' },
          data: {
            state: 'RESERVED',
            holderName: body.holderName,
            passengerName: p?.name ?? body.holderName,
            passengerEmail: p?.email ?? null,
            passengerPhone: p?.phone ?? null,
            groupId,
            ticketId: body.ticketId ?? null,
            reservedAt: new Date(),
            holdToken: null,
            holdExpiresAt: null,
          },
        })
        if (updated.count !== 1) throw errors.conflict('Seat reservation conflict — refresh and retry')
      }
      return tx.busSeat.findMany({ where: { id: { in: body.seatIds } } })
    })

    await writeAudit({ eventId, actorUserId: req.user.id, action: 'bus.seats.reserved', resourceType: 'bus', resourceId: busId, newValue: { seatIds: body.seatIds, holderName: body.holderName, groupId, ticketId: body.ticketId ?? null }, sourceIp: req.ip })
    return { data: { groupId, seats: result } }
  })

  app.post('/:busId/release', async (req) => {
    const { eventId, busId } = req.params as { eventId: string; busId: string }
    await requirePermission(req, 'bus.manage', { eventId })
    const body = z.object({ seatIds: z.array(z.string()).min(1) }).parse(req.body)
    if (new Set(body.seatIds).size !== body.seatIds.length) throw errors.badRequest('Duplicate seat IDs are not allowed')
    const released = await prisma.$transaction(async (tx) => {
      if (!(await lockBusForSeatMutation(tx, busId, eventId))) throw errors.notFound('Bus not found')
      const seats = await tx.busSeat.findMany({ where: { id: { in: body.seatIds }, busId } })
      if (seats.length !== body.seatIds.length) throw errors.notFound('One or more seats not found')
      const linked = seats.filter(s => s.state === 'RESERVED' && s.ticketId !== null)
      if (linked.length) {
        throw errors.conflict('Ticket-linked seats cannot be released directly; cancel or refund the ticket to free the seat')
      }
      const result = await tx.busSeat.updateMany({
        where: { id: { in: body.seatIds }, busId, state: { in: ['RESERVED', 'HELD'] }, ticketId: null },
        data: {
          state: 'AVAILABLE',
          holderName: null,
          passengerName: null,
          passengerEmail: null,
          passengerPhone: null,
          groupId: null,
          ticketId: null,
          holdToken: null,
          holdExpiresAt: null,
          reservedAt: null,
        },
      })
      return result.count
    })
    await writeAudit({
      eventId,
      actorUserId: req.user.id,
      action: 'bus.seats.released',
      resourceType: 'bus',
      resourceId: busId,
      newValue: { seatIds: body.seatIds, releasedCount: released },
      sourceIp: req.ip,
    })
    return { data: { ok: true, releasedCount: released } }
  })

  app.post('/:busId/hold', async (req) => {
    const { eventId, busId } = req.params as { eventId: string; busId: string }
    await requirePermission(req, 'bus.reserve', { eventId })
    const body = z.object({ seatIds: z.array(z.string()).min(1).max(20), holdMinutes: z.number().int().min(1).max(30).optional(), sessionId: z.string().optional() }).parse(req.body)
    if (new Set(body.seatIds).size !== body.seatIds.length) throw errors.badRequest('Duplicate seat IDs are not allowed')
    const holdToken = body.sessionId || crypto.randomUUID()
    const holdExpiresAt = new Date(Date.now() + (body.holdMinutes ?? 10) * 60_000)
    const now = new Date()
    const result = await prisma.$transaction(async (tx) => {
      if (!(await lockBusForSeatMutation(tx, busId, eventId, true))) throw errors.notFound('Active bus not found')
      const seats = await tx.busSeat.findMany({ where: { id: { in: body.seatIds }, busId, bus: { eventId, isActive: true } } })
      if (seats.length !== body.seatIds.length) throw errors.notFound('One or more seats not found')
      const blocked = seats.filter(s => !(
        s.state === 'AVAILABLE'
        || (s.state === 'HELD' && s.holdToken === holdToken && s.holdExpiresAt && s.holdExpiresAt > now)
        || (s.state === 'HELD' && s.holdExpiresAt && s.holdExpiresAt <= now)
      ))
      if (blocked.length) throw errors.conflict(`Seats unavailable: ${blocked.map(s => s.label).join(', ')}`)
      for (const id of body.seatIds) {
        const updated = await tx.busSeat.updateMany({
          where: {
            id,
            busId,
            OR: [
              { state: 'AVAILABLE' },
              { state: 'HELD', holdToken, holdExpiresAt: { gt: now } },
              { state: 'HELD', holdExpiresAt: { lte: now } },
            ],
          },
          data: { state: 'HELD', holdToken, holdExpiresAt, groupId: null, ticketId: null, reservedAt: null },
        })
        if (updated.count !== 1) throw errors.conflict('Seat hold conflict — refresh and retry')
      }
      return tx.busSeat.findMany({ where: { id: { in: body.seatIds } } })
    })
    return { data: { holdToken, holdExpiresAt: holdExpiresAt.toISOString(), seats: result } }
  })

  app.get('/:busId/manifest.xlsx', async (req, reply) => {
    const { eventId, busId } = req.params as { eventId: string; busId: string }
    await requirePermission(req, 'report.export', { eventId })
    const bus = await prisma.bus.findFirst({ where: { id: busId, eventId }, include: { seats: { orderBy: [{ row: 'asc' }, { col: 'asc' }], include: { ticket: { select: { id: true, reservationCode: true, attendee: { select: { name: true, email: true, phone: true } } } } } } } })
    if (!bus) throw errors.notFound('Bus not found')
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Seat manifest')
    ws.columns = [
      { header: 'Seat', key: 'label', width: 10 }, { header: 'Row', key: 'row', width: 8 }, { header: 'Col', key: 'col', width: 8 },
      { header: 'State', key: 'state', width: 12 }, { header: 'Passenger', key: 'passenger', width: 24 }, { header: 'Passenger email', key: 'email', width: 28 },
      { header: 'Passenger phone', key: 'phone', width: 18 }, { header: 'Group', key: 'group', width: 20 }, { header: 'Reservation', key: 'reservation', width: 22 },
      { header: 'Ticket holder', key: 'holder', width: 24 },
    ]
    for (const s of bus.seats as any[]) {
      ws.addRow({ label: s.label, row: s.row, col: s.col, state: s.state, passenger: s.passengerName ?? '', email: s.passengerEmail ?? s.ticket?.attendee?.email ?? '', phone: s.passengerPhone ?? s.ticket?.attendee?.phone ?? '', group: s.groupId ?? '', reservation: s.ticket?.reservationCode ?? '', holder: s.holderName ?? s.ticket?.attendee?.name ?? '' })
    }
    const buf = await wb.xlsx.writeBuffer()
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', `attachment; filename="bus-${bus.name}-manifest.xlsx"`)
    return reply.send(Buffer.from(buf))
  })
}

