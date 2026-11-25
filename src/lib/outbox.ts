import { PrismaClient, Prisma } from '@prisma/client'
import { runWithIsolatedDbContext, type DbContext } from './dbContext.js'

const basePrisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})

export type OutboxEventType =
  | 'RESERVATION_CREATED'
  | 'RESERVATION_APPROVED'
  | 'RESERVATION_REJECTED'
  | 'PAYMENT_SUBMITTED'
  | 'PAYMENT_APPROVED'
  | 'PAYMENT_REJECTED'
  | 'CREDENTIAL_ISSUED'
  | 'EMAIL_SEND'
  | 'WEBHOOK_DISPATCH'
  | 'ACCESS_CODE_REDEEMED'

export type OutboxEventStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'DEAD_LETTER'

// Use Prisma's InputJsonValue for compatibility
export type OutboxEventPayload = Prisma.InputJsonValue

/**
 * Adds an event to the outbox within the current transaction.
 * This ensures the event is persisted atomically with the business operation.
 */
export async function addOutboxEvent(
  tx: PrismaClient,
  eventType: OutboxEventType,
  payload: OutboxEventPayload,
  options: { scheduledAt?: Date; maxAttempts?: number } = {}
): Promise<string> {
  const event = await tx.outboxEvent.create({
    data: {
      eventType,
      payload,
      status: 'PENDING',
      scheduledAt: options.scheduledAt ?? new Date(),
      maxAttempts: options.maxAttempts ?? 5,
    },
    select: { id: true },
  })
  return event.id
}

/**
 * Processes pending outbox events.
 * Should be called by a background worker (cron, scheduled function, etc.).
 */
export async function processOutboxEvents(
  batchSize = 50,
  options: { eventTypes?: OutboxEventType[] } = {}
): Promise<{ processed: number; failed: number }> {
  const staleProcessingBefore = new Date(Date.now() - 5 * 60 * 1000)
  const where: any = {
    scheduledAt: { lte: new Date() },
    OR: [
      { status: { in: ['PENDING', 'FAILED'] } },
      { status: 'PROCESSING', updatedAt: { lt: staleProcessingBefore } },
    ],
  }
  if (options.eventTypes && options.eventTypes.length > 0) {
    where.eventType = { in: options.eventTypes }
  }

  const events = await basePrisma.outboxEvent.findMany({
    where,
    orderBy: { scheduledAt: 'asc' },
    take: batchSize,
  })

  return processClaimedEvents(events)
}

/**
 * Processes only the events created by the current request. Keeping this
 * separate from the global sweep prevents an old failing event from blocking
 * a freshly committed reservation's credential issuance and email.
 */
export async function processOutboxEventIds(ids: string[]): Promise<{ processed: number; failed: number }> {
  if (ids.length === 0) return { processed: 0, failed: 0 }
  const events = await basePrisma.outboxEvent.findMany({ where: { id: { in: ids } } })
  return processClaimedEvents(events)
}

async function processClaimedEvents(
  events: Array<{ id: string; attempts: number; maxAttempts: number; eventType: OutboxEventType; payload: Prisma.JsonValue }>,
): Promise<{ processed: number; failed: number }> {
  let processed = 0
  let failed = 0

  for (const event of events) {
    // Claim pending work, or recover a processing lease left behind by a
    // worker that crashed. The conditional update is the concurrency guard.
    const staleProcessingBefore = new Date(Date.now() - 5 * 60 * 1000)
    const updated = await basePrisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        OR: [
          { status: { in: ['PENDING', 'FAILED'] } },
          { status: 'PROCESSING', updatedAt: { lt: staleProcessingBefore } },
        ],
      },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    })

    if (updated.count === 0) continue // Another worker picked it up

    try {
      await runWithIsolatedDbContext({ isInternal: true }, () => processEvent(event))
      await basePrisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'COMPLETED', processedAt: new Date(), lastError: null },
      })
      processed++
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const nextAttempt = event.attempts + 1
      const maxAttempts = event.maxAttempts

      if (nextAttempt >= maxAttempts) {
        await basePrisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: 'DEAD_LETTER',
            lastError: error,
            attempts: nextAttempt,
            processedAt: new Date(),
          },
        })
      } else {
        // Exponential backoff: 1min, 2min, 4min, 8min, 16min...
        const delayMinutes = Math.min(2 ** (nextAttempt - 1), 60)
        const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000)
        await basePrisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: 'FAILED',
            lastError: error,
            attempts: nextAttempt,
            scheduledAt,
          },
        })
      }
      failed++
    }
  }

  return { processed, failed }
}

