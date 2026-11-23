import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { AuditActions } from '../../lib/audit-actions.js'
import { verifyCredentialIntegrity, verifyPayload, publicKeyPem, credentialCode, type CredentialPayload } from '../../lib/credentials.js'
import { validateAccess, type AccessDecision } from '../../lib/access-engine.js'
import { createPublicKey, verify } from 'node:crypto'
import { publish, channelFor } from '../../lib/realtime.js'
import { logActivity } from '../../lib/activity.js'

const scanSchema = z.object({
  code: z.string().min(4),
  areaId: z.string(),
  deviceId: z.string().optional(),
})

export type ResolvedScan = {
  credential: any | null
  decoded: boolean
  verified: boolean
  tampered: boolean
  parseSource: 'tkt1' | 'raw_credential' | 'reservation_code' | 'unknown'
  lookupMethod: 'credential_id' | 'credential_code' | 'reservation_code' | 'none'
  payload: CredentialPayload | null
}

export function decodeScanCandidates(raw: string): Array<{ code: string; source: ResolvedScan['parseSource'] }> {
  const candidates: Array<{ code: string; source: ResolvedScan['parseSource'] }> = []
  const seen = new Set<string>()
  const push = (value: string | null | undefined, source: ResolvedScan['parseSource']) => {
    const code = String(value ?? '').trim()
    if (!code || seen.has(code)) return
    seen.add(code)
    candidates.push({ code, source })
  }

  push(raw, 'unknown')

  try {
    const decoded = decodeURIComponent(raw)
    if (decoded !== raw) push(decoded, 'unknown')
  } catch {}

  try {
    const b64 = Buffer.from(raw, 'base64url').toString('utf8').trim()
    if (b64 && b64 !== raw && (b64.startsWith('TKT1.') || b64.startsWith('{') || b64.startsWith('['))) {
      push(b64, b64.startsWith('TKT1.') ? 'tkt1' : 'unknown')
    }
  } catch {}

  for (const current of [...candidates]) {
    if (!current.code.startsWith('{')) continue
    try {
      const parsed = JSON.parse(current.code) as any
      push(parsed?.code, current.code.startsWith('TKT1.') ? 'tkt1' : 'raw_credential')
      push(parsed?.credentialCode, 'raw_credential')
      push(parsed?.reservationCode, 'reservation_code')
      push(parsed?.ticketCode, 'reservation_code')
      push(parsed?.payload?.code, 'raw_credential')
    } catch {}
  }

  return candidates.map((c) => ({
    ...c,
    source: c.code.startsWith('TKT1.') ? 'tkt1' : c.source,
  }))
}

async function resolveCredentialByCode(code: string, eventId: string) {
  const resolved = await verifyCredentialIntegrity(code, eventId)
  if (resolved?.credential) {
    const credential = await prisma.credential.findUnique({
      where: { id: resolved.credential.id },
      include: { attendee: true, ticket: { include: { ticketType: true, busSeats: { select: { id: true, label: true, passengerName: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } } } } },
    })
    const tampered = resolved.decoded ? !resolved.verified : false
    return {
      credential,
      decoded: resolved.decoded,
      verified: resolved.verified,
      tampered,
      parseSource: resolved.decoded ? 'tkt1' : 'raw_credential',
      lookupMethod: resolved.decoded ? 'credential_id' : 'credential_code',
      payload: resolved.payload,
    } satisfies ResolvedScan
  }

  const byReservationCode = await prisma.ticket.findFirst({
    where: {
      eventId,
      OR: [{ reservationCode: code }, { metadata: { path: ['reservationCode'], equals: code } }],
    },
    select: {
      credential: { include: { attendee: true, ticket: { include: { ticketType: true, busSeats: { select: { id: true, label: true, passengerName: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } } } } } },
    },
  })
  if (byReservationCode?.credential) {
    return {
      credential: byReservationCode.credential,
      decoded: false,
      verified: false,
      tampered: false,
      parseSource: 'reservation_code',
      lookupMethod: 'reservation_code',
      payload: null,
    } satisfies ResolvedScan
  }

  return null
}

async function resolveScanCredential(rawCode: string, eventId: string): Promise<ResolvedScan> {
  const candidates = decodeScanCandidates(rawCode)
  let tampered: ResolvedScan | null = null

  for (const candidate of candidates) {
    const resolved = await resolveCredentialByCode(candidate.code, eventId)
    if (!resolved) continue
    if (resolved.tampered) {
      tampered = tampered ?? resolved
      continue
    }
    return resolved
  }

  if (tampered) return tampered

  // Keep a parse hint for valid-looking TKT1 payloads that don't resolve in DB
  for (const candidate of candidates) {
    const decoded = credentialCode.decode(candidate.code)
    if (decoded) {
      return {
        credential: null,
        decoded: true,
        verified: verifyPayload(decoded.payload, decoded.signature),
        tampered: false,
        parseSource: 'tkt1',
        lookupMethod: 'none',
        payload: decoded.payload,
      }
    }
  }

  return {
    credential: null,
    decoded: false,
    verified: false,
    tampered: false,
    parseSource: candidates.some((c) => c.source === 'reservation_code') ? 'reservation_code' : 'unknown',
    lookupMethod: 'none',
    payload: null,
  }
}

