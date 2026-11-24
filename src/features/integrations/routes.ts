import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import crypto from 'node:crypto'
import { prisma as prismaClient } from '../../lib/db.js'

const prisma = prismaClient as any
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { AuditActions } from '../../lib/audit-actions.js'
import { assertSafeWebhookUrl } from '../../lib/webhookTarget.js'
import { deliverWebhook } from './dispatch.js'

const webhookSchema = z.object({
  name: z.string().min(2),
  url: z.string().min(1),
  events: z.array(z.string()).default([]),
  active: z.boolean().optional().default(true),
})

const CLAIM_STATUSES = ['active', 'reported'] as const

const insuranceSchema = z.object({
  provider: z.string().min(1),
  policyNumber: z.string().min(1),
  coverageDetails: z.string().optional(),
  incidentReport: z.string().optional(),
  claimStatus: z.enum(CLAIM_STATUSES).optional(),
})

function publicWebhook(sub: any): any {
  if (!sub) return sub
  const { secret: _secret, headers: _headers, ...rest } = sub
  return rest
}

const assetUrl = z.string().trim().min(1).refine((v) => /^https?:\/\//i.test(v) || v.startsWith('/uploads/'), 'Invalid asset URL')
const mapSchema = z.object({
  map3dUrl: assetUrl.optional().or(z.literal('').transform(() => undefined)),
  mapImageUrl: assetUrl.optional().or(z.literal('').transform(() => undefined)),
  mapPdfUrl: assetUrl.optional().or(z.literal('').transform(() => undefined)),
  routeNotes: z.string().optional(),
})

export async function integrationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/webhooks', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'integration.view', { eventId })
    const rows = await prisma.webhookSubscription.findMany({ where: { eventId }, orderBy: { createdAt: 'desc' }, include: { deliveries: { orderBy: { createdAt: 'desc' }, take: 5 } } })
    return { data: rows.map(publicWebhook) }
  })

  app.post('/webhooks', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'integration.manage', { eventId })
    const body = webhookSchema.parse(req.body)
    const url = await assertSafeWebhookUrl(body.url)
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    if (!event) throw errors.notFound('Event not found')
    const sub = await prisma.webhookSubscription.create({ data: { eventId, name: body.name, url, secret: crypto.randomBytes(32).toString('base64url'), events: body.events as any, active: body.active, createdById: req.user.id } })
    await writeAudit({ organizationId: event.orgId, eventId, actorUserId: req.user.id, action: AuditActions.WEBHOOK_CREATED, resourceType: 'webhook_subscription', resourceId: sub.id, newValue: { ...body, url, secretGenerated: true }, sourceIp: req.ip })
    return reply.status(201).send({ data: publicWebhook(sub) })
  })

  app.patch('/webhooks/:id', async (req) => {
    const { eventId, id } = req.params as { eventId: string; id: string }
    await requirePermission(req, 'integration.manage', { eventId })
    const body = webhookSchema.partial().parse(req.body)
    const existing = await prisma.webhookSubscription.findFirst({ where: { id, eventId } })
    if (!existing) throw errors.notFound('Webhook not found')
    const url = body.url !== undefined ? await assertSafeWebhookUrl(body.url) : undefined
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    const sub = await prisma.webhookSubscription.update({ where: { id }, data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(url !== undefined ? { url } : {}), ...(body.events !== undefined ? { events: body.events as any } : {}), ...(body.active !== undefined ? { active: body.active } : {}) } })
    await writeAudit({ organizationId: event?.orgId, eventId, actorUserId: req.user.id, action: AuditActions.WEBHOOK_UPDATED, resourceType: 'webhook_subscription', resourceId: id, previousValue: publicWebhook(existing), newValue: body, sourceIp: req.ip })
    return { data: publicWebhook(sub) }
  })

  app.delete('/webhooks/:id', async (req, reply) => {
    const { eventId, id } = req.params as { eventId: string; id: string }
    await requirePermission(req, 'integration.manage', { eventId })
    const existing = await prisma.webhookSubscription.findFirst({ where: { id, eventId } })
    if (!existing) throw errors.notFound('Webhook not found')
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    await prisma.webhookSubscription.delete({ where: { id } })
    await writeAudit({ organizationId: event?.orgId, eventId, actorUserId: req.user.id, action: AuditActions.WEBHOOK_DELETED, resourceType: 'webhook_subscription', resourceId: id, previousValue: publicWebhook(existing), sourceIp: req.ip })
    return reply.status(204).send()
  })

  app.post('/webhooks/:id/test', async (req) => {
    const { eventId, id } = req.params as { eventId: string; id: string }
    await requirePermission(req, 'integration.manage', { eventId })
    const sub = await prisma.webhookSubscription.findFirst({ where: { id, eventId } })
    if (!sub) throw errors.notFound('Webhook not found')
    await deliverWebhook(sub, 'test.ping', { eventId, by: req.user.id })
    await writeAudit({ eventId, actorUserId: req.user.id, action: AuditActions.WEBHOOK_DELIVERED, resourceType: 'webhook_subscription', resourceId: id, newValue: { eventType: 'test.ping' }, sourceIp: req.ip })
    return { ok: true }
  })

  app.get('/insurance', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'integration.view', { eventId })
    return { data: await prisma.eventInsurancePolicy.findMany({ where: { eventId }, orderBy: { createdAt: 'desc' } }) }
  })

  app.post('/insurance', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'integration.manage', { eventId })
    const body = insuranceSchema.parse(req.body)
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    if (!event) throw errors.notFound('Event not found')
    const row = await prisma.eventInsurancePolicy.create({ data: { eventId, provider: body.provider, policyNumber: body.policyNumber, coverageDetails: body.coverageDetails || null, incidentReport: body.incidentReport || null, claimStatus: body.claimStatus || 'active' } })
    await writeAudit({ organizationId: event.orgId, eventId, actorUserId: req.user.id, action: AuditActions.INSURANCE_UPSERTED, resourceType: 'event_insurance_policy', resourceId: row.id, newValue: body, sourceIp: req.ip })
    return reply.status(201).send({ data: row })
  })

  app.patch('/insurance/:id/report', async (req) => {
    const { eventId, id } = req.params as { eventId: string; id: string }
    await requirePermission(req, 'integration.manage', { eventId })
    const body = z.object({ incidentReport: z.string().min(1), claimStatus: z.enum(CLAIM_STATUSES).optional() }).parse(req.body)
    const existing = await prisma.eventInsurancePolicy.findFirst({ where: { id, eventId } })
    if (!existing) throw errors.notFound('Insurance policy not found')
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    const row = await prisma.eventInsurancePolicy.update({ where: { id }, data: { incidentReport: body.incidentReport, claimStatus: body.claimStatus || 'reported' } })
    await writeAudit({ organizationId: event?.orgId, eventId, actorUserId: req.user.id, action: AuditActions.INSURANCE_REPORTED, resourceType: 'event_insurance_policy', resourceId: id, previousValue: existing, newValue: body, sourceIp: req.ip })
    return { data: row }
  })

  app.get('/map', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'integration.view', { eventId })
    return { data: await prisma.eventMapAsset.findUnique({ where: { eventId } }) }
  })

  app.put('/map', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'integration.manage', { eventId })
    const body = mapSchema.parse(req.body)
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    if (!event) throw errors.notFound('Event not found')
    const row = await prisma.eventMapAsset.upsert({
      where: { eventId },
      update: { map3dUrl: body.map3dUrl || null, mapImageUrl: body.mapImageUrl || null, mapPdfUrl: body.mapPdfUrl || null, routeNotes: body.routeNotes || null },
      create: { eventId, map3dUrl: body.map3dUrl || null, mapImageUrl: body.mapImageUrl || null, mapPdfUrl: body.mapPdfUrl || null, routeNotes: body.routeNotes || null },
    })
    await writeAudit({ organizationId: event.orgId, eventId, actorUserId: req.user.id, action: AuditActions.EVENT_MAP_UPSERTED, resourceType: 'event_map_asset', resourceId: row.id, newValue: body, sourceIp: req.ip })
    return { data: row }
  })

  app.delete('/insurance/:id', async (req, reply) => {
    const { eventId, id } = req.params as { eventId: string; id: string }
    await requirePermission(req, 'integration.manage', { eventId })
    const existing = await prisma.eventInsurancePolicy.findFirst({ where: { id, eventId } })
    if (!existing) throw errors.notFound('Insurance policy not found')
    await prisma.eventInsurancePolicy.delete({ where: { id } })
    await writeAudit({ eventId, actorUserId: req.user.id, action: 'insurance.deleted', resourceType: 'event_insurance_policy', resourceId: id, previousValue: { provider: existing.provider, policyNumber: existing.policyNumber }, sourceIp: req.ip })
    return reply.status(204).send()
  })

  app.delete('/map', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'integration.manage', { eventId })
    const existing = await prisma.eventMapAsset.findUnique({ where: { eventId } })
    if (!existing) return reply.status(204).send()
    await prisma.eventMapAsset.delete({ where: { eventId } })
    await writeAudit({ eventId, actorUserId: req.user.id, action: 'event_map.deleted', resourceType: 'event_map_asset', resourceId: existing.id, sourceIp: req.ip })
    return reply.status(204).send()
  })
}
