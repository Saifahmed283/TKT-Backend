import { z } from 'zod';
import { prisma } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/authorize.js';
import { writeAudit } from '../../lib/audit.js';
const AREA_TYPES = ['GATE', 'HALL', 'STAGE', 'LOUNGE', 'OFFICE', 'MEDICAL', 'PARKING', 'EXIT', 'SERVICE', 'OTHER'];
const POLICIES = ['OPEN', 'TICKETED', 'VIP_ONLY', 'STAFF_ONLY', 'RESTRICTED', 'MEDIA_ONLY'];
const createSchema = z.object({
    name: z.string().min(2),
    description: z.string().optional(),
    type: z.enum(AREA_TYPES).default('OTHER'),
    accessPolicy: z.enum(POLICIES).default('OPEN'),
    capacity: z.number().int().positive().optional(),
    location: z.record(z.string(), z.unknown()).optional(),
});
const updateSchema = createSchema.partial().extend({ active: z.boolean().optional() });
export async function areaRoutes(app) {
    app.addHook('preHandler', authenticate);
    app.get('/', async (req) => {
        const { eventId } = req.params;
        const ctx = await requirePermission(req, 'area.view', { eventId });
        const areas = await prisma.area.findMany({
            where: { eventId },
            select: {
                id: true, name: true, description: true, type: true, accessPolicy: true,
                capacity: true, location: true, active: true, createdAt: true,
                _count: { select: { assignments: true, teamAssignments: true, accessLogs: true } },
                teamAssignments: { select: { team: { select: { id: true, name: true } } } },
                assignments: { select: { member: { select: { id: true, user: { select: { id: true, name: true } } } } } },
            },
            orderBy: { createdAt: 'asc' },
        });
        return { data: areas };
    });
    app.post('/', async (req, reply) => {
        const { eventId } = req.params;
        await requirePermission(req, 'area.create', { eventId });
        const body = createSchema.parse(req.body);
        const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } });
        if (!event)
            throw errors.notFound('Event not found');
        const existing = await prisma.area.findFirst({ where: { eventId, name: body.name } });
        if (existing)
            throw errors.conflict('An area with this name already exists');
        const area = await prisma.area.create({ data: { eventId, ...body } });
        await writeAudit({
            organizationId: event.orgId,
            eventId,
            actorUserId: req.user.id,
            action: 'area.created',
            resourceType: 'area',
            resourceId: area.id,
            newValue: { name: body.name, type: body.type, accessPolicy: body.accessPolicy },
            sourceIp: req.ip,
        });
        return reply.status(201).send({ data: area });
    });
    app.get('/:areaId', async (req) => {
        const { eventId, areaId } = req.params;
        await requirePermission(req, 'area.view', { eventId, target: { areaId } });
        const area = await prisma.area.findFirst({
            where: { id: areaId, eventId },
            include: {
                assignments: { select: { member: { select: { id: true, user: { select: { name: true, email: true } }, role: { select: { name: true } } } } } },
                teamAssignments: { select: { team: { select: { id: true, name: true } } } },
            },
        });
        if (!area)
            throw errors.notFound('Area not found');
        return { data: area };
    });
    app.patch('/:areaId', async (req) => {
        const { eventId, areaId } = req.params;
        await requirePermission(req, 'area.update', { eventId, target: { areaId } });
        const body = updateSchema.parse(req.body);
        const area = await prisma.area.findFirst({ where: { id: areaId, eventId } });
        if (!area)
            throw errors.notFound('Area not found');
        if (body.name) {
            const existing = await prisma.area.findFirst({ where: { eventId, name: body.name, NOT: { id: areaId } } });
            if (existing)
                throw errors.conflict('An area with this name already exists');
        }
        const updated = await prisma.area.update({ where: { id: areaId }, data: body });
        await writeAudit({ eventId, actorUserId: req.user.id, action: 'area.updated', resourceType: 'area', resourceId: areaId, newValue: body, sourceIp: req.ip });
        return { data: updated };
    });
    app.delete('/:areaId', async (req, reply) => {
        const { eventId, areaId } = req.params;
        await requirePermission(req, 'area.delete', { eventId, target: { areaId } });
        const area = await prisma.area.findFirst({ where: { id: areaId, eventId } });
        if (!area)
            throw errors.notFound('Area not found');
        await prisma.area.delete({ where: { id: areaId } });
        await writeAudit({ eventId, actorUserId: req.user.id, action: 'area.deleted', resourceType: 'area', resourceId: areaId, sourceIp: req.ip });
        return reply.status(204).send();
    });
}
//# sourceMappingURL=routes.js.map