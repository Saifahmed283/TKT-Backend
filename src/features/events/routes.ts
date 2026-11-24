import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission, resolveOrgContext } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { publish, channelFor } from '../../lib/realtime.js'
import { logActivity } from '../../lib/activity.js'
import {
  EVENT_DOMAIN_CODES,
  EVENT_FORMAT_CODES,
  resolveEventCategory,
  resolveEventDomain,
  resolveEventFormat,
} from '../../config/taxonomy.js'

const EVENT_STATUSES = ['DRAFT', 'PLANNING', 'READY', 'PUBLISHED', 'LIVE', 'COMPLETED', 'ARCHIVED'] as const

function mergeJsonObjects(base: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key]
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      current && typeof current === 'object' && !Array.isArray(current)
    ) {
      result[key] = mergeJsonObjects(current, value)
    } else {
      result[key] = value
    }
  }
  return result
}

const STATUS_FLOW: Record<string, string[]> = {
  DRAFT: ['PLANNING', 'READY', 'ARCHIVED'],
  PLANNING: ['READY', 'DRAFT', 'ARCHIVED'],
  READY: ['PUBLISHED', 'PLANNING', 'DRAFT', 'ARCHIVED'],
  PUBLISHED: ['LIVE', 'COMPLETED', 'READY', 'ARCHIVED'],
  LIVE: ['COMPLETED', 'ARCHIVED'],
  COMPLETED: ['ARCHIVED'],
  ARCHIVED: [],
}

const createEventSchema = z.object({
  organizationId: z.string(),
  folderId: z.string().nullable().optional(),
  name: z.string().min(2),
  description: z.string().optional(),
  type: z.enum(EVENT_FORMAT_CODES).default('OTHER'),
  // Legacy label stays free-form so SAC values can be migrated additively.
  category: z.string().max(80).optional(),
  domain: z.enum(EVENT_DOMAIN_CODES).optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date().optional(),
  timezone: z.string().default('UTC'),
  venueName: z.string().optional(),
  venueAddress: z.string().optional(),
})

const updateEventSchema = z.object({
  folderId: z.string().nullable().optional(),
  name: z.string().min(2).optional(),
  description: z.string().nullable().optional(),
  type: z.enum(EVENT_FORMAT_CODES).optional(),
  category: z.string().max(80).nullable().optional(),
  domain: z.enum(EVENT_DOMAIN_CODES).nullable().optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().nullable().optional(),
  timezone: z.string().optional(),
  venueName: z.string().nullable().optional(),
  venueAddress: z.string().nullable().optional(),
  coverImageUrl: z.string().nullable().optional(),
  branding: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})

const statusSchema = z.object({ status: z.enum(EVENT_STATUSES) })

const memberSchema = z.object({
  userId: z.string(),
  roleId: z.string(),
  teamId: z.string().nullable().optional(),
  areaIds: z.array(z.string()).optional(),
})

const updateMemberSchema = z.object({
  roleId: z.string().optional(),
  teamId: z.string().nullable().optional(),
  status: z.enum(['ACTIVE', 'INVITED', 'SUSPENDED']).optional(),
  areaIds: z.array(z.string()).optional(),
})

async function resolveRole(roleId: string, orgId: string) {
  const role = await prisma.role.findUnique({ where: { id: roleId } })
  if (!role) throw errors.badRequest('Role not found')
  if (role.orgId && role.orgId !== orgId) throw errors.badRequest('Role belongs to another organization')
  return role
}

