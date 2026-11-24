import { z } from 'zod';
import { prisma } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/authorize.js';
import { writeAudit } from '../../lib/audit.js';
import { AuditActions } from '../../lib/audit-actions.js';
import { ACCESS_CODE_STATUSES, ACCESS_CODE_TYPES, normalizeAccessCode } from './service.js';
const createSchema = z.object({
    code: z.string().trim().min(3).max(64),
    type: z.enum(ACCESS_CODE_TYPES).default('VIP_GUEST'),
    fullName: z.string().trim().min(2).max(120).optional(),
    email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
    phone: z.string().trim().max(40).optional(),
    attendeeCategory: z.string().trim().max(40).optional(),
    ticketTypeId: z.string().optional(),
    notes: z.string().trim().max(500).optional(),
    maxRedemptions: z.coerce.number().int().min(1).max(100).default(1),
    expiresAt: z.coerce.date().optional().nullable(),
});
const updateSchema = createSchema.partial().extend({
    status: z.enum(ACCESS_CODE_STATUSES).optional(),
});
export async function accessCodeRoutes(app) {
    app.addHook('preHandler', authenticate);
    app.get('/', async (req) => {
        const { eventId } = req.params;
        await requirePermission(req, 'access_code.view', { eventId });
        const q = String(req.query?.q ?? '').trim();
        const status = String(req.query?.status ?? '').trim().toUpperCase();
        const where = { eventId };
        if (status && ACCESS_CODE_STATUSES.includes(status))
            where.status = status;
        if (q) {
            where.OR = [
                { code: { contains: q, mode: 'insensitive' } },
                { fullName: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
                { phone: { contains: q } },
            ];
        }
        const rows = await prisma.accessCode.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                ticketType: { select: { id: true, name: true } },
                redeemedByAttendee: { select: { id: true, name: true, email: true } },
                redeemedTicket: { select: { id: true, reservationCode: true } },
            },
        });
        return { data: rows };
    });
    app.post('/', async (req, reply) => {
        const { eventId } = req.params;
        await requirePermission(req, 'access_code.create', { eventId });
        const body = createSchema.parse(req.body);
        const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } });
        if (!event)
            throw errors.notFound('Event not found');
        const code = normalizeAccessCode(body.code);
        if (!code)
            throw errors.badRequest('Invalid access code');
        const existing = await prisma.accessCode.findUnique({ where: { code } });
        if (existing)
            throw errors.conflict('Access code already exists');
        if (body.ticketTypeId) {
            const tt = await prisma.ticketType.findFirst({ where: { id: body.ticketTypeId, eventId } });
            if (!tt)
                throw errors.badRequest('Ticket type not found in this event');
        }
        const row = await prisma.accessCode.create({
            data: {
                eventId,
                code,
                type: body.type,
                fullName: body.fullName ?? null,
                email: body.email?.toLowerCase() ?? null,
                phone: body.phone ?? null,
                attendeeCategory: body.attendeeCategory ?? null,
                ticketTypeId: body.ticketTypeId ?? null,
                notes: body.notes ?? null,
                maxRedemptions: body.maxRedemptions,
                expiresAt: body.expiresAt ?? null,
                issuedById: req.user.id,
            },
        });
        await writeAudit({ organizationId: event.orgId, eventId, actorUserId: req.user.id, action: AuditActions.ACCESS_CODE_CREATED, resourceType: 'access_code', resourceId: row.id, newValue: { code: row.code, type: row.type }, sourceIp: req.ip });
        return reply.status(201).send({ data: row });
    });
    app.patch('/:accessCodeId', async (req) => {
        const { eventId, accessCodeId } = req.params;
        await requirePermission(req, 'access_code.update', { eventId });
        const body = updateSchema.parse(req.body);
        const existing = await prisma.accessCode.findFirst({ where: { id: accessCodeId, eventId } });
        if (!existing)
            throw errors.notFound('Access code not found');
        if (body.code) {
            const code = normalizeAccessCode(body.code);
            if (code !== existing.code) {
                const dup = await prisma.accessCode.findUnique({ where: { code } });
                if (dup)
                    throw errors.conflict('Access code already exists');
            }
            body.code = code;
        }
        if (body.ticketTypeId) {
            const tt = await prisma.ticketType.findFirst({ where: { id: body.ticketTypeId, eventId } });
            if (!tt)
                throw errors.badRequest('Ticket type not found in this event');
        }
        const updated = await prisma.accessCode.update({
            where: { id: existing.id },
            data: {
                ...body,
                email: body.email === '' ? null : body.email?.toLowerCase(),
                expiresAt: body.expiresAt === undefined ? undefined : body.expiresAt,
            },
        });
        await writeAudit({ eventId, actorUserId: req.user.id, action: AuditActions.ACCESS_CODE_UPDATED, resourceType: 'access_code', resourceId: existing.id, previousValue: { status: existing.status, code: existing.code }, newValue: body, sourceIp: req.ip });
        return { data: updated };
    });
    app.post('/:accessCodeId/revoke', async (req) => {
        const { eventId, accessCodeId } = req.params;
        await requirePermission(req, 'access_code.revoke', { eventId });
        const existing = await prisma.accessCode.findFirst({ where: { id: accessCodeId, eventId } });
        if (!existing)
            throw errors.notFound('Access code not found');
        const updated = await prisma.accessCode.update({ where: { id: existing.id }, data: { status: 'REVOKED' } });
        await writeAudit({ eventId, actorUserId: req.user.id, action: AuditActions.ACCESS_CODE_REVOKED, resourceType: 'access_code', resourceId: existing.id, previousValue: { status: existing.status }, newValue: { status: 'REVOKED' }, sourceIp: req.ip });
        return { data: updated };
    });
    app.delete('/:accessCodeId', async (req) => {
        const { eventId, accessCodeId } = req.params;
        await requirePermission(req, 'access_code.revoke', { eventId });
        const existing = await prisma.accessCode.findFirst({ where: { id: accessCodeId, eventId } });
        if (!existing)
            throw errors.notFound('Access code not found');
        if (existing.redemptionCount > 0)
            throw errors.conflict('Cannot delete a redeemed access code; revoke it instead');
        await prisma.accessCode.delete({ where: { id: existing.id } });
        await writeAudit({ eventId, actorUserId: req.user.id, action: AuditActions.ACCESS_CODE_DELETED, resourceType: 'access_code', resourceId: existing.id, previousValue: { code: existing.code }, sourceIp: req.ip });
        return { data: { ok: true } };
    });
}
//# sourceMappingURL=routes.js.map