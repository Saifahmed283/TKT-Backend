import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { credentialCode, generateUniqueShortCode, type CredentialPayload } from '../../lib/credentials.js'
import { getDeliveryAdapter, ticketEmailShell } from '../../lib/delivery.js'
import { qrDataUrl } from '../../lib/qr.js'
import { writeAudit } from '../../lib/audit.js'
import { AuditActions } from '../../lib/audit-actions.js'
import { dispatchEventWebhooks } from '../integrations/dispatch.js'
import { logActivity } from '../../lib/activity.js'

export type ReservationApproval = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED'
export type ReservationPayment = 'NOT_REQUIRED' | 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REFUNDED'

export type ReservationTicket = {
  id: string
  eventId?: string
  metadata: unknown
  price: unknown
  status?: string
  reservationCode?: string | null
  reservationEmail?: string | null
  reservationPhone?: string | null
  reservationName?: string | null
  approvalStatus?: ReservationApproval | string | null
  paymentStatus?: ReservationPayment | string | null
  deliveryChannel?: string | null
  attendee: { id: string; name: string; email: string | null; phone: string | null }
  ticketType: { id: string; name: string; price: unknown }
}

export function normalizeReservationEmail(email?: string | null): string | null {
  const v = String(email ?? '').trim().toLowerCase()
  return v || null
}

export function normalizeReservationPhone(phone?: string | null): string | null {
  const v = String(phone ?? '').replace(/[^0-9]+/g, '')
  return v || null
}

export function reservationCodeOf(ticket: { reservationCode?: string | null; metadata: unknown }): string | null {
  if (typeof ticket.reservationCode === 'string' && ticket.reservationCode.trim()) return ticket.reservationCode
  const meta = (ticket.metadata as Record<string, any>) ?? {}
  return typeof meta.reservationCode === 'string' && meta.reservationCode.trim() ? meta.reservationCode : null
}

export function reservationApprovalOf(ticket: { approvalStatus?: string | null; metadata: unknown; price?: unknown }): ReservationApproval {
  const explicit = String(ticket.approvalStatus ?? '').toUpperCase()
  if (explicit === 'PENDING' || explicit === 'APPROVED' || explicit === 'REJECTED' || explicit === 'NONE') {
    return explicit as ReservationApproval
  }
  const meta = (ticket.metadata as Record<string, any>) ?? {}
  if (meta.channel !== 'public') return 'APPROVED'
  const legacy = String(meta.approval ?? '').toUpperCase()
  if (legacy === 'PENDING' || legacy === 'APPROVED' || legacy === 'REJECTED') return legacy as ReservationApproval
  return Number(meta.price ?? ticket.price ?? 0) > 0 ? 'PENDING' : 'APPROVED'
}

export function reservationPaymentOf(ticket: { paymentStatus?: string | null; metadata: unknown; price?: unknown; approvalStatus?: string | null }): ReservationPayment {
  const explicit = String(ticket.paymentStatus ?? '').toUpperCase()
  if (explicit === 'NOT_REQUIRED' || explicit === 'PENDING' || explicit === 'CONFIRMED' || explicit === 'FAILED' || explicit === 'REFUNDED') {
    return explicit as ReservationPayment
  }
  const meta = (ticket.metadata as Record<string, any>) ?? {}
  const paid = Number(meta.price ?? ticket.price ?? 0) > 0
  if (!paid) return 'NOT_REQUIRED'
  const approval = reservationApprovalOf(ticket)
  if (approval === 'APPROVED') return 'CONFIRMED'
  if (approval === 'REJECTED') return 'FAILED'
  return 'PENDING'
}

export function isPaidTicket(ticket: { price: unknown; ticketType?: { price: unknown } }): boolean {
  const ticketPrice = Number(ticket.price)
  const typePrice = Number(ticket.ticketType?.price ?? 0)
  const price = Number.isFinite(ticketPrice) && ticketPrice > 0 ? ticketPrice : typePrice
  return Number.isFinite(price) && price > 0
}

export function canIssueReservationCredential(ticket: { status?: string; approvalStatus?: string | null; paymentStatus?: string | null; metadata: unknown; price?: unknown }): boolean {
  if (String(ticket.status ?? '').toUpperCase() === 'CANCELLED') return false
  const approval = reservationApprovalOf(ticket)
  if (approval !== 'APPROVED') return false
  const payment = reservationPaymentOf(ticket)
  if (payment === 'PENDING' || payment === 'FAILED') return false
  return true
}