export async function eventRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // List events visible to the user
  app.get('/', async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        platformRole: true,
        orgMemberships: { select: { orgId: true, role: true } },
        eventMemberships: { select: { eventId: true } },
      },
    })
    if (!user) throw errors.unauthorized()

    const adminOrgIds = user.orgMemberships
      .filter((m: (typeof user.orgMemberships)[number]) => m.role === 'OWNER' || m.role === 'ADMIN')
      .map((m: (typeof user.orgMemberships)[number]) => m.orgId)
    const memberEventIds = user.eventMemberships.map((m: (typeof user.eventMemberships)[number]) => m.eventId)

    const events = await prisma.event.findMany({
      where:
        user.platformRole === 'super_admin'
          ? {}
          : { OR: [{ orgId: { in: adminOrgIds } }, { id: { in: memberEventIds } }] },
      select: {
        id: true, name: true, description: true, type: true, category: true, status: true,
        startAt: true, endAt: true, timezone: true, venueName: true, coverImageUrl: true,
        org: { select: { id: true, name: true } },
        _count: { select: { attendees: true, tickets: true, tasks: true, incidents: true } },
      },
      orderBy: [{ startAt: 'desc' }],
    })
    return { data: events }
  })

  app.post('/', async (req, reply) => {
    const body = createEventSchema.parse(req.body)
    const ctx = await resolveOrgContext(req, body.organizationId)
    if (!ctx.isAdmin) throw errors.forbidden()

    if (body.folderId) {
      const folder = await prisma.organizationFolder.findFirst({ where: { id: body.folderId, orgId: body.organizationId }, select: { id: true } })
      if (!folder) throw errors.badRequest('Folder not found in this organization')
    }
    const event = await prisma.event.create({
      data: {
        orgId: body.organizationId,
        folderId: body.folderId ?? null,
        name: body.name,
        description: body.description,
        type: body.type,
        // Legacy class stays independent from the event format.
        category: body.category ?? null,
        startAt: body.startAt,
        endAt: body.endAt,
        timezone: body.timezone,
        venueName: body.venueName,
        venueAddress: body.venueAddress,
        settings: {
          registration: { enabled: true, open: false },
          taxonomy: {
            format: resolveEventFormat(body.type)?.code ?? body.type,
            category: body.category
              ? resolveEventCategory(body.category)?.code ?? body.category
              : null,
            domain:
              resolveEventDomain(body.domain ?? body.category)?.code ?? 'OTHER',
            source: 'tkt',
          },
        },
      },
    })

    // Assign creator as Event Manager
    const managerRole = await prisma.role.findUnique({ where: { code: 'event_manager' } })
    if (managerRole) {
      await prisma.eventMember.create({
        data: { eventId: event.id, userId: req.user.id, roleId: managerRole.id, invitedBy: req.user.id },
      })
    }

    await writeAudit({
      organizationId: body.organizationId,
      eventId: event.id,
      actorUserId: req.user.id,
      action: 'event.created',
      resourceType: 'event',
      resourceId: event.id,
      newValue: { name: body.name, type: body.type },
      sourceIp: req.ip,
    })
    return reply.status(201).send({ data: event })
  })

  app.get('/:eventId', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'event.view', { eventId })
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      include: {
        org: { select: { id: true, name: true, slug: true } },
        _count: {
          select: {
            members: true, teams: true, areas: true, attendees: true,
            tickets: true, credentials: true, tasks: true, incidents: true, accessLogs: true,
          },
        },
      },
    })
    if (!event) throw errors.notFound('Event not found')
    return { data: event }
  })

  app.patch('/:eventId', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'event.update', { eventId })
    const body = updateEventSchema.parse(req.body)
    const { domain, settings: bodySettings, ...columnBody } = body
    const existing = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true, settings: true, type: true, category: true } })
    if (!existing) throw errors.notFound('Event not found')
    if (body.folderId !== undefined && body.folderId !== null) {
      const folder = await prisma.organizationFolder.findFirst({ where: { id: body.folderId, orgId: existing.orgId }, select: { id: true } })
      if (!folder) throw errors.badRequest('Folder not found in this organization')
    }

    const settings = mergeJsonObjects(
      (existing.settings as Record<string, any>) ?? {},
      (bodySettings as Record<string, any>) ?? {},
    )
    const taxonomy = (settings.taxonomy as Record<string, any>) ?? {}
    const nextFormat = body.type ?? existing.type
    const nextCategory = body.category === undefined ? existing.category : body.category
    const nextDomain =
      domain === null
        ? null
        : domain !== undefined
          ? resolveEventDomain(domain)?.code ?? domain
          : taxonomy.domain == null
            ? null
            : resolveEventDomain(taxonomy.domain)?.code ?? null

    const event = await prisma.event.update({
      where: { id: eventId },
      data: {
        ...columnBody,
        settings: {
          ...settings,
          taxonomy: {
            ...taxonomy,
            format: resolveEventFormat(nextFormat)?.code ?? nextFormat,
            category: nextCategory
              ? resolveEventCategory(nextCategory)?.code ?? nextCategory
              : null,
            domain: nextDomain ?? null,
            source: 'tkt',
          },
        },
      } as any,
    })
    await writeAudit({
      organizationId: event.orgId,
      eventId,
      actorUserId: req.user.id,
      action: 'event.updated',
      resourceType: 'event',
      resourceId: eventId,
      newValue: body,
      sourceIp: req.ip,
    })
    return { data: event }
  })

  // Status transitions (lifecycle)
  app.post('/:eventId/status', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    const { status } = statusSchema.parse(req.body)
    const perm = status === 'LIVE' ? 'event.publish' : status === 'ARCHIVED' ? 'event.archive' : 'event.update'
    const ctx = await requirePermission(req, perm, { eventId })

    const event = await prisma.event.findUnique({ where: { id: eventId } })
    if (!event) throw errors.notFound('Event not found')
    if (!STATUS_FLOW[event.status]?.includes(status)) {
      throw errors.badRequest(`Cannot transition event from ${event.status} to ${status}`)
    }

    let updated = await prisma.event.update({ where: { id: eventId }, data: { status } })

    // Lifecycle lock: once an event goes LIVE or COMPLETED, public
    // reservations close so capacity is never oversold.
    if (status === 'LIVE' || status === 'COMPLETED') {
      const settings = (event.settings as Record<string, any>) ?? {}
      const reg = (settings.registration as Record<string, any>) ?? {}
      if (reg.open !== false) {
        updated = await prisma.event.update({
          where: { id: eventId },
          data: { settings: { ...settings, registration: { ...reg, enabled: reg.enabled ?? true, open: false } } },
        })
      }
    }

    if (status === 'LIVE') {
      const members = await prisma.eventMember.findMany({
        where: { eventId, status: 'ACTIVE' },
        select: { userId: true },
      })
      type EventMemberRow = (typeof members)[number]
      await prisma.notification.createMany({
        data: members.map((m: EventMemberRow) => ({
          userId: m.userId, eventId,
          type: 'EVENT_LIVE',
          title: `${updated.name} is now LIVE`,
          body: 'Live operations have started. Open the event control center.',
        })),
      })
      publish(channelFor.activity(eventId), 'event-status', { status, eventId })
      logActivity(eventId, 'event', `Event is now ${status}`, req.user.name)
    }

    await writeAudit({
      organizationId: event.orgId,
      eventId,
      actorUserId: req.user.id,
      action: 'event.status_changed',
      resourceType: 'event',
      resourceId: eventId,
      previousValue: { status: event.status },
      newValue: { status },
      sourceIp: req.ip,
    })
    return reply.send({ data: updated })
  })

  // ── Event members (staff) ─────────────────────────────
  app.get('/:eventId/members', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'event.members.view', { eventId })
    const members = await prisma.eventMember.findMany({
      where: { eventId },
      select: {
        id: true, status: true, createdAt: true,
        role: { select: { id: true, code: true, name: true, scope: true } },
        team: { select: { id: true, name: true } },
        areas: { select: { area: { select: { id: true, name: true } } } },
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
    return { data: members }
  })

  app.post('/:eventId/members', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    const ctx = await requirePermission(req, 'event.members.assign', { eventId })
    const body = memberSchema.parse(req.body)

    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true, name: true } })
    if (!event) throw errors.notFound('Event not found')
    const role = await resolveRole(body.roleId, event.orgId)

    if (body.teamId) {
      const team = await prisma.team.findFirst({ where: { id: body.teamId, eventId } })
      if (!team) throw errors.badRequest('Team not found in this event')
    }
    if (body.areaIds?.length) {
      const areaCount = await prisma.area.count({ where: { id: { in: body.areaIds }, eventId } })
      if (areaCount !== body.areaIds.length) throw errors.badRequest('One or more areas not found in this event')
    }

    const existing = await prisma.eventMember.findUnique({
      where: { eventId_userId: { eventId, userId: body.userId } },
    })
    if (existing) throw errors.conflict('User is already assigned to this event')

    // Scope chain requires organization membership — grant it if missing
    const orgMember = await prisma.organizationMember.findUnique({
      where: { orgId_userId: { orgId: event.orgId, userId: body.userId } },
    })
    if (!orgMember) {
      await prisma.organizationMember.create({
        data: { orgId: event.orgId, userId: body.userId, role: 'VIEWER' },
      })
    }

    const member = await prisma.eventMember.create({
      data: {
        eventId,
        userId: body.userId,
        roleId: role.id,
        teamId: body.teamId ?? null,
        invitedBy: req.user.id,
        areas: body.areaIds?.length
          ? { create: body.areaIds.map((areaId) => ({ areaId })) }
          : undefined,
      },
    })

    await prisma.notification.create({
      data: {
        userId: body.userId, eventId,
        type: 'MEMBER_ASSIGNED',
        title: `You were assigned to ${event.name ?? 'an event'}`,
        body: `Role: ${role.name}`,
      },
    })
    await writeAudit({
      organizationId: event.orgId,
      eventId,
      actorUserId: req.user.id,
      action: 'staff.assigned',
      resourceType: 'event_member',
      resourceId: member.id,
      newValue: { userId: body.userId, roleId: role.id, teamId: body.teamId ?? null, areaIds: body.areaIds ?? [] },
      sourceIp: req.ip,
    })
    return reply.status(201).send({ data: member })
  })

  app.patch('/:eventId/members/:memberId', async (req) => {
    const { eventId, memberId } = req.params as { eventId: string; memberId: string }
    const ctx = await requirePermission(req, 'event.members.assign', { eventId })
    const body = updateMemberSchema.parse(req.body)

    const member = await prisma.eventMember.findFirst({ where: { id: memberId, eventId } })
    if (!member) throw errors.notFound('Member not found')

    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    if (!event) throw errors.notFound('Event not found')

    const data: any = {}
    if (body.roleId) {
      const role = await resolveRole(body.roleId, event.orgId)
      data.roleId = role.id
    }
    if (body.teamId !== undefined) {
      if (body.teamId) {
        const team = await prisma.team.findFirst({ where: { id: body.teamId, eventId } })
        if (!team) throw errors.badRequest('Team not found in this event')
      }
      data.teamId = body.teamId
    }
    if (body.status) data.status = body.status

    const updated = await prisma.eventMember.update({ where: { id: memberId }, data })

    if (body.areaIds) {
      await prisma.memberArea.deleteMany({ where: { eventMemberId: memberId } })
      if (body.areaIds.length) {
        const areaCount = await prisma.area.count({ where: { id: { in: body.areaIds }, eventId } })
        if (areaCount !== body.areaIds.length) throw errors.badRequest('One or more areas not found in this event')
        await prisma.memberArea.createMany({
          data: body.areaIds.map((areaId) => ({ eventMemberId: memberId, areaId })),
        })
      }
    }

    await writeAudit({
      organizationId: event.orgId,
      eventId,
      actorUserId: req.user.id,
      action: 'staff.updated',
      resourceType: 'event_member',
      resourceId: memberId,
      newValue: body,
      sourceIp: req.ip,
    })
    return { data: updated }
  })

  app.delete('/:eventId/members/:memberId', async (req, reply) => {
    const { eventId, memberId } = req.params as { eventId: string; memberId: string }
    const ctx = await requirePermission(req, 'event.members.remove', { eventId })
    const member = await prisma.eventMember.findFirst({ where: { id: memberId, eventId } })
    if (!member) throw errors.notFound('Member not found')
    if (member.userId === req.user.id) throw errors.badRequest('You cannot remove yourself')

    await prisma.eventMember.delete({ where: { id: memberId } })
    await writeAudit({
      eventId,
      actorUserId: req.user.id,
      action: 'staff.removed',
      resourceType: 'event_member',
      resourceId: memberId,
      sourceIp: req.ip,
    })
    return reply.status(204).send()
  })

  app.delete('/:eventId', async (req, reply) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'event.delete', { eventId })
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, orgId: true, name: true } })
    if (!event) throw errors.notFound('Event not found')
    await prisma.event.delete({ where: { id: eventId } })
    await writeAudit({
      organizationId: event.orgId,
      actorUserId: req.user.id,
      action: 'event.deleted',
      resourceType: 'event',
      resourceId: eventId,
      previousValue: { name: event.name },
      sourceIp: req.ip,
    })
    return reply.status(204).send()
  })

  // ── Overview (role-aware dashboard data) ──────────────
  // Roles assignable within this event (system catalog + organization custom roles)
  app.get('/:eventId/roles', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'event.members.assign', { eventId })
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    if (!event) throw errors.notFound('Event not found')
    const system = await prisma.role.findMany({
      where: { kind: 'SYSTEM' },
      select: { id: true, code: true, name: true, description: true, scope: true, permissions: true, kind: true, system: true },
      orderBy: { name: 'asc' },
    })
    const custom = await prisma.role.findMany({
      where: { orgId: event.orgId },
      select: { id: true, code: true, name: true, description: true, scope: true, permissions: true, kind: true, system: true },
      orderBy: { name: 'asc' },
    })
    return { data: { system, custom } }
  })

  // Organization members eligible for assignment to this event
  app.get('/:eventId/org-users', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'event.members.assign', { eventId })
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } })
    if (!event) throw errors.notFound('Event not found')
    const members = await prisma.organizationMember.findMany({
      where: { orgId: event.orgId, status: 'ACTIVE' },
      select: {
        userId: true,
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
    type AssignedMember = (typeof members)[number]
    const assigned = new Set(
      (await prisma.eventMember.findMany({ where: { eventId }, select: { userId: true } })).map((m: { userId: string }) => m.userId),
    )
    return { data: members.map((m: AssignedMember) => ({ ...m.user, assigned: assigned.has(m.userId) })) }
  })

  app.get('/:eventId/overview', async (req) => {
    const { eventId } = req.params as { eventId: string }
    const ctx = await requirePermission(req, 'event.view', { eventId })

    // All overview reads are independent — run them in a single parallel batch so
    // they share one network round-trip wave instead of several sequential ones.
    const [event, attendees, checkedIn, granted, denied, activeIncidents, openTasks, activeStaff, todayScans, areaScans, incidentsByPriority, tasksByStatus, recentAccess, recentIncidents, recentTasks] =
      await Promise.all([
        prisma.event.findUnique({ where: { id: eventId } }),
        prisma.attendee.count({ where: { eventId } }),
        prisma.attendee.count({ where: { eventId, status: 'CHECKED_IN' } }),
        prisma.accessLog.count({ where: { eventId, result: 'GRANTED' } }),
        prisma.accessLog.count({ where: { eventId, result: 'DENIED' } }),
        prisma.incident.count({ where: { eventId, status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED'] } } }),
        prisma.task.count({ where: { eventId, status: { in: ['TODO', 'IN_PROGRESS', 'BLOCKED'] } } }),
        prisma.eventMember.count({ where: { eventId, status: 'ACTIVE' } }),
        prisma.accessLog.count({ where: { eventId, timestamp: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } }),
        prisma.accessLog.groupBy({ by: ['areaId'], where: { eventId }, _count: true, orderBy: { _count: { areaId: 'desc' } }, take: 6 }),
        prisma.incident.groupBy({ by: ['priority'], where: { eventId }, _count: true }),
        prisma.task.groupBy({ by: ['status'], where: { eventId }, _count: true }),
        prisma.accessLog.findMany({
          where: { eventId },
          orderBy: { timestamp: 'desc' },
          take: 12,
          include: { area: { select: { name: true } }, credential: { select: { code: true } } },
        }),
        prisma.incident.findMany({
          where: { eventId },
          orderBy: { createdAt: 'desc' },
          take: 6,
          include: { area: { select: { name: true } }, assignee: { select: { name: true } }, team: { select: { name: true } } },
        }),
        prisma.task.findMany({
          where: { eventId },
          orderBy: { updatedAt: 'desc' },
          take: 6,
          include: { assignee: { select: { name: true } }, area: { select: { name: true } }, team: { select: { name: true } } },
        }),
      ])
    if (!event) throw errors.notFound('Event not found')

    return {
      data: {
        event,
        kpis: {
          attendees,
          checkedIn,
          checkInRate: attendees ? Math.round((checkedIn / attendees) * 100) : 0,
          granted,
          denied,
          accessSuccessRate: granted + denied ? Math.round((granted / (granted + denied)) * 100) : 100,
          activeIncidents,
          openTasks,
          activeStaff,
          todayScans,
        },
        incidentsByPriority,
        tasksByStatus,
        areaScans: areaScans.map((a: (typeof areaScans)[number]) => ({ areaId: a.areaId, count: a._count })),
        recentAccess,
        recentIncidents,
        recentTasks,
        myScope: {
          teamId: ctx.teamId,
          areaIds: ctx.areaIds,
          eventScope: ctx.eventScope,
          isSuperAdmin: ctx.isSuperAdmin,
        },
      },
    }
  })
}