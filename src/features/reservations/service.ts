import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { credentialCode, generateUniqueShortCode, type CredentialPayload } from '../../lib/credentials.js'
import { getDeliveryAdapter, ticketEmailShell } from '../../lib/delivery.js'
import { createTicketQrAttachment, TICKET_QR_CID } from '../../lib/qr.js'
import { config } from '../../config.js'
import { writeAudit } from '../../lib/audit.js'
import { AuditActions } from '../../lib/audit-actions.js'
import { addOutboxEvent } from '../../lib/outbox.js'
import { dispatchEventWebhooks } from '../integrations/dispatch.js'
import { logActivity } from '../../lib/activity.js'
import { purgeReservationTx } from './purge.js'

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

type StoredTicketDesign = {
  templateId?: string
  paletteId?: string
  panelColor?: string
  accentColor?: string
  backgroundColor?: string
  textColor?: string
}

function ticketDesignFromMetadata(metadata: unknown): StoredTicketDesign | null {
  const value = metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>).ticketDesign
    : null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const design = value as Record<string, unknown>
  const color = (input: unknown) => typeof input === 'string' && /^#[0-9a-fA-F]{6}$/.test(input) ? input : undefined
  return {
    templateId: design.templateId === 'editorial-wide' ? 'editorial-wide' : 'signature-split',
    paletteId: ['obsidian-gold', 'rose-noir', 'champagne', 'custom'].includes(String(design.paletteId)) ? String(design.paletteId) : 'obsidian-gold',
    panelColor: color(design.panelColor),
    accentColor: color(design.accentColor),
    backgroundColor: color(design.backgroundColor),
    textColor: color(design.textColor),
  }
}

function ticketDateLabel(date: Date, timezone = 'UTC'): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone || 'UTC',
  }
  try {
    return new Intl.DateTimeFormat('en-GB', options).format(date)
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(date)
  }
}

