import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma as prismaClient } from '../../lib/db.js'

const prisma = prismaClient as any
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { AuditActions } from '../../lib/audit-actions.js'
import { deliverWebhook } from './dispatch.js'

const webhookSchema = z.object({
  name: z.string().min(2),
  url: z.string().url(),
  secret: z.string().optional(),
  events: z.array(z.string()).default([]),
  active: z.boolean().optional().default(true),
  headers: z.record(z.string(), z.string()).optional(),
})

const insuranceSchema = z.object({
  provider: z.string().min(1),
  policyNumber: z.string().min(1),
  coverageDetails: z.string().optional(),
  incidentReport: z.string().optional(),
  claimStatus: z.string().optional(),
})

const mapSchema = z.object({
  map3dUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  mapImageUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  mapPdfUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  routeNotes: z.string().optional(),
})

export async function integrationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/webhooks', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'integration.view', { eventId })
    return { data: await prisma.webhookSubscription.findMany({ where: { eventId }, orderBy: { createdAt: 'desc' }, include: { deliveries: { orderBy: { createdAt: 'desc' }, take: 5 } } }) }
  })

  app.post('/webhooks', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'integration.manage', { eventId })
    const body = webhookSchema.parse(req.body)
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    if (!event) throw errors.notFound('Event not found')
    const sub = await prisma.webhookSubscription.create({ data: { eventId, name: body.name, url: body.url, secret: body.secret || null, events: body.events as any, active: body.active, headers: body.headers as any, createdById: req.user.id } })
    await writeAudit({ organizationId: event.orgId, eventId, actorUserId: req.user.id, action: AuditActions.WEBHOOK_CREATED, resourceType: 'webhook_subscription', resourceId: sub.id, newValue: body, sourceIp: req.ip })
    return reply.status(201).send({ data: sub })
  })

  app.patch('/webhooks/:id', async (req) => {
    const { eventId, id } = req.params as { eventId: string; id: string }
    await requirePermission(req, 'integration.manage', { eventId })
    const body = webhookSchema.partial().parse(req.body)
    const existing = await prisma.webhookSubscription.findFirst({ where: { id, eventId } })
    if (!existing) throw errors.notFound('Webhook not found')
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    const sub = await prisma.webhookSubscription.update({ where: { id }, data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.url !== undefined ? { url: body.url } : {}), ...(body.secret !== undefined ? { secret: body.secret || null } : {}), ...(body.events !== undefined ? { events: body.events as any } : {}), ...(body.active !== undefined ? { active: body.active } : {}), ...(body.headers !== undefined ? { headers: body.headers as any } : {}) } })
    await writeAudit({ organizationId: event?.orgId, eventId, actorUserId: req.user.id, action: AuditActions.WEBHOOK_UPDATED, resourceType: 'webhook_subscription', resourceId: id, previousValue: existing, newValue: body, sourceIp: req.ip })
    return { data: sub }
  })

  app.delete('/webhooks/:id', async (req, reply) => {
    const { eventId, id } = req.params as { eventId: string; id: string }
    await requirePermission(req, 'integration.manage', { eventId })
    const existing = await prisma.webhookSubscription.findFirst({ where: { id, eventId } })
    if (!existing) throw errors.notFound('Webhook not found')
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    await prisma.webhookSubscription.delete({ where: { id } })
    await writeAudit({ organizationId: event?.orgId, eventId, actorUserId: req.user.id, action: AuditActions.WEBHOOK_DELETED, resourceType: 'webhook_subscription', resourceId: id, previousValue: existing, sourceIp: req.ip })
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
    const body = z.object({ incidentReport: z.string().min(1), claimStatus: z.string().optional() }).parse(req.body)
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
}
