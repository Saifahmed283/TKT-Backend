import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { config } from '../../config.js'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { runWithIsolatedDbContext } from '../../lib/dbContext.js'
import { addOutboxEvent } from '../../lib/outbox.js'
import {
  guestTokenExpiry,
  hashPassToken,
  signGuestPassToken,
  verifyGuestPassToken,
} from '../../lib/pass-tokens.js'
import { canIssueReservationCredential, issueReservationCredential, reservationApprovalOf, reservationPaymentOf } from '../reservations/service.js'

const THEMES = ['royal-gold', 'rose-blush', 'lilac-dream', 'emerald-wild', 'midnight-sky']
const HEX = /^#[0-9a-f]{6}$/i
const CONTROL = /[\u0000-\u001f\u007f]/g

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

export const DEFAULT_PASS_DESIGN = {
  theme: 'royal-gold',
  header: null,
  accent: null,
  quote: '',
}

export type PassActor = {
  userId?: string
  master?: boolean
  platformRole?: string | null
}

export type PassDesignConfig = {
  theme: string
  header: string | null
  accent: string | null
  quote: string
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function hex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return HEX.test(trimmed) ? trimmed.toLowerCase() : null
}

export function normalizePassDesign(input: unknown): PassDesignConfig {
  if (input == null) return { ...DEFAULT_PASS_DESIGN }
  const value = parseJson(input)
  if (!value) throw errors.badRequest('Invalid pass design')
  for (const key of ['theme', 'header', 'accent', 'quote']) {
    if (value[key] != null && typeof value[key] !== 'string') throw errors.badRequest('Invalid pass design')
  }
  const quote = String(value.quote ?? '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90)
  return {
    theme: THEMES.includes(String(value.theme)) ? String(value.theme) : DEFAULT_PASS_DESIGN.theme,
    header: hex(value.header),
    accent: hex(value.accent),
    quote,
  }
}

export function effectivePassDesign(ticket: { passConfig?: unknown }, eventDesign: { config?: unknown } | null): PassDesignConfig {
  const own = parseJson(ticket.passConfig)
  if (own && Object.keys(own).length > 0) return normalizePassDesign(own)
  return normalizePassDesign(eventDesign?.config ?? null)
}

export function assertPassServiceToken(header: string | undefined): void {
  if (!header || !config.pass.serviceToken) throw errors.unauthorized('Pass service authentication failed')
  const actual = createHash('sha256').update(header).digest()
  const expected = createHash('sha256').update(config.pass.serviceToken).digest()
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw errors.unauthorized('Pass service authentication failed')
  }
}

async function platformRoleOf(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } })
  return user?.platformRole ?? null
}

export async function visibleOrganizationIds(actor: PassActor): Promise<{ ids: string[]; all: boolean }> {
  if (actor.master || actor.platformRole === 'super_admin') {
    const orgs = await prisma.organization.findMany({ select: { id: true } })
    return { ids: orgs.map((org) => org.id), all: true }
  }
  if (!actor.userId) return { ids: [], all: false }

  const [orgMemberships, eventMemberships] = await Promise.all([
    prisma.organizationMember.findMany({
      where: { userId: actor.userId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
      select: { orgId: true },
    }),
    prisma.eventMember.findMany({
      where: { userId: actor.userId, status: 'ACTIVE' },
      select: { event: { select: { orgId: true } } },
    }),
  ])
  const ids = new Set<string>(orgMemberships.map((m) => m.orgId))
  for (const membership of eventMemberships) ids.add(membership.event.orgId)
  return { ids: [...ids], all: false }
}

export async function canAccessPassEvent(actor: PassActor, eventId: string): Promise<{ event: any; orgAdmin: boolean }> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: { org: { select: { id: true, name: true, slug: true } }, folder: { select: { id: true, name: true, color: true } }, passDesign: true },
  })
  if (!event) throw errors.notFound('Event not found')

  if (actor.master || actor.platformRole === 'super_admin') return { event, orgAdmin: true }
  if (!actor.userId) throw errors.forbidden()

  const orgMember = await prisma.organizationMember.findFirst({
    where: { orgId: event.orgId, userId: actor.userId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
    select: { role: true },
  })
  if (orgMember) return { event, orgAdmin: true }

  const eventMember = await prisma.eventMember.findFirst({
    where: { eventId, userId: actor.userId, status: 'ACTIVE' },
    select: { id: true },
  })
  if (eventMember) return { event, orgAdmin: false }
  throw errors.forbidden()
}

