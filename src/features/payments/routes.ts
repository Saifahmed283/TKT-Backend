import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import ExcelJS from 'exceljs'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { AuditActions } from '../../lib/audit-actions.js'
import { decideReservation, reservationCodeOf, reservationPaymentOf } from '../reservations/service.js'
import { publish, channelFor } from '../../lib/realtime.js'
import { afterResponse } from '../../lib/background.js'
import { processOutboxEventIds } from '../../lib/outbox.js'
import { refreshProofUrl } from '../../lib/uploadStore.js'
import { acquireIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../../lib/idempotency.js'

const providerSchema = z.object({
  name: z.string().min(2),
  accountName: z.string().optional().nullable(),
  accountNumber: z.string().optional().nullable(),
  paymentPhone: z.string().optional().nullable(),
  paymentLink: z.string().url().optional().nullable().or(z.literal('')),
  instructions: z.string().optional().nullable(),
  imageUrl: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
})

const reviewSchema = z.object({
  action: z.enum(['CONFIRM', 'REJECT']),
  note: z.string().max(500).optional(),
})

/** Proofs live on the ticket column; metadata is the legacy location. */
function proofUrlOf(ticket: { paymentProofUrl?: string | null; metadata: unknown }) {
  const meta = (ticket.metadata ?? {}) as Record<string, unknown>
  const legacy = typeof meta.paymentProofUrl === 'string' ? meta.paymentProofUrl : null
  return refreshProofUrl(ticket.paymentProofUrl || legacy)
}

function toNumber(v: unknown) {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function getEstimatedCost(event: { settings: unknown }) {
  const s = (event.settings ?? {}) as Record<string, unknown>
  const finance = (s.finance ?? {}) as Record<string, unknown>
  return {
    estimatedCost: toNumber(finance.estimatedCost ?? s.estimatedCost),
    currency: typeof finance.currency === 'string' ? finance.currency : typeof s.currency === 'string' ? s.currency : 'EGP',
    notes: typeof finance.notes === 'string' ? finance.notes : '',
  }
}

export async function paymentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/providers', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'payment.view', { eventId })
    const providers = await prisma.paymentProvider.findMany({ where: { eventId }, orderBy: { createdAt: 'asc' } })
    return { data: providers }
  })

  app.post('/providers', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'payment.manage', { eventId })
    const body = providerSchema.parse(req.body)
    const provider = await prisma.paymentProvider.create({
      data: {
        eventId, name: body.name, accountName: body.accountName || null, accountNumber: body.accountNumber || null,
        paymentPhone: body.paymentPhone || null, paymentLink: body.paymentLink || null, instructions: body.instructions || null,
        imageUrl: body.imageUrl || null, isActive: body.isActive ?? true,
      },
    })
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    await writeAudit({ organizationId: event?.orgId, eventId, actorUserId: req.user.id, action: AuditActions.PAYMENT_PROVIDER_CREATED, resourceType: 'payment_provider', resourceId: provider.id, newValue: { name: provider.name }, sourceIp: req.ip })
    return reply.status(201).send({ data: provider })
  })

  app.patch('/providers/:providerId', async (req) => {
    const { eventId, providerId } = req.params as { eventId: string; providerId: string }
    await requirePermission(req, 'payment.manage', { eventId })
    const body = providerSchema.partial().parse(req.body)
    const existing = await prisma.paymentProvider.findUnique({ where: { id: providerId } })
    if (!existing || existing.eventId !== eventId) throw errors.notFound('Payment provider not found')
    const provider = await prisma.paymentProvider.update({ where: { id: providerId }, data: { ...body, paymentLink: body.paymentLink === '' ? null : body.paymentLink } })
    return { data: provider }
  })

  app.delete('/providers/:providerId', async (req, reply) => {
    const { eventId, providerId } = req.params as { eventId: string; providerId: string }
    await requirePermission(req, 'payment.manage', { eventId })
    const existing = await prisma.paymentProvider.findUnique({ where: { id: providerId } })
    if (!existing || existing.eventId !== eventId) throw errors.notFound('Payment provider not found')
    await prisma.paymentProvider.delete({ where: { id: providerId } })
    return reply.status(204).send()
  })

  app.get('/pending', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'payment.review', { eventId })
    const tickets = await prisma.ticket.findMany({
      where: {
        eventId,
        OR: [
          { paymentStatus: 'PENDING' },
          { metadata: { path: ['paymentStatus'], equals: 'PENDING' } },
        ],
      },
      include: { attendee: true, ticketType: { select: { id: true, name: true, category: true, price: true } } },
      orderBy: { issuedAt: 'desc' }, take: 200,
    })
    return {
      data: tickets.map((t) => {
        const meta = (t.metadata ?? {}) as Record<string, unknown>
        // The public reservation stores the proof on the ticket column; older
        // rows kept it in metadata. Freshly sign capability links so reviews
        // started long after upload can still display the image.
        return { ...t, reservationCode: reservationCodeOf(t as any), paymentReference: typeof meta.paymentReference === 'string' ? meta.paymentReference : null, paymentProofUrl: proofUrlOf(t), paymentProvider: typeof meta.paymentProvider === 'string' ? meta.paymentProvider : null }
      }),
    }
  })

  app.get('/reference/:reference', async (req) => {
    const { eventId, reference } = req.params as { eventId: string; reference: string }
    await requirePermission(req, 'payment.review', { eventId })
    const ref = decodeURIComponent(reference).trim()
    if (!ref) throw errors.badRequest('Reference is required')
    const tickets = await prisma.ticket.findMany({
      where: { eventId, metadata: { path: ['paymentReference'], equals: ref } },
      include: { attendee: true, ticketType: { select: { id: true, name: true } } },
      orderBy: { issuedAt: 'desc' }, take: 20,
    })
    return { data: tickets.map(t => {
      const meta = (t.metadata ?? {}) as Record<string, unknown>
      return {
        ...t,
        reservationCode: reservationCodeOf(t as any),
        paymentProofUrl: proofUrlOf(t),
      }
    }) }
  })

  app.post('/reference/:reference/fetch', async (req) => {
    const { eventId, reference } = req.params as { eventId: string; reference: string }
    await requirePermission(req, 'payment.review', { eventId })
    const ref = decodeURIComponent(reference).trim()
    if (!ref) throw errors.badRequest('Reference is required')

    const local = await prisma.ticket.findMany({
      where: { eventId, metadata: { path: ['paymentReference'], equals: ref } },
      include: { attendee: true, ticketType: { select: { id: true, name: true } }, paymentProvider: true },
      orderBy: { issuedAt: 'desc' }, take: 20,
    })

    // Provider adapter framework: real external fetch happens only when a provider exposes a configured fetch URL.
    // This keeps behavior auditable and safe without claiming fake external verification.
    const provider = local.find(t => t.paymentProviderId)?.paymentProvider ?? null
    const providerMeta = (provider as any)?.metadata && typeof (provider as any).metadata === 'object' ? (provider as any).metadata as Record<string, unknown> : {}
    const fetchUrlTemplate = typeof providerMeta.fetchUrlTemplate === 'string' ? providerMeta.fetchUrlTemplate : null
    let external: { attempted: boolean; ok: boolean; status?: number; body?: unknown; error?: string; url?: string } = { attempted: false, ok: false }

    if (fetchUrlTemplate) {
      // Deliberately synchronous: an admin opens this review action explicitly
      // to see the provider's response. It is not on the public burst path, so
      // the bounded 8s connection hold is an accepted tradeoff.
      const url = fetchUrlTemplate.replace('{reference}', encodeURIComponent(ref)).replace('{eventId}', encodeURIComponent(eventId))
      external.attempted = true
      external.url = url
      try {
        const headers: Record<string, string> = { Accept: 'application/json' }
        if (typeof providerMeta.fetchAuthHeader === 'string' && typeof providerMeta.fetchAuthValue === 'string') {
          headers[providerMeta.fetchAuthHeader] = providerMeta.fetchAuthValue
        }
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
        external.status = res.status
        external.ok = res.ok
        const text = await res.text()
        try { external.body = text ? JSON.parse(text) : null } catch { external.body = text.slice(0, 2000) }
      } catch (e: any) {
        external.error = e?.message ?? 'Fetch failed'
      }
    }

    const now = new Date().toISOString()
    const updatedIds: string[] = []
    for (const t of local) {
      const meta = (t.metadata ?? {}) as Record<string, unknown>
      const next = {
        ...meta,
        paymentReference: ref,
        proofFetchedAt: now,
        proofFetch: {
          byUserId: req.user.id,
          at: now,
          localMatchCount: local.length,
          external,
        },
      }
      await prisma.ticket.update({ where: { id: t.id }, data: { metadata: next as any } }).catch(() => null)
      updatedIds.push(t.id)
    }

    await writeAudit({
      organizationId: (await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } }))?.orgId,
      eventId, actorUserId: req.user.id, action: 'payment.reference_fetched',
      resourceType: 'payment_reference', resourceId: ref,
      newValue: { reference: ref, localMatchCount: local.length, updatedTicketIds: updatedIds, external }, sourceIp: req.ip,
    })

    return {
      data: {
        reference: ref,
        localMatchCount: local.length,
        tickets: local.map(t => ({ ...t, reservationCode: reservationCodeOf(t as any) })),
        external,
        message: external.attempted
          ? (external.ok ? 'Reference fetched from configured provider adapter.' : 'Provider adapter fetch attempted but did not confirm payment.')
          : 'No external provider fetch adapter configured; returned verified local TKT records for this reference.',
      },
    }
  })

  app.post('/reservations/:ticketId/review', async (req, reply) => {
    const { eventId, ticketId } = req.params as { eventId: string; ticketId: string }
    await requirePermission(req, 'payment.review', { eventId })
    const body = reviewSchema.parse(req.body)

    // Reserve the key before any mutation. A key is scoped to this route,
    // actor, ticket, event, and payload so it cannot replay a different review.
    const rawKey = req.headers['idempotency-key']
    const idempotencyKey = (Array.isArray(rawKey) ? rawKey[0] : rawKey)?.trim()
    let scopedKey: string | null = null
    let owner: string | null = null
    if (idempotencyKey && idempotencyKey.length <= 255) {
      scopedKey = [
        'POST',
        '/events/:eventId/payments/reservations/:ticketId/review',
        eventId,
        ticketId,
        req.user.id,
        body.action,
        body.note ?? '',
        idempotencyKey,
      ].join('|')
      const acquired = await acquireIdempotencyKey(prisma, scopedKey)
      if (acquired.state === 'acquired') owner = acquired.owner
      if (acquired.state === 'replay') return reply.send(acquired.response)
      if (acquired.state === 'processing') {
        throw errors.conflict('A request with this idempotency key is already in progress')
      }
    }

    let completed = false
    try {
      const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, include: { attendee: true, ticketType: true, event: true } })
      if (!ticket || ticket.eventId !== eventId) throw errors.notFound('Ticket not found')
      if (reservationPaymentOf(ticket) !== 'PENDING') throw errors.conflict('Payment is not pending review')

      const confirmedPayment = body.action === 'CONFIRM'
      const paymentStatus = confirmedPayment ? 'CONFIRMED' : 'FAILED'
      const reviewedAt = new Date().toISOString()
      const reviewMetadata = {
        paymentStatus,
        paymentReviewedAt: reviewedAt,
        reviewedByUserId: req.user.id,
        ...(confirmedPayment
          ? { paymentConfirmedAt: reviewedAt }
          : { paymentRejectedAt: reviewedAt, rejectedReason: body.note ?? 'Payment proof rejected' }),
      }

      // decideReservation folds review metadata into its own ticket update and
      // queues the QR/email in the same transaction, so this request never waits
      // on SMTP (or a second round of ticket writes).
      const decided = await decideReservation({
        eventId,
        ticketId,
        approved: confirmedPayment,
        actorUserId: req.user.id,
        actorName: req.user.name,
        reason: body.note,
        metadata: reviewMetadata,
        event: ticket.event,
      })

      // Pass delivery is durable outbox work. Await it before responding so a
      // serverless runtime cannot freeze mid-delivery; outbox retries still
      // absorb SMTP failures without losing the event.
      const deliveryEventIds = decided.deliveryEventIds ?? (decided.deliveryEventId ? [decided.deliveryEventId] : [])
      if (deliveryEventIds.length > 0) {
        await afterResponse(req, 'payment review delivery', { eventId }, () => processOutboxEventIds(deliveryEventIds))
      }
      publish(channelFor.reservation(eventId), confirmedPayment ? 'reservation.approved' : 'reservation.rejected', {
        ticketId,
        approval: confirmedPayment ? 'APPROVED' : 'REJECTED',
        alreadyDecided: decided.alreadyDecided,
      })
      await writeAudit({
        organizationId: ticket.event.orgId,
        eventId,
        actorUserId: req.user.id,
        action: confirmedPayment ? AuditActions.PAYMENT_CONFIRMED : AuditActions.PAYMENT_REJECTED,
        resourceType: 'ticket',
        resourceId: ticketId,
        newValue: { action: body.action, paymentStatus, approval: confirmedPayment ? 'APPROVED' : 'REJECTED', credentialId: decided.credential?.id ?? null },
        sourceIp: req.ip,
      })

      const response = {
        data: {
          ticket: decided.ticket,
          approval: confirmedPayment ? 'APPROVED' : 'REJECTED',
          paymentStatus,
          credentialId: decided.credential?.id ?? null,
          alreadyDecided: decided.alreadyDecided,
        },
      }

      if (scopedKey && owner) await completeIdempotencyKey(prisma, scopedKey, owner, response)
      completed = true
      return response
    } catch (error) {
      if (scopedKey && owner && !completed) {
        await releaseIdempotencyKey(prisma, scopedKey, owner).catch(() => undefined)
      }
      throw error
    }
  })

  app.get('/summary', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'payment.view', { eventId })

    const [event, tickets, ticketTypes] = await Promise.all([
      prisma.event.findUnique({ where: { id: eventId }, select: { settings: true } }),
      prisma.ticket.findMany({ where: { eventId }, select: { id: true, status: true, price: true, paymentStatus: true, metadata: true, ticketTypeId: true, ticketType: { select: { id: true, name: true, category: true, price: true } } } }),
      prisma.ticketType.findMany({ where: { eventId }, select: { id: true, name: true, category: true, price: true, quota: true, _count: { select: { tickets: true } } } }),
    ])
    if (!event) throw errors.notFound('Event not found')

    const byStatus: Record<string, number> = {}
    const byCategory: Record<string, { count: number; revenue: number }> = {}
    const byProvider: Record<string, { count: number; revenue: number }> = {}
    let confirmedRevenue = 0; let pendingRevenue = 0; let failedRevenue = 0; let refundedRevenue = 0

    for (const t of tickets) {
      const meta = (t.metadata ?? {}) as Record<string, unknown>
      const ps = reservationPaymentOf(t)
      byStatus[ps] = (byStatus[ps] ?? 0) + 1
      const amount = toNumber(t.price)
      if (ps === 'CONFIRMED' || ps === 'NOT_REQUIRED') confirmedRevenue += amount
      if (ps === 'PENDING') pendingRevenue += amount
      if (ps === 'FAILED') failedRevenue += amount
      if (ps === 'REFUNDED') refundedRevenue += amount
      const cat = t.ticketType?.category ?? 'UNCATEGORIZED'
      byCategory[cat] ??= { count: 0, revenue: 0 }; byCategory[cat].count += 1; if (ps === 'CONFIRMED' || ps === 'NOT_REQUIRED') byCategory[cat].revenue += amount
      const prov = typeof meta.paymentProvider === 'string' && meta.paymentProvider ? meta.paymentProvider : 'Unspecified'
      byProvider[prov] ??= { count: 0, revenue: 0 }; byProvider[prov].count += 1; if (ps === 'CONFIRMED' || ps === 'NOT_REQUIRED') byProvider[prov].revenue += amount
    }

    const totalCapacity = ticketTypes.reduce((s, t) => s + (t.quota ?? 0), 0)
    const soldCount = tickets.filter(t => t.status !== 'CANCELLED').length
    const remainingTickets = totalCapacity > 0 ? Math.max(0, totalCapacity - soldCount) : null
    const finance = getEstimatedCost(event)
    const netRevenue = confirmedRevenue - refundedRevenue

    return {
      data: {
        currency: finance.currency, estimatedCost: finance.estimatedCost, financeNotes: finance.notes,
        confirmedRevenue, pendingRevenue, failedRevenue, refundedRevenue, netRevenue, estimatedProfit: netRevenue - finance.estimatedCost,
        totalTickets: tickets.length, soldTickets: soldCount, totalCapacity: totalCapacity || null, remainingTickets,
        byPaymentStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
        byCategory: Object.entries(byCategory).map(([category, v]) => ({ category, ...v })),
        byProvider: Object.entries(byProvider).map(([provider, v]) => ({ provider, ...v })),
        byTicketType: ticketTypes.map(t => ({ id: t.id, name: t.name, category: t.category, price: toNumber(t.price), capacity: t.quota, sold: t._count.tickets, remaining: t.quota == null ? null : Math.max(0, t.quota - t._count.tickets) })),
      },
    }
  })

  app.get('/export.xlsx', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'report.export', { eventId })
    const tickets = await prisma.ticket.findMany({ where: { eventId }, include: { attendee: true, ticketType: true }, orderBy: { issuedAt: 'desc' }, take: 5000 })
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Payments')
    ws.columns = [
      { header: 'Reservation Code', key: 'reservationCode', width: 24 }, { header: 'Attendee', key: 'attendee', width: 24 }, { header: 'Email', key: 'email', width: 28 },
      { header: 'Ticket Type', key: 'ticketType', width: 20 }, { header: 'Category', key: 'category', width: 16 }, { header: 'Amount', key: 'amount', width: 12 },
      { header: 'Payment Status', key: 'paymentStatus', width: 16 }, { header: 'Reference', key: 'reference', width: 24 }, { header: 'Provider', key: 'provider', width: 20 },
      { header: 'Proof URL', key: 'proof', width: 40 }, { header: 'Issued At', key: 'issuedAt', width: 22 },
    ]
    for (const t of tickets) {
      const meta = (t.metadata ?? {}) as Record<string, unknown>
      ws.addRow({ reservationCode: reservationCodeOf(t as any), attendee: t.attendee?.name ?? '', email: t.attendee?.email ?? '', ticketType: t.ticketType?.name ?? '', category: t.ticketType?.category ?? '', amount: toNumber(t.price), paymentStatus: String(meta.paymentStatus ?? ''), reference: String(meta.paymentReference ?? ''), provider: String(meta.paymentProvider ?? ''), proof: proofUrlOf(t) ?? '', issuedAt: t.issuedAt.toISOString() })
    }
    const buf = await wb.xlsx.writeBuffer()
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', `attachment; filename="payments-${eventId}.xlsx"`)
    return reply.send(Buffer.from(buf))
  })
}

