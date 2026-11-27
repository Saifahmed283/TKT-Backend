import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { AuditActions } from '../../lib/audit-actions.js'
import { verifyCredentialIntegrity, verifyPayload, publicKeyPem, credentialCode, credentialInclude, type CredentialPayload } from '../../lib/credentials.js'
import { validateAccess, type AccessDecision } from '../../lib/access-engine.js'
import type { ScopeContext } from '../../lib/rbac.js'
import { hasScopeAccess } from '../../middleware/authorize.js'
import { updateDbContext } from '../../lib/dbContext.js'
import { createPublicKey, verify } from 'node:crypto'
import { publish, channelFor } from '../../lib/realtime.js'
import { logActivity } from '../../lib/activity.js'
import { afterResponse } from '../../lib/background.js'
import { reservationApprovalOf, reservationPaymentOf } from '../reservations/service.js'

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

async function resolveCredentialByCode(code: string, eventId: string, client: any = prisma) {
  const resolved = await verifyCredentialIntegrity(code, eventId, client)
  if (resolved?.credential) {
    const credential = resolved.credential
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

  const byReservationCode = await client.ticket.findFirst({
    where: {
      eventId,
      OR: [{ reservationCode: code }, { metadata: { path: ['reservationCode'], equals: code } }],
    },
    select: {
      credential: { include: credentialInclude },
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

async function resolveScanCredential(rawCode: string, eventId: string, client: any = prisma): Promise<ResolvedScan> {
  const candidates = decodeScanCandidates(rawCode)
  let tampered: ResolvedScan | null = null

  for (const candidate of candidates) {
    const resolved = await resolveCredentialByCode(candidate.code, eventId, client)
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

type AccessInput = Parameters<typeof validateAccess>[0]

function accessInputFor(
  credential: any,
  event: { id: string; status: string },
  area: { id: string; active: boolean; accessPolicy: string } | null,
  ctx: { areaIds: string[]; eventScope: string; isSuperAdmin: boolean },
  options: { tampered?: boolean } = {},
): AccessInput {
  const ticket = credential?.ticket
  return {
    credential: credential
      ? {
          id: credential.id,
          eventId: credential.eventId,
          status: credential.status,
          validFrom: credential.validFrom,
          validUntil: credential.validUntil,
          singleUse: credential.singleUse,
          allowReentry: credential.allowReentry,
          areaIds: credential.areaIds,
          code: credential.code,
          tampered: options.tampered === true || credential.eventId !== event.id,
          attendeeStatus: credential.attendee?.status ?? null,
          ticketStatus: ticket?.status ?? null,
          ticketTypeName: ticket?.ticketType?.name ?? null,
          reservationApprovalStatus: ticket ? reservationApprovalOf(ticket) : null,
          reservationPaymentStatus: ticket ? reservationPaymentOf(ticket) : null,
        }
      : null,
    event: { id: event.id, status: event.status },
    area: area ? { id: area.id, active: area.active, accessPolicy: area.accessPolicy } : null,
    operator: {
      areaIds: ctx.areaIds,
      eventScope: ctx.eventScope,
      isSuperAdmin: ctx.isSuperAdmin,
    },
  }
}

/** Preview tickets are explicitly marked in ticket metadata for gate testing. */
function isPreviewTicket(credential: any): boolean {
  const metadata = credential?.ticket?.metadata as Record<string, unknown> | null | undefined
  if (!metadata || typeof metadata !== 'object') return false
  const value = metadata.previewTicket ?? metadata.testTicket
  return value === true || value === 'true'
}

/**
 * A preview ticket keeps all identity/status/area/permission checks but ignores
 * only the event status and time window. Preview scans never consume the
 * credential or check the attendee in.
 */
function evaluateAccess(input: AccessInput, credential: any): { decision: AccessDecision; preview: boolean } {
  const authoritative = validateAccess(input)
  if (!credential || !isPreviewTicket(credential) || authoritative.result !== 'DENIED') {
    return { decision: authoritative, preview: false }
  }
  if (!['OUTSIDE_TIME_WINDOW', 'EVENT_NOT_LIVE', 'EXPIRED'].includes(authoritative.reason)) {
    return { decision: authoritative, preview: false }
  }

  const now = input.now ?? new Date()
  const validFromMs = credential.validFrom instanceof Date
    ? credential.validFrom.getTime()
    : new Date(credential.validFrom).getTime()
  const previewNow = new Date(Math.max(now.getTime(), Number.isFinite(validFromMs) ? validFromMs + 1000 : now.getTime()))
  const previewDecision = validateAccess({
    ...input,
    now: previewNow,
    event: { ...input.event, status: 'LIVE' },
  })
  if (previewDecision.result !== 'GRANTED') return { decision: authoritative, preview: false }
  return { decision: previewDecision, preview: true }
}

type ScanLookup = {
  event: { id: string; orgId: string; status: string; startAt: Date | null; endAt: Date | null }
  area: { id: string; eventId: string; name: string; active: boolean; accessPolicy: string } | null
  auth: {
    platformRole: string | null
    orgRole: string | null
    eventMember: { scope: string; permissions: unknown; teamId: string | null } | null
    areaIds: string[]
  } | null
}

/** One SQL round trip for the event, gate area, and the operator's scope. */
async function lookupScanContext(tx: any, userId: string, eventId: string, areaId: string): Promise<ScanLookup | null> {
  const rows = await tx.$queryRaw<ScanLookup[]>`SELECT
    jsonb_build_object(
      'id', e.id,
      'orgId', e."orgId",
      'status', e.status,
      'startAt', e."startAt",
      'endAt', e."endAt"
    ) AS event,
    CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', a.id,
      'eventId', a."eventId",
      'name', a.name,
      'active', a.active,
      'accessPolicy', a."accessPolicy"
    ) END AS area,
    CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object(
      'platformRole', u."platformRole",
      'orgRole', (
        SELECT om.role FROM "OrganizationMember" om
        WHERE om."orgId" = e."orgId" AND om."userId" = u.id AND om.status = 'ACTIVE'
        LIMIT 1
      ),
      'eventMember', (
        SELECT jsonb_build_object(
          'scope', r.scope,
          'permissions', r.permissions,
          'teamId', em."teamId"
        )
        FROM "EventMember" em
        JOIN "Role" r ON r.id = em."roleId"
        WHERE em."eventId" = e.id AND em."userId" = u.id AND em.status = 'ACTIVE'
        LIMIT 1
      ),
      'areaIds', COALESCE((
        SELECT jsonb_agg(ma."areaId")
        FROM "MemberArea" ma
        JOIN "EventMember" em ON em.id = ma."eventMemberId"
        WHERE em."eventId" = e.id AND em."userId" = u.id
      ), '[]'::jsonb)
    ) END AS auth
  FROM "Event" e
  LEFT JOIN "Area" a ON a.id = ${areaId} AND a."eventId" = e.id
  LEFT JOIN "User" u ON u.id = ${userId} AND u.status = 'ACTIVE'
  WHERE e.id = ${eventId}`
  return rows[0] ?? null
}

/**
 * Mirrors requirePermission('access.scan', { areaId }) using the single-row
 * lookup above, avoiding several RLS-scoped round trips per scan.
 */
function authorizeScan(req: any, lookup: ScanLookup, areaId: string): ScopeContext {
  const { event, auth } = lookup
  const superCtx = (): ScopeContext => ({
    organizationId: event.orgId,
    eventId: event.id,
    teamId: null,
    areaIds: [],
    eventScope: 'ORGANIZATION',
    isSuperAdmin: true,
    orgRole: null,
  })

  if (req.platformRole === 'super_admin' || auth?.platformRole === 'super_admin') return superCtx()
  if (!auth?.orgRole) throw errors.forbidden()

  const member = auth.eventMember
  const permissions = Array.isArray(member?.permissions) ? (member!.permissions as string[]) : []
  const eventScope = (member?.scope ?? (auth.orgRole === 'OWNER' || auth.orgRole === 'ADMIN' ? 'ORGANIZATION' : 'EVENT')) as ScopeContext['eventScope']
  if (!permissions.includes('access.scan') && eventScope !== 'ORGANIZATION') throw errors.forbidden()

  const ctx: ScopeContext = {
    organizationId: event.orgId,
    eventId: event.id,
    teamId: member?.teamId ?? null,
    areaIds: auth.areaIds ?? [],
    eventScope,
    isSuperAdmin: false,
    orgRole: auth.orgRole,
  }
  if (!hasScopeAccess(ctx, 'access.scan', { areaId })) throw errors.forbidden()
  return ctx
}

async function recordScanTx(tx: any, params: {
  eventId: string
  body: { areaId: string; deviceId?: string }
  credential: any
  decision: AccessDecision
  req: any
  metadata?: Record<string, unknown>
  preview?: boolean
  consume?: boolean
}) {
  let decision = params.decision
  let consumed = false

  if (params.consume && params.credential?.singleUse && !params.credential.allowReentry) {
    const updated = await tx.credential.updateMany({
      where: { id: params.credential.id, eventId: params.eventId, status: 'ACTIVE' },
      data: { status: 'CONSUMED' },
    })
    if (updated.count === 0) {
      // Another gate consumed the credential between read and write. Fail closed.
      decision = { result: 'DENIED', reason: 'ALREADY_USED' }
    } else {
      consumed = true
      await tx.attendee.updateMany({
        where: { id: params.credential.attendeeId, eventId: params.eventId },
        data: { status: 'CHECKED_IN' },
      })
    }
  }

  const metadata = {
    ...(params.metadata ?? {}),
    ...(consumed ? { consumed: true } : {}),
    ...(params.preview ? { preview: true } : {}),
  }

  const log = await tx.accessLog.create({
    data: {
      eventId: params.eventId,
      credentialId: params.credential?.id ?? null,
      attendeeId: params.credential?.attendeeId ?? null,
      operatorUserId: params.req.user.id,
      deviceId: params.body.deviceId ?? null,
      areaId: params.body.areaId,
      result: decision.result,
      reason: decision.reason,
      metadata: metadata as any,
    },
  })

  return {
    log,
    decision,
    consumed,
    auditAction: params.preview
      ? AuditActions.ACCESS_PREVIEW
      : decision.result === 'GRANTED'
        ? AuditActions.ACCESS_GRANTED
        : AuditActions.ACCESS_DENIED,
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

    // Scope the RLS context to the event before opening the transaction so
    // authorization, credential lookup, and the write all share one context.
    await updateDbContext({
      userId: req.user.id,
      eventId,
      eventIds: [eventId],
      isSuperAdmin: req.platformRole === 'super_admin',
    })

    const scan = await prisma.$transaction(async (tx) => {
      const lookup = await lookupScanContext(tx, req.user.id, eventId, body.areaId)
      if (!lookup) throw errors.notFound('Event not found')
      const { event, area } = lookup
      if (!area || area.eventId !== eventId) {
        throw errors.badRequest('Area not found in this event')
      }

      const ctx = authorizeScan(req, lookup, body.areaId)

      const resolvedScan = await resolveScanCredential(body.code, eventId, tx)
      const credential: any = resolvedScan.credential
      const metadata: Record<string, unknown> = {
        parseSource: resolvedScan.parseSource,
        lookupMethod: resolvedScan.lookupMethod,
        verified: resolvedScan.verified,
        ...(resolvedScan.tampered ? { tampered: true } : {}),
      }

      const evaluated = evaluateAccess(
        accessInputFor(credential, event, area, ctx, { tampered: resolvedScan.tampered }),
        credential,
      )
      const decision = evaluated.decision
      const preview = evaluated.preview

      const recorded = await recordScanTx(tx, {
        eventId,
        body,
        credential,
        decision,
        req,
        metadata,
        preview,
        consume: decision.result === 'GRANTED' && !preview,
      })

      return { event, area, resolvedScan, credential, recorded, preview }
    })

    const { event, area, resolvedScan, credential, recorded, preview } = scan
    const finalDecision = recorded.decision

    void afterResponse(
      req,
      'access.audit',
      { userId: req.user.id, orgId: event.orgId, eventId, isInternal: true },
      () => writeAudit({
        organizationId: event.orgId,
        eventId,
        actorUserId: req.user.id,
        action: recorded.auditAction,
        resourceType: 'access_log',
        resourceId: recorded.log.id,
        newValue: {
          areaId: body.areaId,
          credentialId: credential?.id ?? null,
          reason: finalDecision.reason,
          parseSource: resolvedScan.parseSource,
          lookupMethod: resolvedScan.lookupMethod,
          preview,
          consumed: recorded.consumed,
        },
        sourceIp: req.ip,
      }),
    )

    publish(channelFor.access(eventId), 'scan', {
      id: recorded.log.id,
      eventId,
      result: finalDecision.result,
      reason: finalDecision.reason,
      areaId: area.id,
      areaName: area.name,
      timestamp: recorded.log.timestamp,
      attendeeName: credential?.attendee?.name,
      ticketType: credential?.ticket?.ticketType.name,
      preview,
    })

    logActivity(
      eventId,
      'scan',
      `${credential?.attendee?.name ?? 'Unknown'} ${finalDecision.result === 'GRANTED' ? (preview ? 'previewed at' : 'entered') : 'was denied at'} ${area.name}`,
      req.user.name,
    )

    return reply.send({
      data: {
        ...finalDecision,
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
        validFrom: credential?.validFrom?.toISOString?.() ?? null,
        validUntil: credential?.validUntil?.toISOString?.() ?? null,
        eventStatus: event.status,
        preview,
      },
    })
  })

  // â”€â”€ Offline device registration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.post('/device/register', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    // Scanners register their own device; they hold device.view but not the
    // event-wide device.manage permission.
    await requirePermission(req, 'device.view', { eventId, allowNarrowNoTarget: true })
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
    await requirePermission(req, 'device.heartbeat', { eventId, allowNarrowNoTarget: true })
    const body = z.object({
      deviceId: z.string().min(1),
      networkStatus: z.enum(['ONLINE', 'OFFLINE', 'UNKNOWN']).optional(),
      appVersion: z.string().max(64).optional(),
    }).parse(req.body)
    const device = await prisma.device.findFirst({ where: { id: body.deviceId, eventId, ownerId: req.user.id } })
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
    // Each queued item is re-checked against the operator's area below.
    await requirePermission(req, 'access.scan', { eventId, allowNarrowNoTarget: true })
    const body = syncSchema.parse(req.body)

    const areaIds = [...new Set(body.items.map((item) => item.areaId))]
    const areaCount = await prisma.area.count({ where: { id: { in: areaIds }, eventId } })
    if (areaCount !== areaIds.length) throw errors.badRequest('One or more areas not found in this event')

    const device = await prisma.device.findUnique({ where: { id: body.deviceId } })
    if (!device || device.eventId !== eventId || device.ownerId !== req.user.id) throw errors.badRequest('Unknown device')
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
      const area = await prisma.area.findFirst({ where: { id: item.areaId, eventId } })
      const itemCtx = await requirePermission(req, 'access.scan', { eventId, target: { areaId: item.areaId } })

      const decision = validateAccess(accessInputFor(
        credential,
        { id: eventId, status: event.status },
        area ? { id: area.id, active: area.active, accessPolicy: area.accessPolicy } : null,
        itemCtx,
        { tampered: resolvedScan.tampered },
      ))

      const localDecision = item.decision === 'GRANTED' ? 'GRANTED' : 'DENIED'
      let match = localDecision === decision.result
      let authoritativeDecision = decision

      // Only accept offline grants when they match the authoritative result and
      // the single-use credential can still be consumed atomically.
      let accepted = match
      if (match && decision.result === 'GRANTED' && credential) {
        if (credential.singleUse && !credential.allowReentry) {
          const updated = await prisma.credential.updateMany({
            where: { id: credential.id, eventId, status: 'ACTIVE' },
            data: { status: 'CONSUMED' },
          })
          if (updated.count === 0) {
            match = false
            accepted = false
            authoritativeDecision = { result: 'DENIED', reason: 'ALREADY_USED' }
          } else {
            await prisma.attendee.updateMany({
              where: { id: credential.attendeeId, eventId },
              data: { status: 'CHECKED_IN' },
            })
          }
        }
      }
      if (!match) {
        conflicts.push({
          localId: item.localId,
          localDecision,
          authoritativeDecision: authoritativeDecision.result,
          reason: authoritativeDecision.reason,
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
          result: authoritativeDecision.result,
          reason: authoritativeDecision.reason,
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
        authoritative: authoritativeDecision,
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
    const ctx = await requirePermission(req, 'access.logs.view', { eventId, allowNarrowNoTarget: true })
    const { page = 1, pageSize = 25, result, areaId } = (req.query ?? {}) as { page?: number; pageSize?: number; result?: string; areaId?: string }
    const where: any = { eventId }
    if (result) where.result = result
    if (ctx.eventScope === 'AREA') {
      where.areaId = { in: areaId && ctx.areaIds.includes(areaId) ? [areaId] : ctx.areaIds }
    } else if (areaId) {
      where.areaId = areaId
    }

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

