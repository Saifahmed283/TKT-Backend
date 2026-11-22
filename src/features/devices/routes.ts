import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { AuditActions } from '../../lib/audit-actions.js'
import { logActivity } from '../../lib/activity.js'

const devicePatchSchema = z.object({
  name: z.string().min(2).optional(),
  type: z.enum(['MOBILE', 'TABLET', 'DESKTOP', 'KIOSK', 'OTHER']).optional(),
  status: z.enum(['REGISTERED', 'ACTIVE', 'DISABLED', 'REVOKED']).optional(),
  ownerId: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.any()).optional().nullable(),
})

const heartbeatSchema = z.object({
  deviceId: z.string().min(1),
  networkStatus: z.enum(['ONLINE', 'OFFLINE', 'UNKNOWN']).optional(),
  appVersion: z.string().max(64).optional(),
  fingerprint: z.string().max(255).optional(),
})

function lastSeenStatus(lastSeenAt: Date | null | undefined) {
  if (!lastSeenAt) return 'never'
  const ageMs = Date.now() - lastSeenAt.getTime()
  if (ageMs <= 60_000) return 'online'
  if (ageMs <= 5 * 60_000) return 'stale'
  return 'offline'
}

export async function deviceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'device.view', { eventId })

    const devices = await prisma.device.findMany({
      where: { eventId },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        _count: { select: { accessLogs: true } },
      },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    })

    const now = Date.now()
    const data = devices.map((d) => ({
      ...d,
      presence: lastSeenStatus(d.lastSeenAt),
      secondsSinceSeen: d.lastSeenAt ? Math.max(0, Math.floor((now - d.lastSeenAt.getTime()) / 1000)) : null,
    }))
    return { data }
  })

  app.get('/stats', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'device.view', { eventId })
    const devices = await prisma.device.findMany({
      where: { eventId },
      select: { id: true, status: true, lastSeenAt: true, networkStatus: true },
    })
    const now = Date.now()
    const online = devices.filter((d) => d.lastSeenAt && now - d.lastSeenAt.getTime() <= 60_000).length
    const stale = devices.filter((d) => d.lastSeenAt && now - d.lastSeenAt.getTime() > 60_000 && now - d.lastSeenAt.getTime() <= 5 * 60_000).length
    return {
      data: {
        total: devices.length,
        online,
        stale,
        offline: Math.max(0, devices.length - online - stale),
        disabled: devices.filter((d) => d.status === 'DISABLED' || d.status === 'REVOKED').length,
        networkOnline: devices.filter((d) => d.networkStatus === 'ONLINE').length,
      },
    }
  })

  app.patch('/:deviceId', async (req) => {
    const { eventId, deviceId } = req.params as { eventId: string; deviceId: string }
    await requirePermission(req, 'device.manage', { eventId })
    const body = devicePatchSchema.parse(req.body)
    const existing = await prisma.device.findFirst({ where: { id: deviceId, eventId } })
    if (!existing) throw errors.notFound('Device not found')

    const device = await prisma.device.update({
      where: { id: deviceId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata as any } : {}),
      },
      include: { owner: { select: { id: true, name: true, email: true } } },
    })

    await writeAudit({
      eventId, actorUserId: req.user.id,
      action: body.status === 'REVOKED' || body.status === 'DISABLED' ? AuditActions.DEVICE_REVOKED : AuditActions.DEVICE_UPDATED,
      resourceType: 'device', resourceId: deviceId,
      previousValue: { status: existing.status, name: existing.name },
      newValue: body, sourceIp: req.ip,
    })
    return { data: device }
  })

  app.post('/heartbeat', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'device.heartbeat', { eventId })
    const body = heartbeatSchema.parse(req.body)
    const existing = await prisma.device.findFirst({ where: { id: body.deviceId, eventId } })
    if (!existing) throw errors.notFound('Device not found')
    if (existing.status === 'REVOKED' || existing.status === 'DISABLED') {
      throw errors.forbidden('Device is disabled')
    }

    const now = new Date()
    const device = await prisma.device.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: now,
        lastHeartbeatAt: now,
        lastIp: req.ip,
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500) || existing.userAgent,
        networkStatus: body.networkStatus ?? 'ONLINE',
        appVersion: body.appVersion ?? existing.appVersion,
        fingerprint: body.fingerprint ?? existing.fingerprint,
        status: existing.status === 'REGISTERED' ? 'ACTIVE' : existing.status,
      },
      select: { id: true, name: true, status: true, lastSeenAt: true, networkStatus: true },
    })

    logActivity(eventId, 'device_heartbeat', `${device.name} heartbeat`, req.user.name)
    return { data: { ok: true, device } }
  })
}
