import crypto from 'node:crypto'
import { prisma as prismaClient } from '../../lib/db.js'
import { deliverWebhook as deliverPinnedWebhook, validateAndPinWebhookUrl } from '../../lib/webhookTarget.js'
import { runWithIsolatedDbContext } from '../../lib/dbContext.js'

const prisma = prismaClient as any

export async function deliverWebhook(sub: any, eventType: string, payload: unknown) {
  const body = JSON.stringify({ event: eventType, timestamp: new Date().toISOString(), payload })
  const signature = sub.secret ? crypto.createHmac('sha256', sub.secret).update(body).digest('hex') : undefined
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature) headers['x-tkt-signature'] = `sha256=${signature}`
  try {
    // Resolve and pin DNS at delivery time so a hostname cannot rebind to an
    // internal address between validation and the request.
    const target = await validateAndPinWebhookUrl(sub.url)
    const result = await deliverPinnedWebhook(target, payload, {
      timeoutMs: 8000,
      maxRetries: 0,
      body,
      headers,
    })
    if (!result.success) throw new Error(result.error ?? 'Webhook delivery failed')
    const ok = (result.statusCode ?? 0) >= 200 && (result.statusCode ?? 0) < 300
    await prisma.webhookDelivery.create({
      data: {
        subscriptionId: sub.id,
        eventType,
        payload: payload as any,
        status: ok ? 'SUCCESS' : 'FAILED',
        responseCode: result.statusCode ?? null,
        responseBody: null,
        attempt: 1,
      },
    })
  } catch (e: any) {
    await prisma.webhookDelivery.create({
      data: {
        subscriptionId: sub.id,
        eventType,
        payload: payload as any,
        status: 'FAILED',
        error: e?.message ?? String(e),
        attempt: 1,
      },
    })
  }
}

export async function dispatchEventWebhooks(eventId: string, eventType: string, payload: unknown) {
  return runWithIsolatedDbContext({ isInternal: true }, async () => {
    try {
      const subs = await prisma.webhookSubscription.findMany({ where: { eventId, active: true } })
      const targets = subs.filter((s: any) => {
        const events = Array.isArray(s.events) ? s.events : []
        return events.includes('*') || events.includes(eventType)
      })
      await Promise.allSettled(targets.map((s: any) => deliverWebhook(s, eventType, payload)))
    } catch (e) {
      console.error('[webhook-dispatch] failed', { eventId, eventType, error: e })
    }
  })
}
