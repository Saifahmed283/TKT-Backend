import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'

async function lockBus(tx: Prisma.TransactionClient, busId: string, eventId: string, activeOnly = false) {
  const activeClause = activeOnly ? Prisma.sql`AND "isActive" = TRUE` : Prisma.empty
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Bus"
    WHERE "id" = ${busId} AND "eventId" = ${eventId} ${activeClause}
    FOR UPDATE
  `)
  return rows.length > 0
}

export async function holdRoutes(app: FastifyInstance) {
app.post('/events/:eventId/buses/:busId/hold', async (req) => {
    const { eventId, busId } = req.params as { eventId: string; busId: string }
    const body = z.object({ seatIds: z.array(z.string()).min(1).max(20), sessionId: z.string().min(8).max(120), holdMinutes: z.number().int().min(1).max(20).optional() }).parse(req.body)
    if (new Set(body.seatIds).size !== body.seatIds.length) throw errors.badRequest('Duplicate seat IDs are not allowed')
    const holdExpiresAt = new Date(Date.now() + (body.holdMinutes ?? 10) * 60_000)
    const now = new Date()
    const seats = await prisma.$transaction(async (tx) => {
      if (!(await lockBus(tx, busId, eventId, true))) throw errors.notFound('Active bus not found')
      const rows = await tx.busSeat.findMany({ where: { id: { in: body.seatIds }, busId, bus: { eventId, isActive: true } } })
      if (rows.length !== body.seatIds.length) throw errors.notFound('One or more seats not found')
      const blocked = rows.filter(s => !(
        s.state === 'AVAILABLE'
        || (s.state === 'HELD' && s.holdToken === body.sessionId && s.holdExpiresAt && s.holdExpiresAt > now)
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
              { state: 'HELD', holdToken: body.sessionId, holdExpiresAt: { gt: now } },
              { state: 'HELD', holdExpiresAt: { lte: now } },
            ],
          },
          data: { state: 'HELD', holdToken: body.sessionId, holdExpiresAt, ticketId: null, groupId: null, reservedAt: null },
        })
        if (updated.count !== 1) throw errors.conflict('Seat hold conflict — please reselect the seat')
      }
      return tx.busSeat.findMany({ where: { id: { in: body.seatIds } }, select: { id: true, label: true, row: true, col: true, state: true, holdExpiresAt: true } })
    })
    return { data: { holdToken: body.sessionId, holdExpiresAt: holdExpiresAt.toISOString(), seats } }
  })

  app.post('/events/:eventId/buses/:busId/release-hold', async (req) => {
    const { eventId, busId } = req.params as { eventId: string; busId: string }
    const body = z.object({ seatIds: z.array(z.string()).min(1).max(20), sessionId: z.string().min(8).max(120) }).parse(req.body)
    if (new Set(body.seatIds).size !== body.seatIds.length) throw errors.badRequest('Duplicate seat IDs are not allowed')
    await prisma.$transaction(async (tx) => {
      if (!(await lockBus(tx, busId, eventId))) throw errors.notFound('Bus not found')
      await tx.busSeat.updateMany({
      where: { id: { in: body.seatIds }, busId, bus: { eventId }, state: 'HELD', holdToken: body.sessionId },
      data: { state: 'AVAILABLE', holdToken: null, holdExpiresAt: null, holderName: null, passengerName: null, passengerEmail: null, passengerPhone: null, groupId: null, ticketId: null, reservedAt: null },
      })
    })
    return { data: { ok: true } }
  })

}
