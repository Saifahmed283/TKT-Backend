import type { Prisma } from '@prisma/client'
import { errors } from '../../lib/errors.js'

/**
 * Serializes seat mutations for one bus. Every workflow that changes a seat or
 * the bus layout/price must take this lock before reading or writing seats.
 */
export async function lockBusForSeatMutation(
  tx: Prisma.TransactionClient,
  eventId: string,
  busId: string,
  requireActive = false,
): Promise<void> {
  const buses = requireActive
    ? await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "Bus"
        WHERE "id" = ${busId} AND "eventId" = ${eventId} AND "isActive" = TRUE
        FOR UPDATE
      `
    : await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "Bus"
        WHERE "id" = ${busId} AND "eventId" = ${eventId}
        FOR UPDATE
      `

  if (buses.length !== 1) throw errors.notFound('Bus not found')
}

/** Make an expired hold available before the next operation evaluates a seat. */
export async function clearExpiredBusSeatHolds(
  tx: Prisma.TransactionClient,
  busId: string,
  now = new Date(),
): Promise<number> {
  const result = await tx.busSeat.updateMany({
    where: { busId, state: 'HELD', holdExpiresAt: { lte: now } },
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
}
