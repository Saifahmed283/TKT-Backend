import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import {
  reservationApprovalOf,
  reservationCodeOf,
  reservationPaymentOf,
  normalizeReservationEmail,
  normalizeReservationPhone,
  reservationStatePatch,
} from '../reservations/service.js'
import { ticketEmailShell } from '../../lib/mailer.js'
import { logActivity } from '../../lib/activity.js'
import { publish, channelFor } from '../../lib/realtime.js'
import { addOutboxEvent, processOutboxEventIds, type OutboxEventType } from '../../lib/outbox.js'
import { afterResponse } from '../../lib/background.js'
import { clearExpiredBusSeatHolds, lockBusForSeatMutation } from '../buses/seat-mutations.js'
import { paidAmountMismatch, registrationWindow, reservationCode, secureAccessToken, hashAccessToken, reservationSchema, reservationStartedAt, type RegSettings } from './schemas.js'

export async function reservationRoutes(app: FastifyInstance) {
// ── Public reservation ────────────────────────────────────
  app.post('/events/:eventId/reservations', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    onRequest: async (req) => { reservationStartedAt.set(req, Date.now()) },
    onResponse: async (req, reply) => {
      const started = reservationStartedAt.get(req)
      const { eventId } = req.params as { eventId?: string }
      reservationStartedAt.delete(req)
      req.log.info(
        { eventId, status: reply.statusCode, duration_ms: started == null ? null : Date.now() - started },
        'public.reservation completed',
      )
    },
  }, async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    const body = reservationSchema.parse(req.body)

    const event = await prisma.event.findUnique({ where: { id: eventId } })
    if (!event) throw errors.notFound('Event not found')
    if (event.status !== 'PUBLISHED') throw errors.badRequest('Reservations are closed for this event')
    if (event.startAt.getTime() <= Date.now()) throw errors.badRequest('This event has already started')

    const settings = (event.settings as Record<string, any>) ?? {}
    const reg = (settings.registration as RegSettings) ?? {}
    if (reg.enabled === false || reg.open === false) {
      throw errors.badRequest('Reservations are locked — this event is at capacity')
    }
    const window = registrationWindow(reg)
    if (window.start && new Date(window.start).getTime() > Date.now()) {
      throw errors.badRequest('Reservations open soon — check back shortly')
    }
    if (window.end && new Date(window.end).getTime() <= Date.now()) {
      throw errors.badRequest('Reservation window has closed')
    }

    const ticketType = await prisma.ticketType.findFirst({
      where: { id: body.ticketTypeId, eventId, active: true },
    }) as any
    if (!ticketType) throw errors.badRequest('Ticket type not found')
    if (ticketType.isPublic === false) throw errors.badRequest('This ticket type is not available for public reservation')
    const nowTs = Date.now()
    if (ticketType.salesStartAt && nowTs < ticketType.salesStartAt.getTime()) throw errors.badRequest('Ticket sales have not started yet')
    if (ticketType.salesEndAt && nowTs > ticketType.salesEndAt.getTime()) throw errors.badRequest('Ticket sales have ended')

    const transportIncluded = ticketType.transportIncluded === true
    const requestedSeatIds = Array.isArray(body.seatIds) ? [...new Set(body.seatIds)] : []
    if (transportIncluded && requestedSeatIds.length !== 1) {
      throw errors.badRequest('This ticket includes transportation — select exactly one seat')
    }
    if (!transportIncluded && requestedSeatIds.length > 0) {
      throw errors.badRequest('Seat selection is only available for tickets with transportation included')
    }

    const soldCount = async () =>
      prisma.ticket.count({
        where: { ticketTypeId: ticketType.id, status: { in: ['ISSUED', 'ACTIVE', 'CONSUMED'] } },
      })
    if (ticketType.quota != null && (await soldCount()) >= ticketType.quota) {
      throw errors.badRequest('This ticket type has sold out')
    }

    const seatIds = requestedSeatIds
    const code = reservationCode()
    const ticketPrice = Number(ticketType.price ?? 0)
    const bus = seatIds.length
      ? await prisma.bus.findUnique({ where: { id: body.busId ?? '' }, select: { id: true, eventId: true, seatPrice: true, currency: true, isActive: true } }).catch(() => null)
      : null
    if (seatIds.length && (!body.busId || !bus || bus.eventId !== eventId || !bus.isActive)) {
      throw errors.badRequest('Valid bus is required for seat reservations')
    }
    // A transport-included ticket is a fixed package price. Seat selection
    // chooses the passenger's seat; it must not add a second bus-seat charge.
    const busSeatUnitPriceForPricing = seatIds.length && !transportIncluded ? Number(bus?.seatPrice ?? 0) : 0
    let computedTotalForPricing = (Number.isFinite(ticketPrice) ? ticketPrice : 0)
      + (seatIds.length * (Number.isFinite(busSeatUnitPriceForPricing) ? busSeatUnitPriceForPricing : 0))
    const clientPaymentAmount = body.paymentAmount == null ? null : Number(body.paymentAmount)
    if (paidAmountMismatch(clientPaymentAmount, computedTotalForPricing)) {
      throw errors.badRequest('Payment amount does not match ticket and seat total')
    }
    let paid = computedTotalForPricing > 0
    let state = reservationStatePatch({ paid, approved: !paid })
    const emailNorm = normalizeReservationEmail(body.email)
    const phoneNorm = normalizeReservationPhone(body.phone)
    let paymentProvider: { id: string; name: string } | null = null
    if (body.paymentProviderId) {
      paymentProvider = await prisma.paymentProvider.findFirst({
        where: { id: body.paymentProviderId, eventId, isActive: true },
        select: { id: true, name: true },
      })
      if (!paymentProvider) throw errors.badRequest('Payment provider not found')
    }
    if (body.paymentProofUrl && !(
      body.paymentProofUrl.startsWith('data:image/')
      || body.paymentProofUrl.startsWith('https://')
      || body.paymentProofUrl.startsWith('http://')
      || body.paymentProofUrl.startsWith('/uploads/')
      || body.paymentProofUrl.startsWith('/api/uploads/blob/')
    )) {
      throw errors.badRequest('Payment proof must be an uploaded file URL or image URL')
    }

    let attendee: any
    let ticket: any
    let reservedSeats: { id: string; label: string; busId: string }[] = []
    let accessTokenForClient: string | null = null
    let outboxEventIds: string[] = []
    try {
      const created = await prisma.$transaction(async (tx) => {
        // Serialize capacity checks for this ticket type so concurrent
        // requests cannot both consume the final available ticket.
        const lockedTicketTypes = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "TicketType"
          WHERE "id" = ${ticketType.id} AND "eventId" = ${eventId}
          FOR UPDATE
        `
        if (lockedTicketTypes.length !== 1) throw errors.badRequest('Ticket type is no longer available')
        const soldCountInTransaction = await tx.ticket.count({
          where: {
            ticketTypeId: ticketType.id,
            status: { in: ['ISSUED', 'ACTIVE', 'CONSUMED'] },
          },
        })
        if (ticketType.quota != null && soldCountInTransaction >= ticketType.quota) {
          throw errors.badRequest('This ticket type has sold out')
        }

        const transactionOutboxEventIds: string[] = []
        const queueOutbox = async (eventType: OutboxEventType, payload: any) => {
          transactionOutboxEventIds.push(await addOutboxEvent(tx, eventType, payload))
        }

        const existing = await tx.ticket.findFirst({
          where: {
            eventId,
            reservationEmail: emailNorm,
            status: { in: ['ISSUED', 'ACTIVE', 'CONSUMED'] },
            approvalStatus: { in: ['PENDING', 'APPROVED'] },
          },
          include: { credential: { select: { code: true } } },
        })
        if (existing) {
          throw Object.assign(new Error('DUPLICATE_RESERVATION'), { existing })
        }

        let seatRows: any[] = []
        if (seatIds.length > 0) {
          if (!body.busId) throw errors.badRequest('busId is required when reserving seats')
          // The bus-row lock serializes final reservations with holds, admin
          // seat edits, layout changes, deletes, and price changes.
          await lockBusForSeatMutation(tx, eventId, body.busId, true)
          const now = new Date()
          await clearExpiredBusSeatHolds(tx, body.busId, now)
          const lockedBus = await tx.bus.findFirst({
            where: { id: body.busId, eventId, isActive: true },
            select: { id: true, seatPrice: true },
          })
          if (!lockedBus) throw errors.badRequest('Valid bus is required for seat reservations')

          const lockedSeatPrice = transportIncluded ? 0 : Number(lockedBus.seatPrice ?? 0)
          computedTotalForPricing = (Number.isFinite(ticketPrice) ? ticketPrice : 0)
            + (Number.isFinite(lockedSeatPrice) ? lockedSeatPrice : 0)
          if (paidAmountMismatch(clientPaymentAmount, computedTotalForPricing)) {
            throw errors.badRequest('Payment amount does not match ticket and seat total')
          }
          paid = computedTotalForPricing > 0
          state = reservationStatePatch({ paid, approved: !paid })

          seatRows = await tx.busSeat.findMany({ where: { id: { in: seatIds }, busId: body.busId, bus: { eventId, isActive: true } } })
          if (seatRows.length !== seatIds.length) throw errors.badRequest('One or more seats are invalid')
          const blocked = seatRows.filter((s: any) => {
            if (s.state === 'AVAILABLE') return false
            if (s.state === 'HELD' && body.holdToken && s.holdToken === body.holdToken && s.holdExpiresAt && s.holdExpiresAt > now) return false
            return true
          })
          if (blocked.length) throw errors.conflict(`Seats no longer available: ${blocked.map((s: any) => s.label).join(', ')}`)
        }

        const attendee = await tx.attendee.create({
          data: {
            eventId,
            name: body.name,
            email: body.email,
            phone: body.phone,
            status: paid ? 'REGISTERED' : 'CONFIRMED',
            notes: body.notes?.trim() || null,
            metadata: { source: 'public', notes: body.notes?.trim() || null },
          },
        })

        // Returned to the client once as the capability for later status
        // lookups; only its hash is persisted.
        const accessToken = secureAccessToken()
        accessTokenForClient = accessToken
        const accessTokenHash = hashAccessToken(accessToken)
        const accessTokenExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year

        const ticket = await tx.ticket.create({
          data: {
            eventId,
            attendeeId: attendee.id,
            ticketTypeId: ticketType.id,
            price: computedTotalForPricing,
            status: paid ? 'ISSUED' : 'ACTIVE',
            reservationCode: code,
            reservationEmail: emailNorm,
            reservationPhone: phoneNorm,
            reservationName: body.name.trim(),
            deliveryChannel: 'EMAIL',
            deliveryStatus: 'PENDING',
            paymentProviderId: paid ? (paymentProvider?.id ?? null) : null,
            paymentReference: paid ? (body.paymentReference?.trim() || null) : null,
            paymentProofUrl: paid ? (body.paymentProofUrl || null) : null,
            paymentAmount: paid ? computedTotalForPricing : null,
            paymentSubmittedAt: paid && (body.paymentReference || body.paymentProofUrl || body.paymentProviderId) ? new Date() : null,
            accessTokenHash,
            accessTokenExpiresAt,
            ...state,
            metadata: {
              reservationCode: code,
              channel: 'public',
              approval: paid ? 'PENDING' : 'APPROVED',
              email: body.email,
              phone: body.phone ?? null,
              name: body.name,
              paymentProviderId: paid ? (paymentProvider?.id ?? null) : null,
              paymentReference: paid ? (body.paymentReference?.trim() || null) : null,
              busId: body.busId ?? null,
              seatIds,
              notes: body.notes?.trim() || null,
              transportIncluded,
              ...(body.ticketDesign ? { ticketDesign: body.ticketDesign } : {}),
            },
          },
        })

        if (seatIds.length > 0) {
          const groupId = randomUUID()
          const now = new Date()
          for (const id of seatIds) {
            const passenger = body.seatPassengers?.find(p => p.seatId === id)
            const updated = await tx.busSeat.updateMany({
              where: { id, busId: body.busId!, OR: [{ state: 'AVAILABLE' }, { state: 'HELD', holdToken: body.holdToken ?? undefined, holdExpiresAt: { gt: now } }] },
              data: {
                state: 'RESERVED',
                holderName: body.name.trim(),
                passengerName: passenger?.name?.trim() || body.name.trim(),
                passengerEmail: passenger?.email?.trim() || body.email.trim(),
                passengerPhone: passenger?.phone?.trim() || body.phone?.trim() || null,
                groupId,
                ticketId: ticket.id,
                holdToken: null,
                holdExpiresAt: null,
                reservedAt: new Date(),
              },
            })
            if (updated.count !== 1) throw errors.conflict('Seat reservation conflict — please reselect seats')
          }
          seatRows = await tx.busSeat.findMany({ where: { id: { in: seatIds } } })
        }

        const ticketForOutbox = {
          id: ticket.id,
          eventId,
          metadata: ticket.metadata,
          price: ticket.price,
          status: ticket.status,
          reservationCode: ticket.reservationCode,
          approvalStatus: ticket.approvalStatus,
          paymentStatus: ticket.paymentStatus,
          attendee: { id: attendee.id, name: body.name, email: body.email, phone: body.phone ?? null },
          ticketType: { id: ticketType.id, name: ticketType.name, price: ticketType.price },
        }

        if (paid) {
          const submittedPayment = Boolean(body.paymentReference || body.paymentProofUrl || paymentProvider)
          await queueOutbox('EMAIL_SEND', {
            to: body.email,
            subject: `Reservation received — ${event.name}`,
            html: ticketEmailShell({
              preheader: `Your reservation for ${event.name} is ${submittedPayment ? 'awaiting payment review' : 'awaiting approval'}`,
              title: 'Reservation received',
              body: `Your reservation for <strong>${event.name}</strong> is in. ${submittedPayment ? 'Your payment proof was received and will be reviewed by the event team.' : 'The event team will review it shortly.'} Your QR ticket arrives by email once approved.`,
              rows: [
                { label: 'Event', value: event.name },
                { label: 'Ticket', value: ticketType.name },
                { label: 'Reservation', value: code },
                ...(seatRows.length ? [{ label: 'Seats', value: seatRows.map((seat: any) => seat.label).join(', ') }] : []),
                ...(paymentProvider ? [{ label: 'Payment method', value: paymentProvider.name }] : []),
                ...(body.paymentReference?.trim() ? [{ label: 'Payment reference', value: body.paymentReference.trim() }] : []),
                { label: 'Status', value: submittedPayment ? 'Awaiting payment review' : 'Awaiting approval' },
              ],
              footer: 'TKT · Control center for live events',
            }),
          })

          if (submittedPayment) {
            await queueOutbox('PAYMENT_SUBMITTED', {
              eventId,
              ticketId: ticket.id,
              paymentProviderId: paymentProvider?.id ?? null,
              paymentReference: body.paymentReference?.trim() || null,
              hasProof: Boolean(body.paymentProofUrl),
            })
          }
        } else {
          await queueOutbox('CREDENTIAL_ISSUED', {
            event: { id: event.id, orgId: event.orgId, name: event.name, startAt: event.startAt, endAt: event.endAt, timezone: event.timezone, venueName: event.venueName, settings: event.settings },
            ticket: ticketForOutbox,
          })
        }

        await queueOutbox('RESERVATION_CREATED', {
          eventId,
          ticketId: ticket.id,
          reservationCode: code,
          approval: paid ? 'PENDING' : 'APPROVED',
          paymentStatus: paid ? 'PENDING' : 'NOT_REQUIRED',
          attendee: { name: body.name, email: body.email },
          ticketType: { id: ticketType.id, name: ticketType.name },
        })

        await queueOutbox('WEBHOOK_DISPATCH', {
          eventId,
          eventName: 'reservation.created',
          payload: {
            ticketId: ticket.id,
            reservationCode: code,
            approval: paid ? 'PENDING' : 'APPROVED',
            paymentStatus: paid ? 'PENDING' : 'NOT_REQUIRED',
            attendee: { name: body.name, email: body.email },
            ticketType: { id: ticketType.id, name: ticketType.name },
          },
        })

        return { attendee, ticket, seatRows, outboxEventIds: transactionOutboxEventIds }
      })
      attendee = created.attendee
      ticket = created.ticket
      outboxEventIds = created.outboxEventIds
      reservedSeats = (created.seatRows ?? []).map((s: any) => ({ id: s.id, label: s.label, busId: s.busId }))
    } catch (err: any) {
      if (err?.message === 'DUPLICATE_RESERVATION' && err.existing) {
        const existing = err.existing
        // Do not disclose the existing code, approval state, or credential to
        // an unauthenticated caller who merely knows the attendee's email.
        // Legitimate recovery uses the code+email resend flow in status.ts.
        return reply.code(409).send({
          error: {
            code: 'RESERVATION_EXISTS',
            message: 'A reservation for this email already exists for this event.',
          },
        })
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw errors.conflict('A reservation for this email already exists for this event.')
      }
      throw err
    }

    const computedTotal = computedTotalForPricing
    const seatSuffix = reservedSeats.length ? ` · seats ${reservedSeats.map((s) => s.label).join(', ')}` : ''
    logActivity(eventId, 'reservation', `${body.name} reserved ${ticketType.name} · ${code}${seatSuffix}`, body.name)

    // Capacity reached → lock the reservation pipeline.
    if (ticketType.quota != null && (await soldCount()) >= ticketType.quota) {
      await prisma.event.update({
        where: { id: eventId },
        data: { settings: { ...settings, registration: { ...reg, open: false } } },
      })
      publish(channelFor.reservation(eventId), 'reservation.capacity_locked', { ticketTypeId: ticketType.id })
    }

    // Process only this request's events after the response is sent. The global
    // cron still drains anything left behind if a worker dies mid-flight.
    afterResponse(req, 'reservation outbox', { eventId }, () => processOutboxEventIds(outboxEventIds))

    return reply.code(201).send({
      data: {
        attendeeId: attendee.id,
        ticketId: ticket.id,
        reservationCode: code,
        // Capability for status lookups; the display code alone is not enough.
        accessToken: accessTokenForClient,
        price: computedTotal.toString(),
        approval: paid ? 'PENDING' : 'APPROVED',
        paymentStatus: paid ? 'PENDING' : 'NOT_REQUIRED',
        // Key is preserved for contract compatibility; the QR is minted after
        // the response and becomes available via the status endpoint.
        qr: null,
        seats: reservedSeats,
      },
    })
  })

}
