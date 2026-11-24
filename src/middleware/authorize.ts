import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Permission, ScopeContext } from '../lib/rbac.js'
import { resolveEventContext, getScopedContextForOrg } from '../lib/scope.js'
import { errors } from '../lib/errors.js'
import { prisma } from '../lib/db.js'
import { updateDbContext } from '../lib/dbContext.js'

async function applyScopeToDbContext(userId: string, ctx: ScopeContext): Promise<void> {
  await updateDbContext({
    userId,
    orgId: ctx.organizationId || undefined,
    eventId: ctx.eventId || undefined,
    eventIds: ctx.eventId ? [ctx.eventId] : undefined,
    isSuperAdmin: ctx.isSuperAdmin,
  })
}

/**
 * Performs the full authorization chain:
 * Authenticated User → Organization Membership → Event Membership →
 * Role → Permission → Scope (event / team / area)
 */
export async function requirePermission(
  req: FastifyRequest,
  permission: Permission,
  opts?: {
    eventId?: string
    target?: { teamId?: string | null; areaId?: string | null }
  },
): Promise<ScopeContext> {
  const userId = req.user.id

  // Platform super admin
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformRole: true },
  })
  if (user?.platformRole === 'super_admin') {
    const ctx: ScopeContext = {
      organizationId: opts?.eventId ? (await prisma.event.findUnique({ where: { id: opts.eventId }, select: { orgId: true } }))?.orgId ?? '' : '',
      eventId: opts?.eventId ?? '',
      teamId: null,
      areaIds: [],
      eventScope: 'ORGANIZATION',
      isSuperAdmin: true,
      orgRole: null,
    }
    await applyScopeToDbContext(userId, ctx)
    return ctx
  }

  if (opts?.eventId) {
    const ctx = await resolveEventContext(userId, opts.eventId)
    if (!ctx) throw errors.forbidden()
    const member = await prisma.eventMember.findFirst({
      where: { eventId: opts.eventId, userId, status: 'ACTIVE' },
      select: { role: { select: { permissions: true } } },
    })
    const perms = Array.isArray(member?.role?.permissions)
      ? (member!.role!.permissions as string[])
      : []
    if (!perms.includes(permission)) {
      // Organization-level roles (admin/viewer) implicitly hold org permissions
      if (ctx.eventScope !== 'ORGANIZATION') throw errors.forbidden()
    }
    if (!hasScopeAccess(ctx, permission, opts.target)) throw errors.forbidden()
    await applyScopeToDbContext(userId, ctx)
    return ctx
  }

  // Organization-scoped permission
  const orgId = (req.params as any).orgId ?? (req.params as any).organizationId
  if (orgId) {
    const orgMember = await prisma.organizationMember.findFirst({
      where: { orgId, userId, status: 'ACTIVE' },
      select: { role: true },
    })
    if (!orgMember) throw errors.forbidden()
    const allowed = orgMember.role === 'OWNER' || orgMember.role === 'ADMIN'
    if (!allowed && permission !== 'org.view' && permission !== 'org.members.view' && permission !== 'org.roles.view' && permission !== 'org.analytics')
      throw errors.forbidden()
    const ctx: ScopeContext = {
      organizationId: orgId,
      eventId: '',
      teamId: null,
      areaIds: [],
      eventScope: 'ORGANIZATION',
      isSuperAdmin: false,
      orgRole: orgMember.role,
    }
    await applyScopeToDbContext(req.user.id, ctx)
    return ctx
  }

  throw errors.forbidden()
}

function hasScopeAccess(
  ctx: ScopeContext,
  permission: Permission,
  target?: { teamId?: string | null; areaId?: string | null },
): boolean {
  if (ctx.eventScope === 'ORGANIZATION') return true
  if (ctx.eventScope === 'EVENT') return true
  if (ctx.eventScope === 'TEAM') {
    if (ctx.teamId && target?.teamId && target.teamId !== ctx.teamId) return false
    if (target?.areaId && !ctx.areaIds.includes(target.areaId)) return false
    return true
  }
  // AREA scope
  if (target?.areaId) return ctx.areaIds.includes(target.areaId)
  if (target?.teamId) return false
  return true
}

export async function resolveOrgContext(
  req: FastifyRequest,
  organizationId: string,
): Promise<{ role: 'OWNER' | 'ADMIN' | 'VIEWER'; isAdmin: boolean }> {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { platformRole: true },
  })
  if (user?.platformRole === 'super_admin') {
    await updateDbContext({ userId: req.user.id, orgId: organizationId, isSuperAdmin: true })
    return { role: 'ADMIN', isAdmin: true }
  }
  const member = await prisma.organizationMember.findFirst({
    where: { orgId: organizationId, userId: req.user.id, status: 'ACTIVE' },
    select: { role: true },
  })
  if (!member) throw errors.forbidden()
  await updateDbContext({ userId: req.user.id, orgId: organizationId, isSuperAdmin: false })
  return { role: member.role, isAdmin: member.role === 'OWNER' || member.role === 'ADMIN' }
}

export { getScopedContextForOrg }