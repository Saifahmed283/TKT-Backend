import { z } from 'zod';
import { prisma } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/authorize.js';
import { writeAudit } from '../../lib/audit.js';
const createSchema = z.object({
    name: z.string().min(2),
    description: z.string().optional(),
    areaIds: z.array(z.string()).optional(),
});
const updateSchema = z.object({
    name: z.string().min(2).optional(),
    description: z.string().nullable().optional(),
    active: z.boolean().optional(),
    areaIds: z.array(z.string()).optional(),
});
export async function teamRoutes(app) {
    app.addHook('preHandler', authenticate);
    app.get('/', async (req) => {
        const { eventId } = req.params;
        await requirePermission(req, 'team.view', { eventId });
        const teams = await prisma.team.findMany({
            where: { eventId },
            select: {
                id: true, name: true, description: true, active: true, createdAt: true,
                _count: { select: { members: true, tasks: true } },
                areas: { select: { area: { select: { id: true, name: true, type: true } } } },
                members: {
                    select: {
                        user: { select: { id: true, name: true } },
                        role: { select: { name: true } },
                    },
                },
            },
            orderBy: { createdAt: 'asc' },
        });
        return { data: teams };
    });
    app.post('/', async (req, reply) => {
        const { eventId } = req.params;
        await requirePermission(req, 'team.create', { eventId });
        const body = createSchema.parse(req.body);
        const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } });
        if (!event)
            throw errors.notFound('Event not found');
        const existing = await prisma.team.findFirst({ where: { eventId, name: body.name } });
        if (existing)
            throw errors.conflict('A team with this name already exists');
        const team = await prisma.team.create({
            data: {
                eventId,
                name: body.name,
                description: body.description,
                areas: body.areaIds?.length ? { create: body.areaIds.map((areaId) => ({ areaId })) } : undefined,
            },
        });
        await writeAudit({
            organizationId: event.orgId,
            eventId,
            actorUserId: req.user.id,
            action: 'team.created',
            resourceType: 'team',
            resourceId: team.id,
            newValue: { name: body.name },
            sourceIp: req.ip,
        });
        return reply.status(201).send({ data: team });
    });
    app.get('/:teamId', async (req) => {
        const { eventId, teamId } = req.params;
        const ctx = await requirePermission(req, 'team.view', { eventId, target: { teamId } });
        const team = await prisma.team.findFirst({
            where: { id: teamId, eventId },
            include: {
                members: { select: { id: true, user: { select: { id: true, name: true, email: true } }, role: { select: { name: true, code: true } }, status: true } },
                areas: { select: { area: true } },
                tasks: { select: { id: true, title: true, status: true, priority: true } },
            },
        });
        if (!team)
            throw errors.notFound('Team not found');
        return { data: team };
    });
    app.patch('/:teamId', async (req) => {
        const { eventId, teamId } = req.params;
        await requirePermission(req, 'team.update', { eventId, target: { teamId } });
        const body = updateSchema.parse(req.body);
        const team = await prisma.team.findFirst({ where: { id: teamId, eventId } });
        if (!team)
            throw errors.notFound('Team not found');
        if (body.name) {
            const existing = await prisma.team.findFirst({ where: { eventId, name: body.name, NOT: { id: teamId } } });
            if (existing)
                throw errors.conflict('A team with this name already exists');
        }
        const updated = await prisma.team.update({ where: { id: teamId }, data: { name: body.name, description: body.description, active: body.active } });
        if (body.areaIds) {
            await prisma.teamArea.deleteMany({ where: { teamId } });
            await prisma.teamArea.createMany({ data: body.areaIds.map((areaId) => ({ teamId, areaId })) });
        }
        await writeAudit({
            eventId,
            actorUserId: req.user.id,
            action: 'team.updated',
            resourceType: 'team',
            resourceId: teamId,
            newValue: body,
            sourceIp: req.ip,
        });
        return { data: updated };
    });
    app.delete('/:teamId', async (req, reply) => {
        const { eventId, teamId } = req.params;
        await requirePermission(req, 'team.delete', { eventId, target: { teamId } });
        const team = await prisma.team.findFirst({ where: { id: teamId, eventId } });
        if (!team)
            throw errors.notFound('Team not found');
        await prisma.team.delete({ where: { id: teamId } });
        await writeAudit({ eventId, actorUserId: req.user.id, action: 'team.deleted', resourceType: 'team', resourceId: teamId, sourceIp: req.ip });
        return reply.status(204).send();
    });
}
//# sourceMappingURL=routes.js.map