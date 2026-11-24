import fs from 'node:fs/promises'
import path from 'node:path'
import type { Prisma } from '@prisma/client'
import { config } from '../../config.js'
import { prisma } from '../../lib/db.js'

type PurgeableTicket = {
  id: string
  eventId: string
  attendeeId: string
  paymentProofUrl?: string | null
  metadata?: unknown
}

export async function deleteUploadedFile(url?: string | null) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) return
  const name = path.basename(url.split('?')[0] ?? '')
  if (!name || name.includes('..')) return
  await fs.unlink(path.resolve(process.cwd(), config.uploads.dir, name)).catch(() => {})
}

export async function purgeReservationTx(tx: Prisma.TransactionClient, ticket: PurgeableTicket) {
  const meta = (ticket.metadata ?? {}) as Record<string, unknown>
  const proof = ticket.paymentProofUrl ?? (typeof meta.paymentProofUrl === 'string' ? meta.paymentProofUrl : null)

  await tx.credentialDeliveryAttempt.deleteMany({ where: { ticketId: ticket.id } })
  const credentials = await tx.credential.findMany({ where: { ticketId: ticket.id }, select: { id: true } })
  const credentialIds = credentials.map((c) => c.id)
  if (credentialIds.length) {
    await tx.accessLog.deleteMany({ where: { credentialId: { in: credentialIds } } })
    await tx.credentialDeliveryAttempt.deleteMany({ where: { credentialId: { in: credentialIds } } })
  }
  await tx.credential.deleteMany({ where: { ticketId: ticket.id } })
  await tx.accessLog.deleteMany({ where: { attendeeId: ticket.attendeeId } })
  await tx.accessCode.updateMany({
    where: { redeemedTicketId: ticket.id },
    data: { redeemedTicketId: null, redeemedByAttendeeId: null, redeemedAt: null, lastRedeemedAt: null, redemptionCount: 0 },
  })
  await tx.busSeat.updateMany({
    where: { ticketId: ticket.id },
    data: { state: 'AVAILABLE', ticketId: null, holderName: null, passengerName: null, passengerEmail: null, passengerPhone: null, groupId: null, holdToken: null, holdExpiresAt: null, reservedAt: null },
  })
  await tx.ticket.delete({ where: { id: ticket.id } })
  const remaining = await tx.ticket.count({ where: { attendeeId: ticket.attendeeId } })
  if (remaining === 0) await tx.attendee.deleteMany({ where: { id: ticket.attendeeId } })
  await deleteUploadedFile(proof)
}

export async function purgeRejectedReservations() {
  await prisma.$executeRaw`SELECT set_config('app.is_internal', 'true', false)`
  const stale = await prisma.ticket.findMany({
    where: {
      OR: [
        { approvalStatus: 'REJECTED' },
        { paymentStatus: 'FAILED' },
        { status: 'CANCELLED', reservationCode: { not: null } },
        { status: 'CANCELLED', metadata: { path: ['approvalStatus'], equals: 'REJECTED' } },
        { status: 'CANCELLED', metadata: { path: ['paymentStatus'], equals: 'FAILED' } },
        { status: 'CANCELLED', metadata: { path: ['approval'], equals: 'REJECTED' } },
      ],
    },
    select: { id: true, eventId: true, attendeeId: true, paymentProofUrl: true, metadata: true },
  })
  for (const ticket of stale) {
    await prisma.$transaction((tx) => purgeReservationTx(tx, ticket))
  }
  return stale.length
}
