import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { credentialCode, type CredentialPayload } from '../../lib/credentials.js'
import { sendMail, ticketEmailShell } from '../../lib/mailer.js'
import { qrDataUrl } from '../../lib/qr.js'
import { writeAudit } from '../../lib/audit.js'

export type ReservationTicket = {
  id: string
  metadata: unknown
  price: unknown
  attendee: { id: string; name: string; email: string | null; phone: string | null }
  ticketType: { id: string; name: string; price: unknown }
}

export function reservationApprovalOf(ticket: { metadata: unknown; price?: unknown }): 'APPROVED' | 'PENDING' | 'REJECTED' {
  const meta = (ticket.metadata as Record<string, any>) ?? {}
  if (meta.channel !== 'public') return 'APPROVED'
  return meta.approval ?? (Number(meta.price ?? ticket.price ?? 0) > 0 ? 'PENDING' : 'APPROVED')
}

export function reservationCodeOf(ticket: { metadata: unknown }): string | null {
  const meta = (ticket.metadata as Record<string, any>) ?? {}
  return typeof meta.reservationCode === 'string' ? meta.reservationCode : null
}

export function isPaidTicket(ticket: { price: unknown; ticketType: { price: unknown } }): boolean {
  const price = Number(ticket.price ?? ticket.ticketType.price ?? 0)
  return Number.isFinite(price) && price > 0
}

/**
 * Mint a signed TKT1 credential for a reservation ticket and email the
 * QR ticket to the attendee. Idempotent per ticket.
 */
export async function issueReservationCredential(params: {
  event: { id: string; orgId: string; name: string; startAt: Date; endAt: Date | null; venueName: string | null }
  ticket: ReservationTicket
  issuerUserId?: string
  sendEmail?: boolean
}): Promise<{ credential: any; qrCode: string }> {
  const { event, ticket, issuerUserId, sendEmail = true } = params

  const existing = await prisma.credential.findUnique({ where: { ticketId: ticket.id } })
  if (existing) return { credential: existing, qrCode: existing.code }

  const payload: CredentialPayload = {
    v: 1,
    credId: '',
    attendeeId: ticket.attendee.id,
    eventId: event.id,
    ticketType: ticket.ticketType.name,
    attendeeName: ticket.attendee.name,
    validFrom: event.startAt.getTime(),
    validUntil: event.endAt ? event.endAt.getTime() : null,
    singleUse: true,
    allowReentry: false,
  }

  const credential = await prisma.credential.create({
    data: {
      eventId: event.id,
      attendeeId: ticket.attendee.id,
      ticketId: ticket.id,
      type: 'QR',
      code: `PENDING-${randomUUID()}`,
      status: 'ACTIVE',
      validFrom: event.startAt,
      validUntil: event.endAt,
      singleUse: true,
      allowReentry: false,
      areaIds: [],
      issuedById: issuerUserId,
    },
  })
  payload.credId = credential.id
  const code = credentialCode.encode(payload)
  const final = await prisma.credential.update({ where: { id: credential.id }, data: { code } })

  if (sendEmail) {
    const codeOf = reservationCodeOf(ticket)
    const qr = await qrDataUrl(code).catch(() => null)
    await sendMail({
      to: ticket.attendee.email ?? '',
      subject: `Your ticket — ${event.name}`,
      html: ticketEmailShell({
        preheader: `Ticket for ${event.name} — present your QR at check-in`,
        title: `You're in, ${ticket.attendee.name.split(' ')[0]}`,
        body: `Your reservation for <strong>${event.name}</strong> is confirmed. Show this QR at the gate — it is signed, single-use and cannot be forged.`,
        rows: [
          { label: 'Event', value: event.name },
          { label: 'Ticket', value: ticket.ticketType.name },
          { label: 'Date', value: event.startAt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) },
          { label: 'Venue', value: event.venueName ?? 'TBA' },
          ...(codeOf ? [{ label: 'Reservation', value: codeOf }] : []),
        ],
        qrDataUrl: qr,
        footer: 'TKT · Control center for live events',
      }),
    })
  }

  await writeAudit({
    organizationId: event.orgId,
    eventId: event.id,
    actorUserId: issuerUserId,
    action: 'credential.issued_via_reservation',
    resourceType: 'credential',
    resourceId: credential.id,
    newValue: { attendeeId: ticket.attendee.id, ticketId: ticket.id, channel: 'public' },
  })
  return { credential: final, qrCode: code }
}

/** Approve or reject a pending public reservation ticket. */
export async function decideReservation(params: {
  eventId: string
  ticketId: string
  approved: boolean
  actorUserId: string
  actorName: string
}): Promise<{ ticket: any; credential: any | null }> {
  const { eventId, ticketId, approved, actorUserId } = params

  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, eventId },
    include: {
      attendee: { select: { id: true, name: true, email: true, phone: true } },
      ticketType: { select: { id: true, name: true, price: true } },
    },
  })
  if (!ticket) throw errors.notFound('Reservation not found')
  if (reservationApprovalOf(ticket) !== 'PENDING') throw errors.conflict('Reservation is not awaiting approval')

  const event = await prisma.event.findUnique({ where: { id: eventId } })
  if (!event) throw errors.notFound('Event not found')
  const eventForCred = { id: event.id, orgId: event.orgId, name: event.name, startAt: event.startAt, endAt: event.endAt, venueName: event.venueName }

  let credential: any = null
  const meta = (ticket.metadata as Record<string, any>) ?? {}
  if (approved) {
    const issued = await issueReservationCredential({ event: eventForCred, ticket, issuerUserId: actorUserId })
    credential = issued.credential
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: 'ACTIVE', metadata: { ...meta, approval: 'APPROVED' } },
    })
    await prisma.attendee.update({ where: { id: ticket.attendeeId }, data: { status: 'CONFIRMED' } })
    await writeAudit({
      organizationId: event.orgId,
      eventId,
      actorUserId,
      action: 'reservation.approved',
      resourceType: 'ticket',
      resourceId: ticket.id,
      previousValue: { approval: 'PENDING' },
      newValue: { approval: 'APPROVED' },
    })
  } else {
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: 'CANCELLED', metadata: { ...meta, approval: 'REJECTED' } },
    })
    await prisma.attendee.update({ where: { id: ticket.attendeeId }, data: { status: 'CANCELLED' } })
    const codeOf = reservationCodeOf(ticket)
    await sendMail({
      to: ticket.attendee.email ?? '',
      subject: `Reservation update — ${event.name}`,
      html: ticketEmailShell({
        preheader: `Your reservation for ${event.name}`,
        title: 'Reservation not approved',
        body: `We're sorry — your reservation for <strong>${event.name}</strong> could not be approved. If you believe this is a mistake, contact the event team directly.`,
        rows: [
          { label: 'Event', value: event.name },
          { label: 'Ticket', value: ticket.ticketType.name },
          ...(codeOf ? [{ label: 'Reservation', value: codeOf }] : []),
          { label: 'Status', value: 'Not approved' },
        ],
        footer: 'TKT · Control center for live events',
      }),
    })
    await writeAudit({
      organizationId: event.orgId,
      eventId,
      actorUserId,
      action: 'reservation.rejected',
      resourceType: 'ticket',
      resourceId: ticket.id,
      previousValue: { approval: 'PENDING' },
      newValue: { approval: 'REJECTED' },
    })
  }

  const updated = await prisma.ticket.findUnique({ where: { id: ticket.id } })
  return { ticket: updated, credential }
}