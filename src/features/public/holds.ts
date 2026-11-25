import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { clearExpiredBusSeatHolds, lockBusForSeatMutation } from '../buses/seat-mutations.js'

const seatIdsSchema = z.array(z.string().min(1)).min(1).max(20)
  .refine((ids) => new Set(ids).size === ids.length, 'Seat IDs must be unique')

export async function holdRoutes(app: FastifyInstance) {
  app.post('/events/:eventId/buses/:busId/hold', async (req) => {
    const { eventId, busId } = req.params as { eventId: string; busId: string }
    const body = z.object({
      seatIds: seatIdsSchema,
      sessionId: z.string().min(8).max(120),
      holdMinutes: z.number().int().min(1).max(20).optional(),
    }).parse(req.body)
    const holdExpiresAt = new Date(Date.now() + (body.holdMinutes ?? 10) * 60_000)
    const now = new Date()

    const seats = await prisma.$transaction(async (tx) => {
      // All public/admin seat mutations for this bus serialize on the same row.
      await lockBusForSeatMutation(tx, eventId, busId, true)
      await clearExpiredBusSeatHolds(tx, busId, now)

      const rows = await tx.busSeat.findMany({
        where: { id: { in: body.seatIds }, busId },
      })
      if (rows.length !== body.seatIds.length) throw errors.notFound('One or more seats not found')

      const blocked = rows.filter((seat) => !(
        seat.state === 'AVAILABLE'
        || (seat.state === 'HELD' && seat.holdToken === body.sessionId
          && seat.holdExpiresAt && seat.holdExpiresAt > now)
      ))
      if (blocked.length) {
        throw errors.conflict(`Seats unavailable: ${blocked.map((seat) => seat.label).join(', ')}`)
      }

      for (const id of body.seatIds) {
        const updated = await tx.busSeat.updateMany({
          where: {
            id,
            busId,
            OR: [
              { state: 'AVAILABLE' },
              { state: 'HELD', holdToken: body.sessionId, holdExpiresAt: { gt: now } },
            ],
          },
          data: {
            state: 'HELD',
            holdToken: body.sessionId,
            holdExpiresAt,
            ticketId: null,
            groupId: null,
            reservedAt: null,
          },
        })
        if (updated.count !== 1) throw errors.conflict('A seat was taken by another reservation')
      }

      return tx.busSeat.findMany({
        where: { id: { in: body.seatIds }, busId },
        select: { id: true, label: true, row: true, col: true, state: true, holdExpiresAt: true },
      })
    })

    return { data: { holdToken: body.sessionId, holdExpiresAt: holdExpiresAt.toISOString(), seats } }
  })

  app.post('/events/:eventId/buses/:busId/release-hold', async (req) => {
    const { eventId, busId } = req.params as { eventId: string; busId: string }
    const body = z.object({
      seatIds: seatIdsSchema,
      sessionId: z.string().min(8).max(120),
    }).parse(req.body)

    const released = await prisma.$transaction(async (tx) => {
      await lockBusForSeatMutation(tx, eventId, busId)
      const result = await tx.busSeat.updateMany({
        where: {
          id: { in: body.seatIds },
          busId,
          state: 'HELD',
          holdToken: body.sessionId,
        },
        data: {
          state: 'AVAILABLE',
          holdToken: null,
          holdExpiresAt: null,
          holderName: null,
          passengerName: null,
          passengerEmail: null,
          passengerPhone: null,
          groupId: null,
          ticketId: null,
          reservedAt: null,
        },
      })
      return result.count
    })

    return { data: { ok: true, released } }
  })
}
