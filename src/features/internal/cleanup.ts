import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { prisma } from '../../lib/db.js'
import { runWithDbContext } from '../../lib/dbContext.js'
import { config } from '../../config.js'
import { processOutboxEvents } from '../../lib/outbox.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { sendMail, ticketEmailShell, verifyMailTransport } from '../../lib/mailer.js'
import { createTicketQrAttachment, TICKET_QR_CID } from '../../lib/qr.js'

export async function releaseExpiredSeatHolds(): Promise<number> {
  return runWithDbContext({ isInternal: true }, async () => {
    const now = new Date()
    const expired = await prisma.busSeat.updateMany({
      where: { state: 'HELD', holdExpiresAt: { lte: now } },
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

    // Do not convert database failures into a successful zero-count cleanup.
    return expired.count
  })
}

function isAuthorizedCronRequest(req: FastifyRequest): boolean {
  if (!config.cronSecret) return false
  const headerSecret = req.headers['x-cron-secret']
  const authorization = req.headers.authorization
  const bearerSecret = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : undefined
  return headerSecret === config.cronSecret || bearerSecret === config.cronSecret
}

export async function registerCleanupEndpoint(app: FastifyInstance): Promise<void> {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.cronSecret) {
      return reply.status(503).send({
        error: { code: 'CRON_NOT_CONFIGURED', message: 'Cron secret is not configured' },
      })
    }

    if (!isAuthorizedCronRequest(req)) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid cron secret' },
      })
    }

    const cleaned = await releaseExpiredSeatHolds()
    const outbox = await processOutboxEvents(100)
    const rateLimitsCleaned = await runWithDbContext({ isInternal: true }, () =>
      prisma.$executeRaw`
        DELETE FROM "RateLimitCounter"
        WHERE "windowStart" < ${new Date(Date.now() - 24 * 60 * 60 * 1000)}
      `,
    )

    return { data: { cleaned, outbox, rateLimitsCleaned } }
  }

  // Vercel Cron invokes this endpoint with GET. POST remains available for a
  // protected manual invocation from operational tooling.
  app.get('/internal/cleanup/expired-holds', handler)
  app.post('/internal/cleanup/expired-holds', handler)

  // Run durable delivery retries separately from the daily expiry sweep.
  // An external scheduler can call this endpoint every few minutes.
  const outboxHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.cronSecret) {
      return reply.status(503).send({
        error: { code: 'CRON_NOT_CONFIGURED', message: 'Cron secret is not configured' },
      })
    }
    if (!isAuthorizedCronRequest(req)) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid cron secret' },
      })
    }
    const outbox = await processOutboxEvents(50)
    return { data: { outbox } }
  }

  app.get('/internal/process-outbox', outboxHandler)
  app.post('/internal/process-outbox', outboxHandler)

  // Protected production smoke test. It verifies SMTP, sends one real test
  // message to an explicitly supplied mailbox, and checks the inline QR MIME
  // attachment path without creating a reservation or ticket record.
  app.post('/internal/smtp-test', async (req, reply) => {
    if (!config.cronSecret) {
      return reply.status(503).send({
        error: { code: 'CRON_NOT_CONFIGURED', message: 'Cron secret is not configured' },
      })
    }
    if (!isAuthorizedCronRequest(req)) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid cron secret' },
      })
    }
    const parsed = z.object({ to: z.string().email() }).safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'A valid test recipient email is required' },
      })
    }
    const smtp = await verifyMailTransport()
    if (!smtp.ok) {
      return reply.status(503).send({
        data: { smtp: 'unavailable', sent: false },
        error: { code: 'SMTP_UNAVAILABLE', message: smtp.error ?? 'SMTP verification failed' },
      })
    }
    const testId = randomUUID()
    const attachment = await createTicketQrAttachment('TKT-SMTP-CHECK-' + testId)
    const delivery = await sendMail({
      to: parsed.data.to,
      subject: 'TKT SMTP delivery test',
      html: ticketEmailShell({
        preheader: 'TKT mail transport verification',
        title: 'SMTP delivery test',
        titleAr: 'اختبار إرسال البريد',
        body: 'This is a controlled delivery test. No reservation has been created.',
        bodyAr: 'هذه رسالة اختبار فعلية. لم يتم إنشاء أي حجز.',
        rows: [{ label: 'Test ID', value: testId }, { label: 'Status', value: 'SMTP connection verified' }],
        qrCid: TICKET_QR_CID,
      }),
      attachments: [attachment],
    })
    if (!delivery.ok) {
      return reply.status(502).send({
        data: { smtp: 'connected', sent: false },
        error: { code: 'SMTP_DELIVERY_FAILED', message: delivery.error ?? 'Test message could not be sent' },
      })
    }
    return { data: { smtp: 'connected', sent: true, messageId: delivery.messageId, testId } }
  })
}