export async function resendReservationCredential(params: {
  eventId: string
  ticketId: string
  actorUserId: string | null
  actorName: string
  toEmail?: string
}): Promise<{ ticket: any; credential: any; deliveryOk: boolean }> {
  const ticket = await prisma.ticket.findFirst({
    where: { id: params.ticketId, eventId: params.eventId },
    include: {
      attendee: { select: { id: true, name: true, email: true, phone: true } },
      ticketType: { select: { id: true, name: true, price: true } },
      credential: true,
      event: { select: { id: true, orgId: true, name: true, startAt: true, endAt: true, timezone: true, venueName: true, settings: true } },
    },
  })
  if (!ticket) throw errors.notFound('Reservation not found')
  if (!canIssueReservationCredential(ticket as any)) {
    throw errors.conflict('Reservation is not eligible for credential delivery')
  }
  if (!ticket.credential) {
    throw errors.conflict('Credential has not been issued for this reservation')
  }
  const to = (params.toEmail ?? ticket.attendee.email ?? '').trim()
  if (!to) throw errors.badRequest('Recipient email is missing')

  const settings = ((ticket.event as any).settings ?? {}) as Record<string, any>
  const tpl = (settings.ticketEmail ?? {}) as Record<string, any>
  const qrAttachment = await createTicketQrAttachment(ticket.credential.code)
  const codeOf = reservationCodeOf(ticket as any)
  const shortCode = (ticket.credential as any).shortCode ?? null
  const attempt = (ticket.deliveryAttempts ?? 0) + 1
  const previewSeats = await prisma.busSeat.findMany({
    where: { ticketId: ticket.id },
    select: { label: true, bus: { select: { name: true } } },
    orderBy: { label: 'asc' },
  }).catch(() => [] as any[])
  const ticketDesign = ticketDesignFromMetadata(ticket.metadata)
  const ticketPreview = {
    attendeeName: ticket.attendee.name,
    eventName: ticket.event.name,
    ticketTypeName: ticket.ticketType.name,
    dateTime: ticketDateLabel(ticket.event.startAt, ticket.event.timezone),
    venue: ticket.event.venueName,
    seat: previewSeats.map((seat: any) => `${seat.bus?.name ? seat.bus.name + ' ' : ''}${seat.label}`).join(', ') || null,
    reference: codeOf ?? shortCode ?? ticket.id.slice(0, 8),
  }
  const delivery = await getDeliveryAdapter('EMAIL').send({
    to,
    subject: typeof tpl.subject === 'string' && tpl.subject ? tpl.subject.replace('{event}', ticket.event.name) : `Your ticket — ${ticket.event.name}`,
    html: ticketEmailShell({
      preheader: typeof tpl.preheader === 'string' && tpl.preheader ? tpl.preheader : `Ticket for ${ticket.event.name} — present your QR at check-in`,
      title: typeof tpl.title === 'string' && tpl.title ? tpl.title.replace('{event}', ticket.event.name) : `Your ticket for ${ticket.event.name}`,
      body: typeof tpl.body === 'string' && tpl.body ? tpl.body.replaceAll('{event}', ticket.event.name) : `Here is your signed QR ticket for ${ticket.event.name}. Present it at check-in.`,
      rows: [
        { label: 'Event', value: ticket.event.name },
        { label: 'Ticket', value: ticket.ticketType.name },
        { label: 'Date', value: ticketDateLabel(ticket.event.startAt, ticket.event.timezone) },
        { label: 'Venue', value: ticket.event.venueName ?? 'TBA' },
        ...(codeOf ? [{ label: 'Reservation', value: codeOf }] : []),
        ...(shortCode ? [{ label: 'Ticket code', value: shortCode }] : []),
        ...await (async () => {
          const seats = await prisma.busSeat.findMany({ where: { ticketId: ticket.id }, select: { label: true, passengerName: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } }).catch(() => [] as any[])
          return seats.length ? [{ label: 'Seats', value: seats.map((s: any) => `${s.bus?.name ? s.bus.name + ' ' : ''}${s.label}${s.passengerName ? ` (${s.passengerName})` : ''}`).join(', ') }] : []
        })(),
      ],
      qrCid: TICKET_QR_CID,
      titleAr: typeof tpl.titleAr === 'string' && tpl.titleAr ? tpl.titleAr.replaceAll('{event}', ticket.event.name) : 'تأكيد الحجز وإصدار التذكرة',
      bodyAr: typeof tpl.bodyAr === 'string' && tpl.bodyAr ? tpl.bodyAr.replaceAll('{event}', ticket.event.name) : 'حجزك مؤكد. يرجى إظهار رمز QR عند بوابة الدخول.',
      ticketUrl: codeOf ? new URL(`/my-ticket#code=${encodeURIComponent(codeOf)}`, config.env === 'production' && config.publicUrl.includes('localhost') ? 'https://ticketak.vercel.app' : config.publicUrl).toString() : undefined,
      footer: typeof tpl.footer === 'string' && tpl.footer ? tpl.footer : 'TKT · YOUR EXPERIENCE STARTS HERE',
      design: tpl.design && typeof tpl.design === 'object' ? tpl.design : undefined,
      ticketDesign,
      ticketPreview,
    }),
    attachments: [qrAttachment],
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
    recipient: to,
    provider: delivery.provider,
    providerMessageId: delivery.providerMessageId ?? null,
    error: delivery.error ?? null,
    attempt,
    metadata: { resend: true, toOverride: Boolean(params.toEmail) },
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
 * Email an already-minted credential and record the delivery attempt.
 * Split out of issueReservationCredential so the public reservation endpoint
 * can mint the QR synchronously and hand the SMTP round-trip to a
 * fire-and-forget task. TODO: replace that pattern with a durable queue.
 */
export async function deliverReservationCredentialEmail(params: {
  event: { id: string; orgId: string; name: string; startAt: Date; endAt: Date | null; timezone?: string; venueName: string | null; settings?: unknown }
  ticket: ReservationTicket
  credential: { id: string; code: string; shortCode?: string | null }
  issuerUserId?: string | null
}): Promise<boolean> {
  const { event, ticket, credential, issuerUserId = null } = params
  const codeOf = reservationCodeOf(ticket)
  const shortCode = credential.shortCode ?? null
  const qrAttachment = await createTicketQrAttachment(credential.code)
  const attempt = ((ticket as any).deliveryAttempts ?? 0) + 1
  const settings = ((event as any).settings ?? {}) as Record<string, any>
  const tpl = (settings.ticketEmail ?? {}) as Record<string, any>
  const eventDate = ticketDateLabel(event.startAt, event.timezone)
  const previewSeats = await prisma.busSeat.findMany({
    where: { ticketId: ticket.id },
    select: { label: true, bus: { select: { name: true } } },
    orderBy: { label: 'asc' },
  }).catch(() => [] as any[])
  const ticketDesign = ticketDesignFromMetadata(ticket.metadata)
  const ticketPreview = {
    attendeeName: ticket.attendee.name,
    eventName: event.name,
    ticketTypeName: ticket.ticketType.name,
    dateTime: eventDate,
    venue: event.venueName,
    seat: previewSeats.map((seat: any) => `${seat.bus?.name ? seat.bus.name + ' ' : ''}${seat.label}`).join(', ') || null,
    reference: codeOf ?? shortCode ?? ticket.id.slice(0, 8),
  }
  const delivery = await getDeliveryAdapter('EMAIL').send({
    to: ticket.attendee.email ?? '',
    subject: typeof tpl.subject === 'string' && tpl.subject ? tpl.subject.replaceAll('{event}', event.name) : `Your ticket — ${event.name}`,
    html: ticketEmailShell({
      preheader: typeof tpl.preheader === 'string' && tpl.preheader ? tpl.preheader.replaceAll('{event}', event.name) : `Ticket for ${event.name} — present your QR at check-in`,
      title: typeof tpl.title === 'string' && tpl.title ? tpl.title.replaceAll('{event}', event.name) : `You're in, ${ticket.attendee.name.split(' ')[0]}`,
      body: typeof tpl.body === 'string' && tpl.body ? tpl.body.replaceAll('{event}', event.name) : `Your reservation for ${event.name} is confirmed. Show this QR at the gate — it is signed, single-use and cannot be forged.`,
      rows: [
        { label: 'Event', value: event.name },
        { label: 'Ticket', value: ticket.ticketType.name },
        { label: 'Date', value: eventDate },
        { label: 'Venue', value: event.venueName ?? 'TBA' },
        ...(codeOf ? [{ label: 'Reservation', value: codeOf }] : []),
        ...(shortCode ? [{ label: 'Ticket code', value: shortCode }] : []),
        ...await (async () => {
          const seats = await prisma.busSeat.findMany({ where: { ticketId: ticket.id }, select: { label: true, passengerName: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } }).catch(() => [] as any[])
          return seats.length ? [{ label: 'Seats', value: seats.map((s: any) => `${s.bus?.name ? s.bus.name + ' ' : ''}${s.label}${s.passengerName ? ` (${s.passengerName})` : ''}`).join(', ') }] : []
        })(),
      ],
      qrCid: TICKET_QR_CID,
      titleAr: typeof tpl.titleAr === 'string' && tpl.titleAr ? tpl.titleAr.replaceAll('{event}', event.name) : 'تم تأكيد حجزك بنجاح!',
      bodyAr: typeof tpl.bodyAr === 'string' && tpl.bodyAr ? tpl.bodyAr.replaceAll('{event}', event.name) : `مرحباً ${ticket.attendee.name.split(' ')[0]}، يسعدنا تأكيد حجزك. تذكرتك جاهزة الآن.`,
      ticketUrl: codeOf ? new URL(`/my-ticket#code=${encodeURIComponent(codeOf)}`, config.env === 'production' && config.publicUrl.includes('localhost') ? 'https://ticketak.vercel.app' : config.publicUrl).toString() : undefined,
      footer: typeof tpl.footer === 'string' && tpl.footer ? tpl.footer : 'TKT · YOUR EXPERIENCE STARTS HERE',
      design: tpl.design && typeof tpl.design === 'object' ? tpl.design : undefined,
      ticketDesign,
      ticketPreview,
    }),
    attachments: [qrAttachment],
  })

  const deliveryOk = delivery.ok
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
    createdById: issuerUserId,
  })

  await writeAudit({
    organizationId: event.orgId,
    eventId: event.id,
    actorUserId: issuerUserId,
    action: deliveryOk ? AuditActions.CREDENTIAL_DELIVERY_SENT : AuditActions.CREDENTIAL_DELIVERY_FAILED,
    resourceType: 'ticket',
    resourceId: ticket.id,
    newValue: { channel: 'EMAIL', credentialId: credential.id },
  })

  // Issuance audit + webhook live here too: the public reservation path calls
  // this helper after the HTTP response, so neither write blocks the attendee.
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
  return deliveryOk
}

/**
 * Mint a signed TKT1 credential for a reservation ticket and email the
 * QR ticket to the attendee when sendEmail is true. Idempotent per ticket.
 */
export async function issueReservationCredential(params: {
  event: { id: string; orgId: string; name: string; startAt: Date; endAt: Date | null; timezone?: string; venueName: string | null; settings?: unknown }
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

  if (sendEmail) {
    await deliverReservationCredentialEmail({
      event,
      ticket,
      credential: { id: credential.id, code, shortCode },
      issuerUserId: issuerUserId ?? null,
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
  /** Extra fields merged into the single ticket update (e.g. review metadata). */
  metadata?: Record<string, unknown>
  /** Callers that already loaded the event can avoid one more round-trip. */
  event?: { id: string; orgId: string; name: string; startAt: Date; endAt: Date | null; venueName: string | null; settings?: unknown }
}): Promise<{ ticket: any; credential: any | null; alreadyDecided: boolean; purged?: boolean; deliveryEventId?: string }> {
  const { eventId, ticketId, approved, actorUserId, reason, metadata: extraMetadata, event: loadedEvent } = params

  const event = loadedEvent ?? await prisma.event.findUnique({ where: { id: eventId } })
  if (!event || event.id !== eventId) throw errors.notFound('Event not found')

  const eventForCred = {
    id: event.id, orgId: event.orgId, name: event.name, startAt: event.startAt,
    endAt: event.endAt, venueName: event.venueName, settings: event.settings,
  }
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
      if (same) return { ticket: current, credential: current.credential, alreadyDecided: true, purged: false, deliveryEventId: undefined as string | undefined }
      throw errors.conflict('Reservation is not awaiting approval')
    }

    const meta = (current.metadata as Record<string, any>) ?? {}
    const paid = isPaidTicket(current)
    const rejectionReason = reason?.trim() || 'Rejected by event team'
    const reviewedMeta = { ...meta, ...extraMetadata }
    const decidedMeta = {
      ...reviewedMeta,
      approval: approved ? 'APPROVED' : 'REJECTED',
      rejectedReason: approved ? null : rejectionReason,
    }
    const snapshot = {
      ...current,
      status: approved ? 'ACTIVE' : 'CANCELLED',
      approvalStatus: approved ? 'APPROVED' : 'REJECTED',
      paymentStatus: approved ? (paid ? 'CONFIRMED' : 'NOT_REQUIRED') : 'FAILED',
      metadata: {
        ...decidedMeta,
        ...(approved
          ? { approvedAt: new Date().toISOString(), approvedById: actorUserId }
          : { rejectedAt: new Date().toISOString() }),
      },
      credential: null,
    }

    // The delivery work is recorded in the same transaction as the decision,
    // then executed only after the HTTP response has been sent.
    if (approved) {
      const nextState = reservationStatePatch({ paid, approved, rejected: false })
      const now = new Date()
      const ticket = await tx.ticket.update({
        where: { id: current.id },
        data: {
          status: 'ACTIVE',
          approvedAt: now,
          approvedById: actorUserId,
          rejectedReason: null,
          paymentConfirmedAt: paid ? now : null,
          ...nextState,
          metadata: {
            ...decidedMeta,
            approvedAt: now.toISOString(),
            approvedById: actorUserId,
            rejectedReason: null,
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
        data: { status: 'CONFIRMED' },
      })
      const deliveryEventId = await addOutboxEvent(tx, 'CREDENTIAL_ISSUED', {
        event: eventForCred,
        ticket: {
          id: ticket.id,
          eventId,
          metadata: ticket.metadata,
          price: ticket.price,
          status: ticket.status,
          reservationCode: reservationCodeOf(ticket),
          reservationEmail: ticket.reservationEmail ?? null,
          reservationPhone: ticket.reservationPhone ?? null,
          reservationName: ticket.reservationName ?? null,
          approvalStatus: ticket.approvalStatus,
          paymentStatus: ticket.paymentStatus,
          deliveryAttempts: ticket.deliveryAttempts ?? 0,
          attendee: {
            id: current.attendee.id,
            name: current.attendee.name,
            email: current.attendee.email ?? null,
            phone: current.attendee.phone ?? null,
          },
          ticketType: {
            id: current.ticketType.id,
            name: current.ticketType.name,
            price: current.ticketType.price,
          },
        },
      } as any)
      return {
        ticket: { ...ticket, attendee: current.attendee, ticketType: current.ticketType },
        credential: ticket.credential,
        alreadyDecided: false,
        purged: false,
        deliveryEventId,
      }
    }

    await purgeReservationTx(tx, current)
    const deliveryEventId = await addOutboxEvent(tx, 'EMAIL_SEND', {
      to: current.attendee.email ?? '',
      subject: `Reservation update — ${event.name}`,
      html: ticketEmailShell({
        preheader: `Your reservation for ${event.name}`,
        title: 'Reservation not approved',
        body: `We're sorry — your reservation for <strong>${event.name}</strong> could not be approved. If you believe this is a mistake, contact the event team directly.`,
        rows: [
          { label: 'Event', value: event.name },
          { label: 'Ticket', value: current.ticketType.name },
          ...((reservationCodeOf(current) || reservationCodeOf(snapshot))
            ? [{ label: 'Reservation', value: reservationCodeOf(current) ?? reservationCodeOf(snapshot)! }]
            : []),
          { label: 'Status', value: 'Not approved' },
        ],
        footer: 'TKT · Control center for live events',
      }),
    })
    return { ticket: snapshot, credential: null, alreadyDecided: false, purged: true, deliveryEventId }
  }, { maxWait: 10_000, timeout: 30_000 })

  if (decided.alreadyDecided) {
    return { ticket: decided.ticket, credential: decided.credential, alreadyDecided: true }
  }

  let credential = decided.credential
  if (approved && !decided.purged) {
    // Mint the QR before responding so approvals return it immediately; only
    // the SMTP round-trip is left to the outbox.
    const issued = await issueReservationCredential({
      event: eventForCred,
      ticket: decided.ticket as any,
      issuerUserId: actorUserId,
      sendEmail: false,
    })
    credential = issued.credential
  }

  await writeAudit({
    organizationId: event.orgId,
    eventId,
    actorUserId,
    action: approved ? AuditActions.RESERVATION_APPROVED : AuditActions.RESERVATION_REJECTED,
    resourceType: 'ticket',
    resourceId: decided.ticket.id,
    previousValue: { approval: 'PENDING' },
    newValue: approved
      ? { approval: 'APPROVED', paymentStatus: reservationPaymentOf(decided.ticket) }
      : { approval: 'REJECTED', reason: reason?.trim() || 'Rejected by event team' },
  })
  logActivity(
    eventId,
    'reservation',
    `${approved ? 'Reservation approved' : 'Reservation rejected'} · ${reservationCodeOf(decided.ticket) ?? decided.ticket.id.slice(0, 8)}`,
    params.actorName,
  )

  return {
    ticket: { ...decided.ticket, credential },
    credential,
    alreadyDecided: false,
    purged: decided.purged,
    deliveryEventId: decided.deliveryEventId,
  }
}