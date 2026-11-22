import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'

const querySchema = z.object({
  action: z.string().optional(),
  actorUserId: z.string().optional(),
  resourceType: z.string().optional(),
  result: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().optional(),
})

export async function auditRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'audit.view', { eventId })

    const { action, actorUserId, resourceType, result, from, to, page, pageSize, q } = querySchema.parse(req.query)
    const where: any = { eventId }
    if (action) where.action = action
    if (actorUserId) where.actorUserId = actorUserId
    if (resourceType) where.resourceType = resourceType
    if (result) where.result = result
    if (from || to) {
      where.timestamp = {}
      if (from) where.timestamp.gte = from
      if (to) where.timestamp.lte = to
    }
    if (q) {
      where.OR = [
        { action: { contains: q, mode: 'insensitive' } },
        { resourceId: { contains: q } },
      ]
    }

    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, action: true, resourceType: true, resourceId: true,
          previousValue: true, newValue: true, timestamp: true, result: true, sourceIp: true, sourceDevice: true,
          actor: { select: { id: true, name: true, email: true } },
        },
      }),
    ])
    return { data: { rows, total, page, pageSize } }
  })

  app.get('/actions', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'audit.view', { eventId })
    const rows = await prisma.auditLog.groupBy({
      by: ['action'],
      where: { eventId },
      _count: true,
      orderBy: { _count: { action: 'desc' } },
      take: 100,
    })
    type AuditActionRow = (typeof rows)[number]
    return { data: rows.map((r: AuditActionRow) => ({ action: r.action, count: r._count })) }
  })
}