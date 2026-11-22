import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { verifyCredentialIntegrity, verifyPayload, publicKeyPem } from '../../lib/credentials.js'
import { validateAccess, type AccessDecision } from '../../lib/access-engine.js'
import { generateKeyPairSync, createPublicKey, createPrivateKey, sign, verify } from 'node:crypto'
import { publish, channelFor } from '../../lib/realtime.js'
import { logActivity } from '../../lib/activity.js'

const scanSchema = z.object({
  code: z.string().min(4),
  areaId: z.string(),
  deviceId: z.string().optional(),
})

const registerSchema = z.object({
  deviceName: z.string().min(2),
  publicKey: z.string().min(10),
})

const syncItemSchema = z.object({
  localId: z.string(),
  code: z.string().min(4),
  areaId: z.string(),
  decision: z.enum(['GRANTED', 'DENIED']),
  reason: z.string(),
  timestamp: z.coerce.date(),
  signature: z.string().min(10),
})

const syncSchema = z.object({
  deviceId: z.string(),
  items: z.array(syncItemSchema).min(1).max(500),
})

export async function accessRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // â”€â”€ Server-side scan â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.post('/validate', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    const body = scanSchema.parse(req.body)

    const ctx = await requirePermission(req, 'access.scan', { eventId, target: { areaId: body.areaId } })

    const event = await prisma.event.findUnique({ where: { id: eventId } })
    if (!event) throw errors.notFound('Event not found')

    const area = await prisma.area.findUnique({ where: { id: body.areaId } })
    if (!area || area.eventId !== eventId) {
      throw errors.badRequest('Area not found in this event')
    }

    const resolved = await verifyCredentialIntegrity(body.code, eventId)
    let credential: any = resolved?.credential ?? null
    if (credential && resolved?.decoded) {
      const sigOk = verifyPayload(resolved.payload!, resolved.signature!)
      if (!sigOk) {
        // Tampered payload â€” reject without trusting DB fallback
        const decision: AccessDecision = { result: 'DENIED', reason: 'INVALID_CREDENTIAL' }
        await logAccess(eventId, body, credential, decision, ctx, req, null, { tampered: true })
        return reply.send({ data: { ...decision, credentialId: credential.id, attendee: null } })
      }
    }

    if (credential) {
      credential = await prisma.credential.findUnique({
        where: { id: credential.id },
        include: { attendee: true, ticket: { include: { ticketType: true } } },
      })
    }

    const decision = validateAccess({
      credential: credential
        ? {
            id: credential.id,
            status: credential.status,
            validFrom: credential.validFrom,
            validUntil: credential.validUntil,
            singleUse: credential.singleUse,
            allowReentry: credential.allowReentry,
            areaIds: credential.areaIds,
            code: credential.code,
            attendeeStatus: credential.attendee?.status,
            ticketStatus: credential.ticket?.status ?? null,
            ticketTypeName: credential.ticket?.ticketType.name ?? null,
          }
        : null,
      event: { id: eventId, status: event.status },
      area: { id: area.id, active: area.active, accessPolicy: area.accessPolicy },
      operator: {
        areaIds: ctx.areaIds,
        eventScope: ctx.eventScope,
        isSuperAdmin: ctx.isSuperAdmin,
      },
    })

    // Atomic single-use consumption â€” guards concurrent scans
    let consumeNote: string | null = null
    if (decision.result === 'GRANTED' && credential) {
      if (credential.singleUse) {
        const consumed = await prisma.credential.updateMany({
          where: { id: credential.id, status: 'ACTIVE' },
          data: { status: 'CONSUMED' },
        })
        if (consumed.count === 0) {
          const updated = await prisma.credential.findUnique({ where: { id: credential.id } })
          const race: AccessDecision = { result: 'DENIED', reason: 'ALREADY_USED' }
          await logAccess(eventId, body, credential, race, ctx, req, area)
          return reply.send({
            data: {
              ...race,
              credentialId: credential.id,
              attendee: { name: credential.attendee?.name, category: credential.attendee?.category },
            },
          })
        }
        consumeNote = 'credential_consumed'
      }
      await prisma.attendee.update({
        where: { id: credential.attendeeId },
        data: { status: 'CHECKED_IN' },
      }).catch(() => {})
    }

    const log = await logAccess(eventId, body, credential, decision, ctx, req, area, consumeNote ? { consumed: true } : undefined)

    publish(channelFor.access(eventId), 'scan', {
      id: log.id,
      eventId,
      result: decision.result,
      reason: decision.reason,
      areaId: area.id,
      areaName: area.name,
      timestamp: log.timestamp,
      attendeeName: credential?.attendee?.name,
      ticketType: credential?.ticket?.ticketType.name,
    })

    logActivity(
      eventId,
      'scan',
      `${credential?.attendee?.name ?? 'Unknown'} ${decision.result === 'GRANTED' ? 'entered' : 'was denied at'} ${area.name}`,
      req.user.name,
    )

    return reply.send({
      data: {
        ...decision,
        credentialId: credential?.id ?? null,
        attendee: credential
          ? {
              id: credential.attendee.id,
              name: credential.attendee.name,
              category: credential.attendee.category,
            }
          : null,
        ticketType: credential?.ticket?.ticketType.name ?? null,
      },
    })
  })

  // â”€â”€ Offline device registration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.post('/device/register', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'access.scan', { eventId })
    const body = registerSchema.parse(req.body)

    try {
      createPublicKey({ key: body.publicKey, format: 'pem', type: 'spki' })
    } catch {
      throw errors.badRequest('Invalid device public key')
    }

    const device = await prisma.device.create({
      data: { eventId, name: body.deviceName, publicKey: body.publicKey, ownerId: req.user.id },
    })
    await writeAudit({
      eventId,
      actorUserId: req.user.id,
      action: 'device.registered',
      resourceType: 'device',
      resourceId: device.id,
      sourceIp: req.ip,
    })
    return reply.status(201).send({
      data: {
        deviceId: device.id,
        serverPublicKey: publicKeyPem(),
        syncUrl: `/events/${eventId}/access/sync`,
      },
    })
  })

  // â”€â”€ Offline batch sync â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.post('/sync', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'access.scan', { eventId })
    const body = syncSchema.parse(req.body)

    const device = await prisma.device.findUnique({ where: { id: body.deviceId } })
    if (!device) throw errors.badRequest('Unknown device')

    const event = await prisma.event.findUnique({ where: { id: eventId } })
    if (!event) throw errors.notFound('Event not found')

    const results: any[] = []
    const conflicts: any[] = []
    const verificationKey = createPublicKey({ key: device.publicKey, format: 'pem', type: 'spki' })

    for (const item of body.items) {
      // Verify the device's signed local decision
      const signedPayload = JSON.stringify({ localId: item.localId, code: item.code, areaId: item.areaId, decision: item.decision, timestamp: item.timestamp.toISOString() })
      let signatureValid = false
      try {
        signatureValid = verify(null, Buffer.from(signedPayload), verificationKey, Buffer.from(item.signature, 'base64url'))
      } catch {
        signatureValid = false
      }
      if (!signatureValid) {
        results.push({ localId: item.localId, accepted: false, reason: 'INVALID_DEVICE_SIGNATURE' })
        continue
      }

      // Authoritative re-validation
      const resolved = await verifyCredentialIntegrity(item.code, eventId)
      const credential = resolved?.credential
        ? await prisma.credential.findUnique({ where: { id: resolved.credential.id }, include: { attendee: true, ticket: { include: { ticketType: true } } } })
        : null
      const area = await prisma.area.findUnique({ where: { id: item.areaId } })

      const decision = validateAccess({
        credential: credential
          ? {
              id: credential.id,
              status: credential.status,
              validFrom: credential.validFrom,
              validUntil: credential.validUntil,
              singleUse: credential.singleUse,
              allowReentry: credential.allowReentry,
              areaIds: credential.areaIds,
              code: credential.code,
              attendeeStatus: credential.attendee?.status,
              ticketStatus: credential.ticket?.status ?? null,
            }
          : null,
        event: { id: eventId, status: event.status },
        area: area ? { id: area.id, active: area.active, accessPolicy: area.accessPolicy } : null,
        operator: { areaIds: [], eventScope: 'EVENT', isSuperAdmin: true },
      })

      const localDecision = item.decision === 'GRANTED' ? 'GRANTED' : 'DENIED'
      const match = localDecision === decision.result

      // Only accept offline grants when they match the authoritative result
      const accepted = match
      if (match && decision.result === 'GRANTED' && credential) {
        await prisma.credential.updateMany({
          where: { id: credential.id, status: 'ACTIVE' },
          data: { status: 'CONSUMED' },
        })
        await prisma.attendee.update({ where: { id: credential.attendeeId }, data: { status: 'CHECKED_IN' } }).catch(() => {})
      }
      if (!match) {
        conflicts.push({
          localId: item.localId,
          localDecision,
          authoritativeDecision: decision.result,
          reason: decision.reason,
          message: 'Offline decision disagreed with the authoritative server state',
        })
      }

      await prisma.accessLog.create({
        data: {
          eventId,
          credentialId: credential?.id ?? null,
          attendeeId: credential?.attendeeId ?? null,
          operatorUserId: req.user.id,
          deviceId: device.id,
          areaId: area?.id ?? null,
result: decision.result,
        reason: decision.reason,
        timestamp: item.timestamp,
        offline: true,
        localSignature: item.signature,
        metadata: { localId: item.localId, accepted, signatureValid } as any,
        },
      })
      results.push({ localId: item.localId, accepted, authoritative: decision, credentialId: credential?.id ?? null })
    }

    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })

    return reply.send({ data: { results, conflicts, syncedAt: new Date().toISOString() } })
  })

  // â”€â”€ Access logs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/logs', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'access.logs.view', { eventId })
    const { page = 1, pageSize = 25, result, areaId } = (req.query ?? {}) as { page?: number; pageSize?: number; result?: string; areaId?: string }
    const where: any = { eventId }
    if (result) where.result = result
    if (areaId) where.areaId = areaId

    const pageNum = Math.max(1, Number(page))
    const size = Math.min(100, Math.max(1, Number(pageSize)))
    const [total, rows] = await Promise.all([
      prisma.accessLog.count({ where }),
      prisma.accessLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (pageNum - 1) * size,
        take: size,
        select: {
          id: true, result: true, reason: true, timestamp: true, offline: true,
          area: { select: { id: true, name: true } },
          operator: { select: { id: true, name: true } },
          attendee: { select: { id: true, name: true } },
          credential: { select: { id: true, code: true } },
        },
      }),
    ])
    return { data: { rows, total, page: pageNum, pageSize: size, pages: Math.max(1, Math.ceil(total / size)) } }
  })
}

async function logAccess(
  eventId: string,
  body: { areaId: string; deviceId?: string },
  credential: any,
  decision: AccessDecision,
  ctx: { organizationId: string; isSuperAdmin: boolean },
  req: any,
  area: any,
  metadata?: Record<string, unknown>,
) {
  const log = await prisma.accessLog.create({
    data: {
      eventId,
      credentialId: credential?.id ?? null,
      attendeeId: credential?.attendeeId ?? null,
      operatorUserId: req.user.id,
      deviceId: body.deviceId ?? null,
      areaId: body.areaId,
      result: decision.result,
      reason: decision.reason,
      metadata: metadata as any,
    },
  })
  await writeAudit({
    organizationId: ctx.organizationId,
    eventId,
    actorUserId: req.user.id,
    action: decision.result === 'GRANTED' ? 'access.granted' : 'access.denied',
    resourceType: 'access_log',
    resourceId: log.id,
    newValue: { areaId: body.areaId, credentialId: credential?.id ?? null, reason: decision.reason },
    sourceIp: req.ip,
  })
  return log
}