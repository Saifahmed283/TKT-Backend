import { prisma } from './db.js'
import type { ScopeContext } from './rbac.js'

/**
 * Builds the authorization context for a user within an event.
 * Resolves: organization membership → event membership → role → scope.
 */
export async function resolveEventContext(
  userId: string,
  eventId: string,
): Promise<ScopeContext | null> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, orgId: true },
  })
  if (!event) return null

  const user = await prisma.user.findUnique({
    where: { id: userId, status: 'ACTIVE' },
    select: { platformRole: true },
  })
  if (!user) return null
  if (user.platformRole === 'super_admin') {
    return {
      organizationId: event.orgId,
      eventId,
      teamId: null,
      areaIds: [],
      eventScope: 'ORGANIZATION',
      isSuperAdmin: true,
      orgRole: null,
    }
  }

  const orgMember = await prisma.organizationMember.findFirst({
    where: { orgId: event.orgId, userId, status: 'ACTIVE' },
    select: { role: true },
  })
  if (!orgMember) return null

  const member = await prisma.eventMember.findFirst({
    where: { eventId, userId, status: 'ACTIVE' },
    select: {
      role: { select: { scope: true, permissions: true } },
      teamId: true,
    },
  })

  let areaIds: string[] = []
  if (member) {
    const rows = await prisma.memberArea.findMany({
      where: { member: { eventId, userId } },
      select: { areaId: true },
    })
    areaIds = rows.map((r: (typeof rows)[number]) => r.areaId)
  }

  return {
    organizationId: event.orgId,
    eventId,
    teamId: member?.teamId ?? null,
    areaIds,
    eventScope: (member?.role.scope ?? (orgMember.role === 'OWNER' || orgMember.role === 'ADMIN' ? 'ORGANIZATION' : 'EVENT')) as ScopeContext['eventScope'],
    isSuperAdmin: false,
    orgRole: orgMember.role,
  }
}

export async function isSuperAdmin(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformRole: true },
  })
  return user?.platformRole === 'super_admin'
}

export async function getScopedContextForOrg(
  userId: string,
  organizationId: string,
): Promise<{ role: string; isSuperAdmin: boolean } | null> {
  const orgMember = await prisma.organizationMember.findFirst({
    where: { orgId: organizationId, userId, status: 'ACTIVE' },
    select: { role: true },
  })
  if (!orgMember) return null
  return { role: orgMember.role, isSuperAdmin: false }
}

export async function getPermissionsForEvent(userId: string, eventId: string) {
  const ctx = await resolveEventContext(userId, eventId)
  if (!ctx) return null
  const member = await prisma.eventMember.findUnique({
    where: { eventId_userId: { eventId, userId } },
    select: { role: { select: { code: true, name: true, scope: true, permissions: true } } },
  })
  if (!member) return null
  return {
    role: member.role,
    scope: ctx.eventScope,
    teamId: ctx.teamId,
    areaIds: ctx.areaIds,
    organizationId: ctx.organizationId,
  }
}