const registerSchema = z.object({
  deviceName: z.string().min(2),
  publicKey: z.string().min(10),
  deviceType: z.enum(['MOBILE', 'TABLET', 'DESKTOP', 'KIOSK', 'OTHER']).optional(),
  fingerprint: z.string().max(255).optional(),
  appVersion: z.string().max(64).optional(),
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

    const resolvedScan = await resolveScanCredential(body.code, eventId)
    let credential: any = resolvedScan.credential

    if (resolvedScan.tampered) {
      const decision: AccessDecision = { result: 'DENIED', reason: 'INVALID_CREDENTIAL' }
      await logAccess(eventId, body, credential, decision, ctx, req, area, {
        tampered: true,
        parseSource: resolvedScan.parseSource,
        lookupMethod: resolvedScan.lookupMethod,
      })
      return reply.send({
        data: {
          ...decision,
          credentialId: credential?.id ?? null,
          attendee: credential
            ? { id: credential.attendee.id, name: credential.attendee.name, category: credential.attendee.category }
            : null,
          ticketType: credential?.ticket?.ticketType.name ?? null,
          parseSource: resolvedScan.parseSource,
          lookupMethod: resolvedScan.lookupMethod,
        },
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
            reservationApprovalStatus: credential.ticket?.approvalStatus ?? null,
            reservationPaymentStatus: credential.ticket?.paymentStatus ?? null,
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

    const log = await logAccess(eventId, body, credential, decision, ctx, req, area, {
      ...(consumeNote ? { consumed: true } : {}),
      parseSource: resolvedScan.parseSource,
      lookupMethod: resolvedScan.lookupMethod,
      verified: resolvedScan.verified,
    })

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
        seats: (credential?.ticket as any)?.busSeats?.map((s: any) => ({ id: s.id, label: s.label, passengerName: s.passengerName, busName: s.bus?.name ?? null })) ?? [],
        parseSource: resolvedScan.parseSource,
        lookupMethod: resolvedScan.lookupMethod,
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
  // ?? Device heartbeat (scan ops / network) ????????????????
  app.post('/device/heartbeat', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'device.heartbeat', { eventId })
    const body = z.object({
      deviceId: z.string().min(1),
      networkStatus: z.enum(['ONLINE', 'OFFLINE', 'UNKNOWN']).optional(),
      appVersion: z.string().max(64).optional(),
    }).parse(req.body)
    const device = await prisma.device.findFirst({ where: { id: body.deviceId, eventId } })
    if (!device) throw errors.notFound('Device not found')
    if (device.status === 'REVOKED' || device.status === 'DISABLED') throw errors.forbidden('Device is disabled')
    const now = new Date()
    const updated = await prisma.device.update({
      where: { id: device.id },
      data: {
        lastSeenAt: now,
        lastHeartbeatAt: now,
        lastIp: req.ip,
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500) || device.userAgent,
        networkStatus: body.networkStatus ?? 'ONLINE',
        appVersion: body.appVersion ?? device.appVersion,
        status: device.status === 'REGISTERED' ? 'ACTIVE' : device.status,
      },
      select: { id: true, status: true, lastSeenAt: true, networkStatus: true },
    })
    return { data: { ok: true, device: updated } }
  })

  app.post('/sync', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'access.scan', { eventId })
    const body = syncSchema.parse(req.body)

    const device = await prisma.device.findUnique({ where: { id: body.deviceId } })
    if (!device || device.eventId !== eventId) throw errors.badRequest('Unknown device')
    if (device.status === 'REVOKED' || device.status === 'DISABLED') throw errors.forbidden('Device is disabled')

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
      const resolvedScan = await resolveScanCredential(item.code, eventId)
      const credential = resolvedScan.credential
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
              ticketTypeName: credential.ticket?.ticketType.name ?? null,
              reservationApprovalStatus: credential.ticket?.approvalStatus ?? null,
              reservationPaymentStatus: credential.ticket?.paymentStatus ?? null,
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
          metadata: {
            localId: item.localId,
            accepted,
            signatureValid,
            parseSource: resolvedScan.parseSource,
            lookupMethod: resolvedScan.lookupMethod,
            tampered: resolvedScan.tampered,
          } as any,
        },
      })
      results.push({
        localId: item.localId,
        accepted,
        authoritative: decision,
        credentialId: credential?.id ?? null,
        parseSource: resolvedScan.parseSource,
        lookupMethod: resolvedScan.lookupMethod,
      })
    }

    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), lastHeartbeatAt: new Date(), lastIp: req.ip, networkStatus: 'ONLINE' } })

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
          id: true, result: true, reason: true, timestamp: true, offline: true, metadata: true,
          area: { select: { id: true, name: true } },
          operator: { select: { id: true, name: true } },
          attendee: { select: { id: true, name: true } },
          credential: { select: { id: true, code: true, ticket: { select: { ticketType: { select: { name: true, tier: true } }, busSeats: { select: { id: true, label: true, passengerName: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } } } } } },
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
    action: decision.result === 'GRANTED' ? AuditActions.ACCESS_GRANTED : AuditActions.ACCESS_DENIED,
    resourceType: 'access_log',
    resourceId: log.id,
    newValue: {
      areaId: body.areaId,
      credentialId: credential?.id ?? null,
      reason: decision.reason,
      parseSource: (metadata as any)?.parseSource ?? null,
      lookupMethod: (metadata as any)?.lookupMethod ?? null,
    },
    sourceIp: req.ip,
  })
  return log
}