export function reservationStatePatch(params: { paid: boolean; approved: boolean; rejected?: boolean }) {
  if (!params.paid) {
    return {
      approvalStatus: 'APPROVED' as const,
      paymentStatus: 'NOT_REQUIRED' as const,
    }
  }
  if (params.rejected) {
    return {
      approvalStatus: 'REJECTED' as const,
      paymentStatus: 'FAILED' as const,
    }
  }
  if (params.approved) {
    return {
      approvalStatus: 'APPROVED' as const,
      paymentStatus: 'CONFIRMED' as const,
    }
  }
  return {
    approvalStatus: 'PENDING' as const,
    paymentStatus: 'PENDING' as const,
  }
}

type DeliveryRecordInput = {
  eventId: string
  ticketId: string
  credentialId?: string | null
  channel: 'EMAIL' | 'WHATSAPP' | 'BOTH'
  status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED'
  recipient?: string | null
  provider?: string | null
  providerMessageId?: string | null
  error?: string | null
  attempt: number
  metadata?: Record<string, unknown>
  createdById?: string | null
}

async function recordDeliveryAttempt(input: DeliveryRecordInput) {
  return prisma.credentialDeliveryAttempt.create({ data: input as any }).catch(() => null)
}

export async function resendReservationCredential(params: {
  eventId: string
  ticketId: string
  actorUserId: string
  actorName: string
}): Promise<{ ticket: any; credential: any; deliveryOk: boolean }> {
  const ticket = await prisma.ticket.findFirst({
    where: { id: params.ticketId, eventId: params.eventId },
    include: {
      attendee: { select: { id: true, name: true, email: true, phone: true } },
      ticketType: { select: { id: true, name: true, price: true } },
      credential: true,
      event: { select: { id: true, orgId: true, name: true, startAt: true, endAt: true, venueName: true } },
    },
  })
  if (!ticket) throw errors.notFound('Reservation not found')
  if (!canIssueReservationCredential(ticket as any)) {
    throw errors.conflict('Reservation is not eligible for credential delivery')
  }
  if (!ticket.credential) {
    throw errors.conflict('Credential has not been issued for this reservation')
  }
  if (!ticket.attendee.email) throw errors.badRequest('Attendee email is missing')

  const qr = await qrDataUrl(ticket.credential.code).catch(() => null)
  const codeOf = reservationCodeOf(ticket as any)
  const attempt = (ticket.deliveryAttempts ?? 0) + 1
  const delivery = await getDeliveryAdapter('EMAIL').send({
    to: ticket.attendee.email,
    subject: `Your ticket — ${ticket.event.name}`,
    html: ticketEmailShell({
      preheader: `Ticket for ${ticket.event.name} — present your QR at check-in`,
      title: `Your ticket for ${ticket.event.name}`,
      body: `Here is your signed QR ticket for <strong>${ticket.event.name}</strong>. Present it at check-in.`,
      rows: [
        { label: 'Event', value: ticket.event.name },
        { label: 'Ticket', value: ticket.ticketType.name },
        { label: 'Date', value: ticket.event.startAt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) },
        { label: 'Venue', value: ticket.event.venueName ?? 'TBA' },
        ...(codeOf ? [{ label: 'Reservation', value: codeOf }] : []),
      ],
      qrDataUrl: qr,
      footer: 'TKT · Control center for live events',
    }),
  })
  const deliveryOk = delivery.ok

  const updated = await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      deliveryStatus: deliveryOk ? 'SENT' : 'FAILED',
      lastDeliveryAt: deliveryOk ? new Date() : undefined,
      deliveryAttempts: { increment: 1 },
      deliveryChannel: 'EMAIL',
    },
    include: { credential: { select: { id: true, code: true, status: true } } },
  })

  await recordDeliveryAttempt({
    eventId: ticket.eventId,
    ticketId: ticket.id,
    credentialId: ticket.credential.id,
    channel: 'EMAIL',
    status: deliveryOk ? 'SENT' : 'FAILED',
    recipient: ticket.attendee.email,
    provider: delivery.provider,
    providerMessageId: delivery.providerMessageId ?? null,
    error: delivery.error ?? null,
    attempt,
    metadata: { resend: true },
    createdById: params.actorUserId,
  })

  await writeAudit({
    organizationId: ticket.event.orgId,
    eventId: ticket.eventId,
    actorUserId: params.actorUserId,
    action: deliveryOk ? AuditActions.CREDENTIAL_DELIVERY_SENT : AuditActions.CREDENTIAL_DELIVERY_FAILED,
    resourceType: 'ticket',
    resourceId: ticket.id,
    newValue: { channel: 'EMAIL', credentialId: ticket.credential.id, resend: true },
  })
  logActivity(ticket.eventId, 'credential', `Credential ${deliveryOk ? 'resent' : 'resend failed'} · ${codeOf ?? ticket.id.slice(0, 8)}`, params.actorName)

  return { ticket: updated, credential: ticket.credential, deliveryOk }
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

  if (!canIssueReservationCredential(ticket)) {
    throw errors.conflict('Reservation is not eligible for credential issuance')
  }

  const existing = await prisma.credential.findUnique({ where: { ticketId: ticket.id } })
  if (existing) return { credential: existing, qrCode: existing.code }

  const shortCode = await generateUniqueShortCode()

  const payload: CredentialPayload = {
    v: 1,
    credId: '',
    shortCode,
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
      shortCode,
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

  let deliveryOk = false
  if (sendEmail) {
    const codeOf = reservationCodeOf(ticket)
    const qr = await qrDataUrl(code).catch(() => null)
    const attempt = ((ticket as any).deliveryAttempts ?? 0) + 1
    const delivery = await getDeliveryAdapter('EMAIL').send({
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
    deliveryOk = delivery.ok

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        deliveryStatus: deliveryOk ? 'SENT' : 'FAILED',
        lastDeliveryAt: deliveryOk ? new Date() : undefined,
        deliveryAttempts: { increment: 1 },
        deliveryChannel: 'EMAIL',
      },
    }).catch(() => {})

    await recordDeliveryAttempt({
      eventId: event.id,
      ticketId: ticket.id,
      credentialId: credential.id,
      channel: 'EMAIL',
      status: deliveryOk ? 'SENT' : 'FAILED',
      recipient: ticket.attendee.email ?? null,
      provider: delivery.provider,
      providerMessageId: delivery.providerMessageId ?? null,
      error: delivery.error ?? null,
      attempt,
      metadata: { source: 'reservation_issue' },
      createdById: issuerUserId ?? null,
    })
  }

  await writeAudit({
    organizationId: event.orgId,
    eventId: event.id,
    actorUserId: issuerUserId,
    action: AuditActions.CREDENTIAL_ISSUED_RESERVATION,
    resourceType: 'credential',
    resourceId: credential.id,
    newValue: { attendeeId: ticket.attendee.id, ticketId: ticket.id, channel: 'public', deliveryOk },
  })
  void dispatchEventWebhooks(event.id, 'credential.issued', { ticketId: ticket.id, credentialId: credential.id, attendeeId: ticket.attendee.id, deliveryOk })
  if (sendEmail) {
    await writeAudit({
      organizationId: event.orgId,
      eventId: event.id,
      actorUserId: issuerUserId,
      action: deliveryOk ? AuditActions.CREDENTIAL_DELIVERY_SENT : AuditActions.CREDENTIAL_DELIVERY_FAILED,
      resourceType: 'ticket',
      resourceId: ticket.id,
      newValue: { channel: 'EMAIL', credentialId: credential.id },
    })
  }
  return { credential: final, qrCode: code }
}

