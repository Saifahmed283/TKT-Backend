import { z } from 'zod';
import { prisma } from '../../lib/db.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/authorize.js';
import { updateDbContext } from '../../lib/dbContext.js';
const querySchema = z.object({
    q: z.string().min(1),
    scope: z.enum(['EVENTS', 'ATTENDEES', 'TICKETS', 'CREDENTIALS', 'STAFF', 'TEAMS', 'TASKS', 'INCIDENTS', 'AREAS']).optional(),
});
/**
 * Global search â€” results are always filtered by the caller's
 * authorization scopes. Users never see results they cannot access.
 */
export async function searchRoutes(app) {
    app.addHook('preHandler', authenticate);
    app.get('/', async (req) => {
        const { q, scope } = querySchema.parse(req.query);
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: {
                platformRole: true,
                orgMemberships: { select: { orgId: true, role: true } },
                eventMemberships: { select: { eventId: true } },
            },
        });
        if (!user)
            return { data: {} };
        const adminOrgIds = user.orgMemberships
            .filter((m) => m.role === 'OWNER' || m.role === 'ADMIN')
            .map((m) => m.orgId);
        const memberEventIds = user.eventMemberships.map((m) => m.eventId);
        const eventAccess = user.platformRole === 'super_admin'
            ? {}
            : { OR: [{ orgId: { in: adminOrgIds } }, { id: { in: memberEventIds } }] };
        const candidateEvents = await prisma.event.findMany({ where: eventAccess, select: { id: true } });
        const candidateEventIds = candidateEvents.map((e) => e.id);
        await updateDbContext({ userId: req.user.id, eventIds: candidateEventIds, isSuperAdmin: user.platformRole === 'super_admin' });
        const out = {};
        const like = { contains: q, mode: 'insensitive' };
        const allowedEventIds = async (permission) => {
            const allowed = [];
            for (const eventId of candidateEventIds) {
                try {
                    await requirePermission(req, permission, { eventId });
                    allowed.push(eventId);
                }
                catch (err) {
                    if (err?.statusCode !== 403)
                        throw err;
                }
            }
            // requirePermission narrows context to one event at a time; restore the
            // full candidate set before the actual search queries run.
            await updateDbContext({
                userId: req.user.id,
                eventIds: candidateEventIds,
                eventId: undefined,
                orgId: undefined,
                isSuperAdmin: user.platformRole === 'super_admin',
            });
            return allowed;
        };
        if (!scope || scope === 'EVENTS') {
            const ids = await allowedEventIds('event.view');
            out.events = await prisma.event.findMany({
                where: { id: { in: ids }, OR: [{ name: like }, { venueName: like }, { description: like }] },
                select: { id: true, name: true, status: true, type: true, startAt: true },
                take: 8,
            });
        }
        if (!scope || scope === 'ATTENDEES') {
            const ids = await allowedEventIds('attendee.view');
            out.attendees = await prisma.attendee.findMany({
                where: { eventId: { in: ids }, OR: [{ name: like }, { email: like }] },
                select: { id: true, name: true, email: true, status: true, eventId: true },
                take: 8,
            });
        }
        if (!scope || scope === 'TICKETS') {
            const ids = await allowedEventIds('ticket.view');
            out.tickets = await prisma.ticket.findMany({
                where: { eventId: { in: ids }, attendee: { OR: [{ name: like }, { email: like }] } },
                select: { id: true, status: true, eventId: true, attendee: { select: { name: true } }, ticketType: { select: { name: true } } },
                take: 8,
            });
        }
        if (!scope || scope === 'CREDENTIALS') {
            const ids = await allowedEventIds('credential.view');
            out.credentials = await prisma.credential.findMany({
                where: { eventId: { in: ids }, OR: [{ code: { contains: q } }, { attendee: { name: like } }] },
                select: { id: true, code: true, status: true, eventId: true, attendee: { select: { name: true } } },
                take: 8,
            });
        }
        if (!scope || scope === 'STAFF') {
            const ids = await allowedEventIds('staff.view');
            out.staff = await prisma.eventMember.findMany({
                where: { eventId: { in: ids }, user: { OR: [{ name: like }, { email: like }] } },
                select: { id: true, eventId: true, user: { select: { id: true, name: true, email: true } }, role: { select: { name: true } } },
                take: 8,
            });
        }
        if (!scope || scope === 'TEAMS') {
            const ids = await allowedEventIds('team.view');
            out.teams = await prisma.team.findMany({
                where: { eventId: { in: ids }, name: like },
                select: { id: true, name: true, eventId: true },
                take: 8,
            });
        }
        if (!scope || scope === 'AREAS') {
            const ids = await allowedEventIds('area.view');
            out.areas = await prisma.area.findMany({
                where: { eventId: { in: ids }, name: like },
                select: { id: true, name: true, eventId: true, type: true },
                take: 8,
            });
        }
        if (!scope || scope === 'TASKS') {
            const ids = await allowedEventIds('task.view');
            out.tasks = await prisma.task.findMany({
                where: { eventId: { in: ids }, title: like },
                select: { id: true, title: true, status: true, eventId: true },
                take: 8,
            });
        }
        if (!scope || scope === 'INCIDENTS') {
            const ids = await allowedEventIds('incident.view');
            out.incidents = await prisma.incident.findMany({
                where: { eventId: { in: ids }, OR: [{ title: like }, { code: { contains: q } }] },
                select: { id: true, code: true, title: true, status: true, priority: true, eventId: true },
                take: 8,
            });
        }
        return { data: out };
    });
}
//# sourceMappingURL=routes.js.map