async function processEvent(event: { eventType: OutboxEventType; payload: Prisma.JsonValue }): Promise<void> {
  // Import handlers dynamically to avoid circular dependencies
  const { sendMail, ticketEmailShell } = await import('./mailer.js')
  const { issueReservationCredential, deliverReservationCredentialEmail } = await import('../features/reservations/service.js')
  const { dispatchEventWebhooks } = await import('../features/integrations/dispatch.js')
  const { publish, channelFor } = await import('./realtime.js')
  const { writeAudit } = await import('./audit.js')
  const { AuditActions } = await import('./audit-actions.js')
  const prisma = basePrisma

  switch (event.eventType) {
    case 'EMAIL_SEND': {
      const { to, subject, html } = event.payload as { to: string; subject: string; html: string }
      await sendMail({ to, subject, html })
      break
    }

    case 'CREDENTIAL_ISSUED': {
      const { event: eventData, ticket } = event.payload as { event: any; ticket: any }
      // JSON serialization turns Date objects into ISO strings. Rehydrate them
      // before the mailer formats the event date or Prisma stores validity.
      const eventWithDates = {
        ...eventData,
        startAt: new Date(eventData.startAt),
        endAt: eventData.endAt ? new Date(eventData.endAt) : null,
      }
      const issued = await issueReservationCredential({
        event: eventWithDates,
        ticket: ticket,
        sendEmail: false,
      })
      await deliverReservationCredentialEmail({
        event: eventWithDates,
        ticket: ticket,
        credential: issued.credential,
      })
      break
    }

    case 'WEBHOOK_DISPATCH': {
      const { eventId, eventName, payload: webhookPayload } = event.payload as { eventId: string; eventName: string; payload: any }
      await dispatchEventWebhooks(eventId, eventName, webhookPayload)
      break
    }

    case 'RESERVATION_CREATED': {
      const { eventId, ticketId, reservationCode, approval, paymentStatus, attendee, ticketType } = event.payload as {
        eventId: string
        ticketId: string
        reservationCode: string
        approval: string
        paymentStatus: string
        attendee: { name: string; email: string }
        ticketType: { id: string; name: string }
      }
      await publish(channelFor.reservation(eventId), 'reservation.created', {
        ticketId,
        reservationCode,
        approval,
        paymentStatus,
      })
      await writeAudit({
        organizationId: null, // Will be filled by context if needed
        eventId,
        actorUserId: null,
        action: 'reservation.created',
        resourceType: 'ticket',
        resourceId: ticketId,
        newValue: { reservationCode, approval, paymentStatus, attendee, ticketType },
        sourceIp: null,
      })
      break
    }

    case 'PAYMENT_SUBMITTED': {
      const { eventId, ticketId, paymentProviderId, paymentReference, hasProof } = event.payload as {
        eventId: string
        ticketId: string
        paymentProviderId: string | null
        paymentReference: string | null
        hasProof: boolean
      }
      await writeAudit({
        organizationId: null,
        eventId,
        actorUserId: null,
        action: AuditActions.PAYMENT_SUBMITTED,
        resourceType: 'ticket',
        resourceId: ticketId,
        newValue: { paymentProviderId, paymentReference, hasProof },
        sourceIp: null,
      })
      break
    }

    default:
      throw new Error(`Unsupported outbox event type: ${event.eventType}`)
  }
}

/**
 * Legacy afterResponse helper - creates outbox events instead of fire-and-forget.
 * Maintains backward compatibility with existing code.
 */
export function afterResponseOutbox(
  tx: PrismaClient,
  eventType: OutboxEventType,
  payload: OutboxEventPayload,
  options?: { scheduledAt?: Date; maxAttempts?: number }
): void {
  // This is called within a transaction, so we just add to outbox
  addOutboxEvent(tx, eventType, payload, options).catch((err) => {
    console.error('Failed to add outbox event:', err)
  })
}