/** Approve or reject a pending public reservation ticket. */
export async function decideReservation(params: {
  eventId: string
  ticketId: string
  approved: boolean
  actorUserId: string
  actorName: string
  reason?: string
}): Promise<{ ticket: any; credential: any | null; alreadyDecided: boolean }> {
  const { eventId, ticketId, approved, actorUserId, reason } = params

  const event = await prisma.event.findUnique({ where: { id: eventId } })
  if (!event) throw errors.notFound('Event not found')

  const decided = await prisma.$transaction(async (tx) => {
    const current = await tx.ticket.findFirst({
      where: { id: ticketId, eventId },
      include: {
        attendee: { select: { id: true, name: true, email: true, phone: true } },
        ticketType: { select: { id: true, name: true, price: true } },
        credential: { select: { id: true, code: true, status: true } },
      },
    })
    if (!current) throw errors.notFound('Reservation not found')

    const approval = reservationApprovalOf(current)
    if (approval !== 'PENDING') {
      const same = (approved && approval === 'APPROVED') || (!approved && approval === 'REJECTED')
      if (same) return { ticket: current, credential: current.credential, alreadyDecided: true }
      throw errors.conflict('Reservation is not awaiting approval')
    }

    const meta = (current.metadata as Record<string, any>) ?? {}
    const paid = isPaidTicket(current)
    const nextState = reservationStatePatch({ paid, approved, rejected: !approved })

    const ticket = await tx.ticket.update({
      where: { id: current.id },
      data: {
        status: approved ? 'ACTIVE' : 'CANCELLED',
        approvedAt: approved ? new Date() : null,
        approvedById: actorUserId,
        rejectedReason: approved ? null : (reason?.trim() || 'Rejected by event team'),
        paymentConfirmedAt: approved && paid ? new Date() : null,
        ...nextState,
        metadata: {
          ...meta,
          approval: approved ? 'APPROVED' : 'REJECTED',
          approvedAt: approved ? new Date().toISOString() : null,
          approvedById: actorUserId,
          rejectedReason: approved ? null : (reason?.trim() || 'Rejected by event team'),
        },
      },
      include: {
        attendee: { select: { id: true, name: true, email: true, phone: true } },
        ticketType: { select: { id: true, name: true, price: true } },
        credential: { select: { id: true, code: true, status: true } },
      },
    })

    await tx.attendee.update({
      where: { id: current.attendeeId },
      data: { status: approved ? 'CONFIRMED' : 'CANCELLED' },
    })

    return { ticket, credential: ticket.credential, alreadyDecided: false }
  })

  if (decided.alreadyDecided) {
    return { ticket: decided.ticket, credential: decided.credential, alreadyDecided: true }
  }

  const eventForCred = { id: event.id, orgId: event.orgId, name: event.name, startAt: event.startAt, endAt: event.endAt, venueName: event.venueName }
  let credential = decided.credential

  if (approved) {
    const issued = await issueReservationCredential({
      event: eventForCred,
      ticket: decided.ticket as any,
      issuerUserId: actorUserId,
    })
    credential = issued.credential
    await writeAudit({
      organizationId: event.orgId,
      eventId,
      actorUserId,
      action: AuditActions.RESERVATION_APPROVED,
      resourceType: 'ticket',
      resourceId: decided.ticket.id,
      previousValue: { approval: 'PENDING' },
      newValue: { approval: 'APPROVED', paymentStatus: reservationPaymentOf(decided.ticket) },
    })
    logActivity(eventId, 'reservation', `Reservation approved · ${reservationCodeOf(decided.ticket) ?? decided.ticket.id.slice(0, 8)}`, params.actorName)
  } else {
    const codeOf = reservationCodeOf(decided.ticket)
    const rejectionDelivery = await getDeliveryAdapter('EMAIL').send({
      to: decided.ticket.attendee.email ?? '',
      subject: `Reservation update — ${event.name}`,
      html: ticketEmailShell({
        preheader: `Your reservation for ${event.name}`,
        title: 'Reservation not approved',
        body: `We're sorry — your reservation for <strong>${event.name}</strong> could not be approved. If you believe this is a mistake, contact the event team directly.`,
        rows: [
          { label: 'Event', value: event.name },
          { label: 'Ticket', value: decided.ticket.ticketType.name },
          ...(codeOf ? [{ label: 'Reservation', value: codeOf }] : []),
          { label: 'Status', value: 'Not approved' },
        ],
        footer: 'TKT · Control center for live events',
      }),
    }).catch(() => ({ ok: false, provider: 'smtp', providerMessageId: null, error: 'send failed' }))

    await prisma.ticket.update({
      where: { id: decided.ticket.id },
      data: {
        deliveryStatus: rejectionDelivery.ok ? 'SENT' : 'FAILED',
        lastDeliveryAt: rejectionDelivery.ok ? new Date() : undefined,
        deliveryAttempts: { increment: 1 },
        deliveryChannel: 'EMAIL',
      },
    }).catch(() => {})
    await recordDeliveryAttempt({
      eventId,
      ticketId: decided.ticket.id,
      credentialId: decided.ticket.credential?.id ?? null,
      channel: 'EMAIL',
      status: rejectionDelivery.ok ? 'SENT' : 'FAILED',
      recipient: decided.ticket.attendee.email ?? null,
      provider: rejectionDelivery.provider ?? 'smtp',
      providerMessageId: rejectionDelivery.providerMessageId ?? null,
      error: rejectionDelivery.error ?? null,
      attempt: ((decided.ticket as any).deliveryAttempts ?? 0) + 1,
      metadata: { source: 'reservation_rejected' },
      createdById: actorUserId,
    })

    await writeAudit({
      organizationId: event.orgId,
      eventId,
      actorUserId,
      action: AuditActions.RESERVATION_REJECTED,
      resourceType: 'ticket',
      resourceId: decided.ticket.id,
      previousValue: { approval: 'PENDING' },
      newValue: { approval: 'REJECTED', reason: reason?.trim() || 'Rejected by event team' },
    })
    logActivity(eventId, 'reservation', `Reservation rejected · ${reservationCodeOf(decided.ticket) ?? decided.ticket.id.slice(0, 8)}`, params.actorName)
  }

  const updated = await prisma.ticket.findUnique({
    where: { id: decided.ticket.id },
    include: { credential: { select: { id: true, code: true, status: true } } },
  })
  return { ticket: updated, credential, alreadyDecided: false }
}