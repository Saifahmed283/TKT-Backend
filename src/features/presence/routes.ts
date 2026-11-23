import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { logActivity, recentActivity } from '../../lib/activity.js'

type PresenceStatus = 'active' | 'away' | 'disconnected'

type PresenceRecord = {
  status: PresenceStatus
  lastSeen: string
  shiftStart: string | null
}

const heartbeatSchema = z.object({
  status: z.enum(['active', 'away', 'disconnected']).optional(),
})

const presence = new Map<string, PresenceRecord>()

export async function presenceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // Heartbeat from a worker's own session. Also usable as a "start shift" signal.
  app.post('/presence', async (req) => {
    const { eventId } = req.params as { eventId: string }
    const body = heartbeatSchema.parse(req.body ?? {})

    const member = await prisma.eventMember.findUnique({
      where: { eventId_userId: { eventId, userId: req.user.id } },
      select: { id: true, user: { select: { name: true } } },
    })
    if (!member) return { data: { status: 'disconnected', lastSeen: null, shiftStart: null, ignored: true } }

    const status = body.status ?? 'active'
    const prev = presence.get(member.id)
    const now = new Date().toISOString()
    const shiftStart =
      status === 'active' && prev?.shiftStart == null ? now : (prev?.shiftStart ?? null)

    presence.set(member.id, { status, lastSeen: now, shiftStart })

    if (!prev || prev.status !== status) {
      logActivity(eventId, 'presence', `${member.user.name} ${status}`, member.user.name)
    }
    return { data: { status, lastSeen: now, shiftStart } }
  })

  // Presence board: every event member plus their live status and on-shift time.
  app.get('/presence', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'event.members.view', { eventId })

    const members = await prisma.eventMember.findMany({
      where: { eventId },
      select: {
        id: true,
        role: { select: { code: true, name: true } },
        team: { select: { name: true } },
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    const now = Date.now()
    type PresenceMember = (typeof members)[number]
    const rows = members.map((m: PresenceMember) => {
      const p = presence.get(m.id)
      return {
        memberId: m.id,
        user: m.user,
        role: m.role,
        team: m.team,
        status: (p?.status ?? 'disconnected') as PresenceStatus,
        lastSeen: p?.lastSeen ?? null,
        shiftStart: p?.shiftStart ?? null,
        onShiftSeconds: p?.shiftStart
          ? Math.max(0, Math.floor((now - new Date(p.shiftStart).getTime()) / 1000))
          : 0,
      }
    })
    return { data: rows }
  })

  // Recent activity feed for the event (in-memory ring buffer).
  app.get('/activity', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'event.view', { eventId })
    const { limit } = req.query as { limit?: string }
    return { data: recentActivity(eventId, Number(limit) || 50) }
  })
}