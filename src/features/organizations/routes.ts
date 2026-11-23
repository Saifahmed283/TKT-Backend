import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { resolveOrgContext } from '../../middleware/authorize.js'
import { writeAudit } from '../../lib/audit.js'
import { BASE_ROLES, roleHasPermission, type BaseRoleDefinition } from '../../lib/rbac.js'
import { ALL_PERMISSIONS, PERMISSIONS } from '../../lib/rbac.js'

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

const createOrgSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
})

const updateOrgSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['OWNER', 'ADMIN', 'VIEWER']),
})

const updateMemberSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'VIEWER']).optional(),
  status: z.enum(['ACTIVE', 'INVITED', 'SUSPENDED']).optional(),
})

const createRoleSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  scope: z.enum(['ORGANIZATION', 'EVENT', 'TEAM', 'AREA']),
  permissions: z.array(z.string()).min(1),
})

const updateRoleSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().nullable().optional(),
  permissions: z.array(z.string()).optional(),
})

export async function organizationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // System role catalog for UI pickers
  app.get('/roles/catalog', async () => {
    const custom = await prisma.role.findMany({
      where: { kind: 'SYSTEM' },
      select: { id: true, code: true, name: true, description: true, scope: true, permissions: true, system: true },
    })
    return { data: custom }
  })

  // List organizations visible to user (all for super_admin/platform, else memberships)
  app.get('/', async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { platformRole: true } })
    if (user?.platformRole === 'super_admin') {
      const orgs = await prisma.organization.findMany({
        select: {
          id: true, name: true, slug: true, description: true, status: true, createdAt: true,
          _count: { select: { events: true, members: true } },
          events: { select: { id: true, name: true, status: true }, orderBy: { startAt: 'desc' }, take: 8 },
        },
        orderBy: { createdAt: 'asc' },
      })
      return { data: orgs.map((org) => ({ ...org, myRole: { name: 'PLATFORM_ADMIN' } })) }
    }

    const rows = await prisma.organizationMember.findMany({
      where: { userId: req.user.id },
      select: {
        role: true,
        org: {
          select: {
            id: true, name: true, slug: true, description: true, status: true, createdAt: true,
            _count: { select: { events: true, members: true } },
            events: { select: { id: true, name: true, status: true }, orderBy: { startAt: 'desc' }, take: 8 },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })
    type OrgRow = (typeof rows)[number]
    return {
      data: rows.map((r: OrgRow) => ({
        ...r.org,
        myRole: { name: r.role },
      })),
    }
  })

  app.post('/', async (req, reply) => {
    const body = createOrgSchema.parse(req.body)
    const slug = slugify(body.name)
    const existing = await prisma.organization.findUnique({ where: { slug } })
    if (existing) throw errors.conflict('An organization with this name already exists')

    const org = await prisma.organization.create({
      data: {
        name: body.name,
        slug,
        description: body.description,
      },
    })
    await prisma.organizationMember.create({
      data: { orgId: org.id, userId: req.user.id, role: 'OWNER' },
    })
    await writeAudit({
      organizationId: org.id,
      actorUserId: req.user.id,
      action: 'organization.created',
      resourceType: 'organization',
      resourceId: org.id,
      sourceIp: req.ip,
    })
    return reply.status(201).send({ data: org })
  })

  app.get('/:orgId', async (req) => {
    const { orgId } = req.params as { orgId: string }
    const ctx = await resolveOrgContext(req, orgId)
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        id: true, name: true, slug: true, description: true, logoUrl: true, settings: true, status: true, createdAt: true,
        _count: { select: { events: true, members: true } },
      },
    })
    if (!org) throw errors.notFound('Organization not found')
    return { data: { ...org, myRole: ctx.role } }
  })

  app.patch('/:orgId', { /* body: updateOrgSchema */ }, async (req) => {
    const { orgId } = req.params as { orgId: string }
    const ctx = await resolveOrgContext(req, orgId)
    if (!ctx.isAdmin) throw errors.forbidden()
    const body = updateOrgSchema.parse(req.body)
    if (body.name) {
      const slug = slugify(body.name)
      const existing = await prisma.organization.findUnique({ where: { slug } })
      if (existing && existing.id !== orgId) throw errors.conflict('Name already in use')
    }
    const org = await prisma.organization.update({ where: { id: orgId }, data: body as any })
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: 'organization.updated',
      resourceType: 'organization',
      resourceId: orgId,
      newValue: body,
      sourceIp: req.ip,
    })
    return { data: org }
  })

  // â”€â”€ Members â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/:orgId/members', async (req) => {
    const { orgId } = req.params as { orgId: string }
    await resolveOrgContext(req, orgId)
    const members = await prisma.organizationMember.findMany({
      where: { orgId },
      select: {
        id: true, role: true, status: true, createdAt: true,
        user: { select: { id: true, name: true, email: true, phone: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
    return { data: members }
  })

  app.post('/:orgId/members', async (req, reply) => {
    const { orgId } = req.params as { orgId: string }
    const ctx = await resolveOrgContext(req, orgId)
    if (!ctx.isAdmin) throw errors.forbidden()
    const body = inviteSchema.parse(req.body)

    let user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } })
    if (!user) {
      user = await prisma.user.create({
        data: {
          name: body.email.split('@')[0]!,
          email: body.email.toLowerCase(),
          passwordHash: await import('../../lib/auth.js').then((m) => m.hashPassword('tkt-change-me-2026')),
        },
      })
    }
    const existing = await prisma.organizationMember.findUnique({
      where: { orgId_userId: { orgId, userId: user.id } },
    })
    if (existing) throw errors.conflict('User is already a member')

    await prisma.organizationMember.create({
      data: { orgId, userId: user.id, role: body.role, status: 'ACTIVE' },
    })
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: 'organization.member.added',
      resourceType: 'organization_member',
      resourceId: user.id,
      newValue: { role: body.role },
      sourceIp: req.ip,
    })
    return reply.status(201).send({ data: { ok: true, userId: user.id } })
  })

  app.patch('/:orgId/members/:memberId', async (req) => {
    const { orgId, memberId } = req.params as { orgId: string; memberId: string }
    const ctx = await resolveOrgContext(req, orgId)
    if (!ctx.isAdmin) throw errors.forbidden()
    const body = updateMemberSchema.parse(req.body)
    const member = await prisma.organizationMember.findUnique({ where: { id: memberId } })
    if (!member || member.orgId !== orgId) throw errors.notFound('Member not found')
    if (member.userId === req.user.id && body.role && body.role !== 'OWNER')
      throw errors.badRequest('You cannot demote yourself')

    const updated = await prisma.organizationMember.update({
      where: { id: memberId },
      data: body,
    })
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: 'organization.member.updated',
      resourceType: 'organization_member',
      resourceId: memberId,
      newValue: body,
      sourceIp: req.ip,
    })
    return { data: updated }
  })

  app.delete('/:orgId/members/:memberId', async (req, reply) => {
    const { orgId, memberId } = req.params as { orgId: string; memberId: string }
    const ctx = await resolveOrgContext(req, orgId)
    if (!ctx.isAdmin) throw errors.forbidden()
    const member = await prisma.organizationMember.findUnique({ where: { id: memberId } })
    if (!member || member.orgId !== orgId) throw errors.notFound('Member not found')
    if (member.userId === req.user.id) throw errors.badRequest('You cannot remove yourself')

    await prisma.organizationMember.delete({ where: { id: memberId } })
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: 'organization.member.removed',
      resourceType: 'organization_member',
      resourceId: memberId,
      sourceIp: req.ip,
    })
    return reply.status(204).send()
  })

  // â”€â”€ Roles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/:orgId/roles', async (req) => {
    const { orgId } = req.params as { orgId: string }
    await resolveOrgContext(req, orgId)
    const custom = await prisma.role.findMany({
      where: { orgId },
      select: { id: true, code: true, name: true, description: true, scope: true, permissions: true, kind: true, system: true },
    })
    return {
      data: {
        system: BASE_ROLES.filter((r) => r.scope !== 'PLATFORM').map((r) => ({
          code: r.code, name: r.name, description: r.description, scope: r.scope, permissions: r.permissions, kind: 'SYSTEM' as const,
        })),
        custom,
      },
    }
  })

  app.post('/:orgId/roles', async (req, reply) => {
    const { orgId } = req.params as { orgId: string }
    const ctx = await resolveOrgContext(req, orgId)
    if (!ctx.isAdmin) throw errors.forbidden()
    const body = createRoleSchema.parse(req.body)
    for (const p of body.permissions) {
      if (!(p in PERMISSIONS)) throw errors.badRequest(`Unknown permission: ${p}`)
    }
    const role = await prisma.role.create({
      data: {
        orgId,
        name: body.name,
        code: `${slugify(body.name)}-${Date.now().toString(36)}`,
        description: body.description,
        scope: body.scope,
        kind: 'ORGANIZATION',
        permissions: body.permissions,
      },
    })
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: 'role.created',
      resourceType: 'role',
      resourceId: role.id,
      newValue: { name: body.name, scope: body.scope },
      sourceIp: req.ip,
    })
    return reply.status(201).send({ data: role })
  })

  app.patch('/:orgId/roles/:roleId', async (req) => {
    const { orgId, roleId } = req.params as { orgId: string; roleId: string }
    const ctx = await resolveOrgContext(req, orgId)
    if (!ctx.isAdmin) throw errors.forbidden()
    const body = updateRoleSchema.parse(req.body)
    if (body.permissions) {
      for (const p of body.permissions) {
        if (!(p in PERMISSIONS)) throw errors.badRequest(`Unknown permission: ${p}`)
      }
    }
    const role = await prisma.role.findFirst({ where: { id: roleId, orgId } })
    if (!role) throw errors.notFound('Role not found')
    if (role.system) throw errors.badRequest('System roles cannot be edited')
    const updated = await prisma.role.update({ where: { id: roleId }, data: body })
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: 'role.updated',
      resourceType: 'role',
      resourceId: roleId,
      newValue: body,
      sourceIp: req.ip,
    })
    return { data: updated }
  })

  app.delete('/:orgId/roles/:roleId', async (req, reply) => {
    const { orgId, roleId } = req.params as { orgId: string; roleId: string }
    const ctx = await resolveOrgContext(req, orgId)
    if (!ctx.isAdmin) throw errors.forbidden()
    const role = await prisma.role.findFirst({ where: { id: roleId, orgId } })
    if (!role) throw errors.notFound('Role not found')
    if (role.system) throw errors.badRequest('System roles cannot be deleted')
    const inUse = await prisma.eventMember.count({ where: { roleId } })
    if (inUse > 0) throw errors.conflict('Role is assigned to staff and cannot be deleted')
    await prisma.role.delete({ where: { id: roleId } })
    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: 'role.deleted',
      resourceType: 'role',
      resourceId: roleId,
      sourceIp: req.ip,
    })
    return reply.status(204).send()
  })

  app.get('/permissions/catalog', async () => {
    return {
      data: {
        permissions: ALL_PERMISSIONS.map((p) => ({ code: p, description: PERMISSIONS[p] })),
        scopes: ['PLATFORM', 'ORGANIZATION', 'EVENT', 'TEAM', 'AREA'],
      },
    }
  })
}