export async function listPassExplorer(actor: PassActor) {
  const visible = await visibleOrganizationIds(actor)
  if (visible.ids.length === 0) return { organizations: [] }

  const orgs = await prisma.organization.findMany({
    where: { id: { in: visible.ids } },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      folders: {
        select: { id: true, name: true, color: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      },
      events: {
        select: {
          id: true,
          name: true,
          status: true,
          startAt: true,
          endAt: true,
          folderId: true,
          type: true,
          _count: { select: { tickets: true } },
        },
        orderBy: { startAt: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  })

  const allowedEventIds = new Set<string>()
  if (visible.all || actor.master || actor.platformRole === 'super_admin') {
    for (const org of orgs) for (const event of org.events) allowedEventIds.add(event.id)
  } else if (actor.userId) {
    const [orgAdminEvents, assigned] = await Promise.all([
      prisma.event.findMany({
        where: { orgId: { in: visible.ids } },
        select: { id: true, orgId: true },
      }),
      prisma.eventMember.findMany({
        where: { userId: actor.userId, status: 'ACTIVE' },
        select: { eventId: true },
      }),
    ])
    const orgMemberships = await prisma.organizationMember.findMany({
      where: { userId: actor.userId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
      select: { orgId: true },
    })
    const adminOrgIds = new Set(orgMemberships.map((m) => m.orgId))
    for (const event of orgAdminEvents) {
      if (adminOrgIds.has(event.orgId)) allowedEventIds.add(event.id)
    }
    for (const membership of assigned) allowedEventIds.add(membership.eventId)
  }

  return {
    organizations: orgs.map((org) => ({
      ...org,
      events: org.events
        .filter((event) => allowedEventIds.has(event.id))
        .map((event) => ({ ...event, ticketCount: event._count.tickets })),
    })),
  }
}

export function passEligible(ticket: {
  status?: string | null
  approvalStatus?: string | null
  paymentStatus?: string | null
  metadata?: unknown
  price?: unknown
  attendee?: { email?: string | null } | null
}): boolean {
  const status = String(ticket.status ?? '').toUpperCase()
  if (status === 'CANCELLED' || status === 'REFUNDED') return false
  if (reservationApprovalOf(ticket as any) !== 'APPROVED') return false
  const payment = reservationPaymentOf(ticket as any)
  if (payment !== 'CONFIRMED' && payment !== 'NOT_REQUIRED') return false
  const meta = parseJson(ticket.metadata)
  if (meta?.channel !== 'public') return false
  return Boolean(ticket.attendee?.email)
}

export async function getEventAnalytics(actor: PassActor, eventId: string) {
  const { event } = await canAccessPassEvent(actor, eventId)
  const tickets = await prisma.ticket.findMany({
    where: { eventId },
    include: {
      attendee: { select: { id: true, name: true, email: true } },
      ticketType: { select: { id: true, name: true } },
      busSeats: { select: { label: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } },
    },
    orderBy: { issuedAt: 'desc' },
  })

  const eligible = tickets.filter((ticket) => passEligible(ticket as any))
  const byApproval = { APPROVED: 0, PENDING: 0, REJECTED: 0, NONE: 0 }
  const byPass = { NOT_ISSUED: 0, ISSUED: 0, DELIVERED: 0, FAILED: 0, REVOKED: 0 }
  for (const ticket of tickets) {
    const approval = reservationApprovalOf(ticket as any)
    if (approval in byApproval) byApproval[approval as keyof typeof byApproval] += 1
    const status = String((ticket as any).passIssueStatus ?? 'NOT_ISSUED')
    if (status in byPass) byPass[status as keyof typeof byPass] += 1
  }

  const attendees = new Set(tickets.map((ticket) => ticket.attendeeId))
  const ticketTypes = new Map<string, { id: string; name: string; count: number }>()
  for (const ticket of tickets) {
    const key = ticket.ticketTypeId
    const existing = ticketTypes.get(key) ?? { id: key, name: ticket.ticketType.name, count: 0 }
    existing.count += 1
    ticketTypes.set(key, existing)
  }

  return {
    event: {
      id: event.id,
      name: event.name,
      status: event.status,
      startAt: event.startAt,
      endAt: event.endAt,
      timezone: event.timezone,
      venueName: event.venueName,
      org: event.org,
      folder: event.folder,
    },
    stats: {
      people: attendees.size,
      tickets: tickets.length,
      eligiblePasses: eligible.length,
      approval: byApproval,
      pass: byPass,
      opened: tickets.filter((ticket: any) => ticket.passOpenedAt).length,
      customized: tickets.filter((ticket: any) => ticket.passCustomizedAt).length,
      ticketTypes: [...ticketTypes.values()].sort((a, b) => b.count - a.count),
    },
  }
}

export async function listPassTickets(actor: PassActor, eventId: string, filters: { approval?: string; passStatus?: string; q?: string }) {
  await canAccessPassEvent(actor, eventId)
  const tickets = await prisma.ticket.findMany({
    where: { eventId },
    include: {
      attendee: { select: { id: true, name: true, email: true, phone: true } },
      ticketType: { select: { id: true, name: true } },
      busSeats: { select: { label: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } },
      passDesign: { select: { id: true, config: true } },
      credential: { select: { id: true, code: true, shortCode: true } },
    },
    orderBy: { issuedAt: 'desc' },
  })

  const q = filters.q?.trim().toLowerCase()
  return tickets
    .filter((ticket) => {
      const approval = reservationApprovalOf(ticket as any)
      if (filters.approval && filters.approval !== 'ALL' && approval !== filters.approval) return false
      const passStatus = String((ticket as any).passIssueStatus ?? 'NOT_ISSUED')
      if (filters.passStatus && filters.passStatus !== 'ALL' && passStatus !== filters.passStatus) return false
      if (!q) return true
      return [ticket.id, ticket.reservationCode, ticket.attendee.name, ticket.attendee.email, ticket.reservationEmail]
        .some((value) => String(value ?? '').toLowerCase().includes(q))
    })
    .map((ticket) => ({
      id: ticket.id,
      reservationCode: ticket.reservationCode,
      name: ticket.attendee.name,
      email: ticket.attendee.email ?? ticket.reservationEmail,
      phone: ticket.attendee.phone ?? ticket.reservationPhone,
      ticketType: ticket.ticketType.name,
      seat: ticket.busSeats.map((seat) => `${seat.bus?.name ? `${seat.bus.name} ` : ''}${seat.label}`).join(', '),
      approval: reservationApprovalOf(ticket as any),
      payment: reservationPaymentOf(ticket as any),
      status: ticket.status,
      eligible: passEligible(ticket as any),
      passStatus: (ticket as any).passIssueStatus ?? 'NOT_ISSUED',
      passIssuedAt: (ticket as any).passIssuedAt ?? null,
      passOpenedAt: (ticket as any).passOpenedAt ?? null,
      passCustomizedAt: (ticket as any).passCustomizedAt ?? null,
      passTokenExpiresAt: (ticket as any).passTokenExpiresAt ?? null,
      design: effectivePassDesign(ticket as any, ticket.passDesign as any),
      hasCredential: Boolean(ticket.credential),
    }))
}

export async function getEventPassDesign(actor: PassActor, eventId: string) {
  const { event } = await canAccessPassEvent(actor, eventId)
  return {
    eventId,
    design: normalizePassDesign(event.passDesign?.config ?? null),
    eventName: event.name,
  }
}

export async function saveEventPassDesign(
  actor: PassActor,
  eventId: string,
  designInput: unknown,
  resetTickets: boolean,
) {
  const { event } = await canAccessPassEvent(actor, eventId)
  const design = normalizePassDesign(designInput)
  const config = design as unknown as Prisma.InputJsonValue

  await prisma.$transaction(async (tx) => {
    await tx.passDesign.upsert({
      where: { eventId },
      create: {
        orgId: event.orgId,
        eventId,
        config,
        status: 'ACTIVE',
        createdById: actor.userId ?? null,
        updatedById: actor.userId ?? null,
      },
      update: {
        orgId: event.orgId,
        status: 'ACTIVE',
        config,
        updatedById: actor.userId ?? null,
      },
    })
    if (resetTickets) {
      await tx.ticket.updateMany({ where: { eventId }, data: { passConfig: Prisma.DbNull } })
    }
  })
  return { eventId, design }
}

export async function resetEventPassDesign(actor: PassActor, eventId: string) {
  const { event } = await canAccessPassEvent(actor, eventId)
  await prisma.$transaction(async (tx) => {
    await tx.passDesign.upsert({
      where: { eventId },
      create: {
        orgId: event.orgId,
        eventId,
        config: DEFAULT_PASS_DESIGN as unknown as Prisma.InputJsonValue,
        status: 'ACTIVE',
        createdById: actor.userId ?? null,
        updatedById: actor.userId ?? null,
      },
      update: {
        config: DEFAULT_PASS_DESIGN as unknown as Prisma.InputJsonValue,
        status: 'ACTIVE',
        updatedById: actor.userId ?? null,
      },
    })
    await tx.ticket.updateMany({ where: { eventId }, data: { passConfig: Prisma.DbNull } })
  })
  return { eventId, design: { ...DEFAULT_PASS_DESIGN } }
}

/** Mint a fresh guest token for an eligible reservation ticket. The raw token is returned once. */
export async function issuePassForTicket(params: { ticketId: string; actorUserId?: string | null }): Promise<{ token: string; expiresAt: Date; ticketId: string }> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: params.ticketId },
    include: {
      attendee: { select: { id: true, name: true, email: true } },
      ticketType: { select: { id: true, name: true, price: true } },
      event: { select: { id: true, orgId: true, name: true, startAt: true, endAt: true, timezone: true, venueName: true, settings: true } },
      passDesign: { select: { id: true, config: true } },
      credential: { select: { id: true } },
    },
  })
  if (!ticket) throw errors.notFound('Ticket not found')
  if (!passEligible(ticket as any)) throw errors.conflict('Ticket is not eligible for a TKT-PASS')

  if (!ticket.credential) {
    await issueReservationCredential({
      event: {
        id: ticket.event.id,
        orgId: ticket.event.orgId,
        name: ticket.event.name,
        startAt: ticket.event.startAt,
        endAt: ticket.event.endAt,
        timezone: ticket.event.timezone ?? 'UTC',
        venueName: ticket.event.venueName,
        settings: ticket.event.settings,
      },
      ticket: ticket as any,
      issuerUserId: params.actorUserId ?? undefined,
      sendEmail: false,
    })
  }

  const sessionId = randomUUID()
  const expiresAt = guestTokenExpiry(ticket.event.endAt)
  const token = await signGuestPassToken({ ticketId: ticket.id, sessionId, expiresAt })
  const design = effectivePassDesign(ticket as any, ticket.passDesign as any)

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      passDesignId: ticket.passDesign?.id ?? null,
      passConfig: design as unknown as Prisma.InputJsonValue,
      passSessionId: sessionId,
      passTokenHash: hashPassToken(token),
      passTokenExpiresAt: expiresAt,
      passIssueStatus: 'ISSUED',
      passIssuedAt: new Date(),
      passCustomizedAt: null,
    },
  })

  return { token, expiresAt, ticketId: ticket.id }
}

