import { prisma } from './db.js';
/**
 * Builds the authorization context for a user within an event.
 * Resolves: organization membership → event membership → role → scope.
 */
export async function resolveEventContext(userId, eventId) {
    const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { id: true, orgId: true },
    });
    if (!event)
        return null;
    const user = await prisma.user.findUnique({
        where: { id: userId, status: 'ACTIVE' },
        select: { platformRole: true },
    });
    if (!user)
        return null;
    if (user.platformRole === 'super_admin') {
        return {
            organizationId: event.orgId,
            eventId,
            teamId: null,
            areaIds: [],
            eventScope: 'ORGANIZATION',
            isSuperAdmin: true,
            orgRole: null,
        };
    }
    const orgMember = await prisma.organizationMember.findFirst({
        where: { orgId: event.orgId, userId, status: 'ACTIVE' },
        select: { role: true },
    });
    if (!orgMember)
        return null;
    const member = await prisma.eventMember.findFirst({
        where: { eventId, userId, status: 'ACTIVE' },
        select: {
            role: { select: { scope: true, permissions: true } },
            teamId: true,
        },
    });
    let areaIds = [];
    if (member) {
        const rows = await prisma.memberArea.findMany({
            where: { member: { eventId, userId } },
            select: { areaId: true },
        });
        areaIds = rows.map((r) => r.areaId);
    }
    return {
        organizationId: event.orgId,
        eventId,
        teamId: member?.teamId ?? null,
        areaIds,
        eventScope: (member?.role.scope ?? (orgMember.role === 'OWNER' || orgMember.role === 'ADMIN' ? 'ORGANIZATION' : 'EVENT')),
        isSuperAdmin: false,
        orgRole: orgMember.role,
    };
}
export async function isSuperAdmin(userId) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { platformRole: true },
    });
    return user?.platformRole === 'super_admin';
}
export async function getScopedContextForOrg(userId, organizationId) {
    const orgMember = await prisma.organizationMember.findFirst({
        where: { orgId: organizationId, userId, status: 'ACTIVE' },
        select: { role: true },
    });
    if (!orgMember)
        return null;
    return { role: orgMember.role, isSuperAdmin: false };
}
export async function getPermissionsForEvent(userId, eventId) {
    const ctx = await resolveEventContext(userId, eventId);
    if (!ctx)
        return null;
    const member = await prisma.eventMember.findUnique({
        where: { eventId_userId: { eventId, userId } },
        select: { role: { select: { code: true, name: true, scope: true, permissions: true } } },
    });
    if (!member)
        return null;
    return {
        role: member.role,
        scope: ctx.eventScope,
        teamId: ctx.teamId,
        areaIds: ctx.areaIds,
        organizationId: ctx.organizationId,
    };
}
//# sourceMappingURL=scope.js.map