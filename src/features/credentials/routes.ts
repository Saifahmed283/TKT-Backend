import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { credentialCode, verifyCredentialIntegrity, type CredentialPayload } from '../../lib/credentials.js'
import { logActivity } from '../../lib/activity.js'

const issueSchema = z.object({
  attendeeId: z.string(),
  ticketId: z.string().optional(),
  type: z.enum(['QR', 'BADGE', 'NFC', 'OTHER']).default('QR'),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().nullable().optional(),
  singleUse: z.boolean().default(true),
  allowReentry: z.boolean().default(false),
  areaIds: z.array(z.string()).optional(),
})

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED', 'CONSUMED']) })

export async function credentialRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'credential.view', { eventId })
    const { q, page = 1, pageSize = 25, status } = (req.query ?? {}) as { q?: string; page?: number; pageSize?: number; status?: string }
    const where: any = { eventId }
    if (status) where.status = status
    if (q) {
      where.OR = [
        { attendee: { name: { contains: q, mode: 'insensitive' } } },
        { attendee: { email: { contains: q, mode: 'insensitive' } } },
        { code: { contains: q } },
        { id: q },
      ]
    }
    const [total, rows] = await Promise.all([
      prisma.credential.count({ where }),
      prisma.credential.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: (Number(page) - 1) * Number(pageSize),
        take: Number(pageSize),
        select: {
          id: true, code: true, type: true, status: true, validFrom: true, validUntil: true,
          singleUse: true, allowReentry: true, areaIds: true, issuedAt: true,
          attendee: { select: { id: true, name: true, email: true } },
          ticket: { select: { id: true, ticketType: { select: { name: true } } } },
          _count: { select: { accessLogs: true } },
        },
      }),
    ])
    return { data: { rows, total } }
  })

  app.post('/', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'credential.issue', { eventId })
    const body = issueSchema.parse(req.body)
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true, startAt: true, endAt: true, name: true } })
    if (!event) throw errors.notFound('Event not found')

    const attendee = await prisma.attendee.findFirst({ where: { id: body.attendeeId, eventId } })
    if (!attendee) throw errors.badRequest('Attendee not found in this event')

    let ticket = null
    if (body.ticketId) {
      ticket = await prisma.ticket.findFirst({
        where: { id: body.ticketId, eventId, attendeeId: body.attendeeId },
        include: { ticketType: true },
      })
      if (!ticket) throw errors.badRequest('Ticket not found for this attendee')
      const existingCred = await prisma.credential.findUnique({ where: { ticketId: ticket.id } })
      if (existingCred) throw errors.conflict('This ticket already has a credential')
    }

    if (body.areaIds?.length) {
      const count = await prisma.area.count({ where: { id: { in: body.areaIds }, eventId } })
      if (count !== body.areaIds.length) throw errors.badRequest('One or more areas not found in this event')
    }

    const validFrom = body.validFrom ?? event.startAt
    const validUntil = body.validUntil !== undefined ? body.validUntil : event.endAt ?? null

    const payload: CredentialPayload = {
      v: 1,
      credId: '',
      attendeeId: attendee.id,
      eventId,
      ticketType: ticket?.ticketType.name ?? (attendee.category ?? 'GUEST'),
      attendeeName: attendee.name,
      validFrom: validFrom.getTime(),
      validUntil: validUntil ? validUntil.getTime() : null,
      singleUse: body.singleUse,
      allowReentry: body.allowReentry,
    }

    const credential = await prisma.credential.create({
      data: {
        eventId,
        attendeeId: attendee.id,
        ticketId: body.ticketId ?? null,
        type: body.type,
        code: `PENDING-${randomUUID()}`,
        status: 'ACTIVE',
        validFrom,
        validUntil,
        singleUse: body.singleUse,
        allowReentry: body.allowReentry,
        areaIds: body.areaIds ?? [],
        issuedById: req.user.id,
      },
    })

    payload.credId = credential.id
    const code = credentialCode.encode(payload)
    const final = await prisma.credential.update({ where: { id: credential.id }, data: { code } })

    await writeAudit({
      organizationId: event.orgId,
      eventId,
      actorUserId: req.user.id,
      action: 'credential.issued',
      resourceType: 'credential',
      resourceId: credential.id,
      newValue: { attendeeId: attendee.id, type: body.type, singleUse: body.singleUse, areaIds: body.areaIds ?? [] },
      sourceIp: req.ip,
    })
    logActivity(eventId, 'credential', `Credential issued · ${attendee.name}`, req.user.name)
    return reply.status(201).send({ data: final })
  })

  app.get('/:credentialId', async (req) => {
    const { eventId, credentialId } = req.params as { eventId: string; credentialId: string }
    await requirePermission(req, 'credential.view', { eventId })
    const credential = await prisma.credential.findFirst({
      where: { id: credentialId, eventId },
      include: {
        attendee: { select: { id: true, name: true, email: true, phone: true, category: true, status: true } },
        ticket: { include: { ticketType: { select: { name: true, price: true } } } },
        accessLogs: { orderBy: { timestamp: 'desc' }, take: 20, include: { area: { select: { name: true } }, operator: { select: { name: true } } } },
      },
    })
    if (!credential) throw errors.notFound('Credential not found')
    return { data: credential }
  })

  app.patch('/:credentialId/status', async (req) => {
    const { eventId, credentialId } = req.params as { eventId: string; credentialId: string }
    const { status } = statusSchema.parse(req.body)
    const perm = status === 'REVOKED' ? 'credential.revoke' : status === 'SUSPENDED' ? 'credential.suspend' : 'credential.view'
    await requirePermission(req, perm, { eventId })
    const credential = await prisma.credential.findFirst({ where: { id: credentialId, eventId } })
    if (!credential) throw errors.notFound('Credential not found')

    const updated = await prisma.credential.update({ where: { id: credentialId }, data: { status } })
    if (status === 'REVOKED' || status === 'SUSPENDED') {
      const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true, name: true } })
      const owner = await prisma.eventMember.findFirst({
        where: { eventId, role: { code: 'event_manager' } },
        select: { userId: true },
      })
      if (owner) {
        await prisma.notification.create({
          data: {
            userId: owner.userId, eventId,
            type: 'CREDENTIAL_REVOKED',
            title: `Credential ${status.toLowerCase()}`,
            body: `${updated.code.slice(0, 16)}â€¦ for ${credential.attendeeId} was ${status.toLowerCase()}`,
          },
        })
      }
      await writeAudit({
        organizationId: event?.orgId,
        eventId,
        actorUserId: req.user.id,
        action: `credential.${status.toLowerCase()}`,
        resourceType: 'credential',
        resourceId: credentialId,
        previousValue: { status: credential.status },
        newValue: { status },
        sourceIp: req.ip,
      })
      logActivity(eventId, 'credential', `Credential ${status.toLowerCase()} · ${updated.code.slice(0, 16)}…`, req.user.name)
    }
    return { data: updated }
  })

  /** Payload bundle for offline scanner devices */
  app.get('/:credentialId/offline-payload', async (req) => {
    const { eventId, credentialId } = req.params as { eventId: string; credentialId: string }
    await requirePermission(req, 'access.scan', { eventId })
    const credential = await prisma.credential.findFirst({
      where: { id: credentialId, eventId },
      select: {
        id: true, code: true, status: true, validFrom: true, validUntil: true,
        singleUse: true, allowReentry: true, areaIds: true,
        attendee: { select: { name: true, id: true } },
        ticket: { select: { ticketType: { select: { name: true } } } },
      },
    })
    if (!credential) throw errors.notFound('Credential not found')
    return { data: credential }
  })
}