export async function queuePassIssue(
  tx: Prisma.TransactionClient,
  ticketId: string,
  actorUserId?: string | null,
): Promise<string> {
  return addOutboxEvent(tx, 'PASS_ISSUED', {
    ticketId,
    actorUserId: actorUserId ?? null,
  })
}

export async function queuePassIssueStandalone(ticketId: string, actorUserId?: string | null): Promise<string> {
  return prisma.$transaction((tx) => queuePassIssue(tx, ticketId, actorUserId))
}

export async function deliverPassEmail(ticketId: string, token: string): Promise<void> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      attendee: { select: { id: true, name: true, email: true } },
      event: { select: { id: true, name: true, startAt: true, endAt: true, timezone: true } },
      busSeats: { select: { label: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } },
    },
  })
  if (!ticket) throw errors.notFound('Ticket not found')

  const dateLabel = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: ticket.event.timezone || 'UTC',
  }).format(ticket.event.startAt)
  const seat = ticket.busSeats.map((row) => `${row.bus?.name ? `${row.bus.name} ` : ''}${row.label}`).join(', ')

  if (!config.pass.siteUrl || !config.pass.serviceToken) {
    throw errors.internal('TKT-PASS delivery is not configured')
  }
  // Keep the established Gmail pacing between pass deliveries.
  await sleep(config.pass.sendDelayMs)
  const response = await fetch(`${config.pass.siteUrl.replace(/\/$/, '')}/api/internal/pass-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-TKT-Service-Token': config.pass.serviceToken,
    },
    body: JSON.stringify({
      token,
      ticketId: ticket.id,
      to: ticket.attendee.email ?? ticket.reservationEmail,
      name: ticket.attendee.name ?? ticket.reservationName ?? 'Guest',
      seat: seat || 'General Admission',
      eventTitle: ticket.event.name,
      eventDate: dateLabel,
    }),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw errors.internal(payload.error ?? `Pass email delivery failed (${response.status})`)

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      passIssueStatus: 'DELIVERED',
      passLastDeliveryAt: new Date(),
      passDeliveryAttempts: { increment: 1 },
    },
  }).catch(() => undefined)
}

/** Successful pass emails sent in the current Cairo day (for Gmail's daily cap). */
export async function passDeliveryCount(): Promise<number> {
  return runWithIsolatedDbContext({ isInternal: true }, async () => {
    const rows = await prisma.$queryRaw<Array<{ sent: number }>>`
      SELECT count(*)::int AS sent
      FROM "Ticket"
      WHERE "passLastDeliveryAt" >= (date_trunc('day', now() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo')
    `
    return Number(rows[0]?.sent ?? 0)
  })
}

export async function resendPassTicket(actor: PassActor, ticketId: string) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, eventId: true, approvalStatus: true, metadata: true, price: true, status: true, paymentStatus: true, attendee: { select: { email: true } } },
  })
  if (!ticket) throw errors.notFound('Ticket not found')
  await canAccessPassEvent(actor, ticket.eventId)
  if (!passEligible(ticket as any)) throw errors.conflict('Only approved reservations can receive a TKT-PASS')
  const outboxEventId = await queuePassIssueStandalone(ticket.id, actor.userId ?? null)
  return { ticketId: ticket.id, outboxEventId }
}

export async function resendPassTickets(actor: PassActor, ticketIds: string[]) {
  const ids = [...new Set(ticketIds.map(String).filter(Boolean))]
  if (ids.length === 0) return { queued: [] as Array<{ ticketId: string; outboxEventId: string }>, outboxEventIds: [] as string[] }

  const tickets = await prisma.ticket.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, eventId: true, approvalStatus: true, metadata: true, price: true,
      status: true, paymentStatus: true, attendee: { select: { email: true } },
    },
  })
  if (tickets.length !== ids.length) throw errors.notFound('One or more tickets were not found')

  for (const ticket of tickets) {
    await canAccessPassEvent(actor, ticket.eventId)
    if (!passEligible(ticket as any)) {
      throw errors.conflict(`Ticket ${ticket.id} is not eligible for a TKT-PASS`)
    }
  }

  const queued: Array<{ ticketId: string; outboxEventId: string }> = []
  for (const ticket of tickets) {
    const outboxEventId = await queuePassIssueStandalone(ticket.id, actor.userId ?? null)
    queued.push({ ticketId: ticket.id, outboxEventId })
  }
  return { queued, outboxEventIds: queued.map((item) => item.outboxEventId) }
}

export async function createPreviewToken(actor: PassActor, ticketId: string) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, eventId: true },
  })
  if (!ticket) throw errors.notFound('Ticket not found')
  await canAccessPassEvent(actor, ticket.eventId)
  const issued = await issuePassForTicket({ ticketId, actorUserId: actor.userId ?? null })
  return issued
}

export async function getGuestPass(token: string) {
  const claims = await verifyGuestPassToken(token)
  if (!claims) return { error: 'INVALID_LINK' as const }
  if (claims.expired) return { error: 'EXPIRED_LINK' as const }
  const ticket = await runWithIsolatedDbContext({ isInternal: true }, async () => {
    const row = await prisma.ticket.findFirst({
      where: {
        id: claims.ticketId,
        passTokenHash: hashPassToken(token),
        passSessionId: claims.sessionId,
      },
      include: {
        attendee: { select: { id: true, name: true, email: true } },
        event: { select: { id: true, name: true, startAt: true, endAt: true, timezone: true, venueName: true, settings: true, org: { select: { name: true } } } },
        passDesign: { select: { id: true, config: true } },
        ticketType: { select: { id: true, name: true } },
        busSeats: { select: { label: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } },
      },
    })
    if (!row) return null
    await prisma.ticket.update({
      where: { id: row.id },
      data: { passOpenedAt: row.passOpenedAt ?? new Date() },
    }).catch(() => undefined)
    return row
  })

  if (!ticket) return { error: 'INVALID_LINK' as const }
  if ((ticket as any).passTokenExpiresAt && (ticket as any).passTokenExpiresAt.getTime() < Date.now()) {
    return { error: 'EXPIRED_LINK' as const }
  }

  const settings = parseJson(ticket.event.settings) ?? {}
  const branding = parseJson(settings.branding)
  const subtitle = typeof branding?.tagline === 'string' ? branding.tagline : undefined
  const dateLabel = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: ticket.event.timezone || 'UTC',
  }).format(ticket.event.startAt)
  const seat = ticket.busSeats.map((row) => `${row.bus?.name ? `${row.bus.name} ` : ''}${row.label}`).join(', ')

  return {
    ticket: {
      id: ticket.reservationCode ?? ticket.id,
      name: ticket.attendee.name ?? ticket.reservationName ?? 'Guest',
      seat: seat || 'General Admission',
      eventTitle: ticket.event.name,
      eventSubtitle: subtitle ?? ticket.event.org.name,
      location: ticket.event.venueName ?? 'TBA',
      eventDate: dateLabel,
      startsAt: ticket.event.startAt.toISOString(),
      endsAt: ticket.event.endAt?.toISOString() ?? null,
      ticketType: ticket.ticketType.name,
    },
    design: effectivePassDesign(ticket as any, ticket.passDesign as any),
    expiresAt: claims.expiresAt.toISOString(),
  }
}

export async function saveGuestPassDesign(token: string, designInput: unknown) {
  const claims = await verifyGuestPassToken(token)
  if (!claims) return { error: 'INVALID_LINK' as const }
  if (claims.expired) return { error: 'EXPIRED_LINK' as const }
  const design = normalizePassDesign(designInput)
  const updated = await runWithIsolatedDbContext({ isInternal: true }, async () => {
    const ticket = await prisma.ticket.findFirst({
      where: {
        id: claims.ticketId,
        passTokenHash: hashPassToken(token),
        passSessionId: claims.sessionId,
      },
      select: { id: true, passTokenExpiresAt: true },
    })
    if (!ticket) return null
    if (ticket.passTokenExpiresAt && ticket.passTokenExpiresAt.getTime() < Date.now()) return { expired: true }
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        passConfig: design as unknown as Prisma.InputJsonValue,
        passCustomizedAt: new Date(),
      },
    })
    return { ok: true }
  })
  if (!updated) return { error: 'INVALID_LINK' as const }
  if ('expired' in updated) return { error: 'EXPIRED_LINK' as const }
  return updated
}

export async function resolveActorFromUser(userId: string): Promise<PassActor> {
  return { userId, platformRole: await platformRoleOf(userId), master: false }
}

export { canIssueReservationCredential }
