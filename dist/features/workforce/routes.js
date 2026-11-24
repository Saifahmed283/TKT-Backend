import { z } from 'zod';
import crypto from 'node:crypto';
import { prisma } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/authorize.js';
import { writeAudit } from '../../lib/audit.js';
import { AuditActions } from '../../lib/audit-actions.js';
import { hashPassword } from '../../lib/auth.js';
import { sendMail, ticketEmailShell } from '../../lib/mailer.js';
import { resolveLegacyRoleCode } from '../../lib/roleAliases.js';
import { EVENT_LEVEL_SCOPES } from '../../lib/rbac.js';
import { config } from '../../config.js';
const applicationSchema = z.object({
    fullName: z.string().min(2),
    email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
    phone: z.string().optional(),
    nationalId: z.string().optional(),
    requestedRoleCode: z.string().optional(),
    requestedTeamId: z.string().optional(),
    requestedAreaIds: z.array(z.string()).optional(),
    source: z.string().optional(),
    notes: z.string().optional(),
    status: z.enum(['PENDING', 'REVIEWING', 'APPROVED', 'REJECTED', 'CONVERTED', 'WITHDRAWN']).optional(),
});
const profileSchema = z.object({
    userId: z.string().min(1),
    nationalId: z.string().optional(),
    workerCode: z.string().optional(),
    title: z.string().optional(),
    department: z.string().optional(),
    phoneSecondary: z.string().optional(),
    emergencyContact: z.string().optional(),
    notes: z.string().optional(),
    onboardingComplete: z.boolean().optional(),
});
const convertSchema = z.object({
    userId: z.string().optional(),
    createUserIfMissing: z.boolean().optional().default(true),
    roleId: z.string().optional(),
    teamId: z.string().optional().nullable(),
    areaIds: z.array(z.string()).optional(),
});
function workerCode() {
    return `TKT-W-${crypto.randomInt(100000, 999999)}`;
}
export async function workforceRoutes(app) {
    app.addHook('preHandler', authenticate);
    app.get('/applications', async (req) => {
        const { eventId } = req.params;
        await requirePermission(req, 'workforce.view', { eventId });
        const rows = await prisma.workforceApplication.findMany({
            where: { eventId },
            orderBy: { createdAt: 'desc' },
        });
        return { data: rows };
    });
    app.post('/applications', async (req, reply) => {
        const { eventId } = req.params;
        await requirePermission(req, 'workforce.manage', { eventId });
        const body = applicationSchema.parse(req.body);
        const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, orgId: true } });
        if (!event)
            throw errors.notFound('Event not found');
        const appRow = await prisma.workforceApplication.create({
            data: {
                eventId,
                fullName: body.fullName.trim(),
                email: body.email?.toLowerCase().trim() || null,
                phone: body.phone?.trim() || null,
                nationalId: body.nationalId?.trim() || null,
                requestedRoleCode: body.requestedRoleCode?.trim() || null,
                requestedTeamId: body.requestedTeamId || null,
                requestedAreaIds: body.requestedAreaIds ?? undefined,
                source: body.source?.trim() || 'manual',
                status: body.status ?? 'PENDING',
                notes: body.notes?.trim() || null,
                submittedById: req.user.id,
            },
        });
        await writeAudit({
            organizationId: event.orgId, eventId, actorUserId: req.user.id,
            action: AuditActions.WORKFORCE_APPLICATION_CREATED, resourceType: 'workforce_application', resourceId: appRow.id,
            newValue: body, sourceIp: req.ip,
        });
        return reply.status(201).send({ data: appRow });
    });
    app.patch('/applications/:applicationId', async (req) => {
        const { eventId, applicationId } = req.params;
        await requirePermission(req, 'workforce.manage', { eventId });
        const body = applicationSchema.partial().extend({ reviewNotes: z.string().optional() }).parse(req.body);
        const existing = await prisma.workforceApplication.findFirst({ where: { id: applicationId, eventId } });
        if (!existing)
            throw errors.notFound('Application not found');
        const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } });
        const updated = await prisma.workforceApplication.update({
            where: { id: applicationId },
            data: {
                ...(body.fullName !== undefined ? { fullName: body.fullName.trim() } : {}),
                ...(body.email !== undefined ? { email: body.email?.toLowerCase().trim() || null } : {}),
                ...(body.phone !== undefined ? { phone: body.phone?.trim() || null } : {}),
                ...(body.nationalId !== undefined ? { nationalId: body.nationalId?.trim() || null } : {}),
                ...(body.requestedRoleCode !== undefined ? { requestedRoleCode: body.requestedRoleCode?.trim() || null } : {}),
                ...(body.requestedTeamId !== undefined ? { requestedTeamId: body.requestedTeamId || null } : {}),
                ...(body.requestedAreaIds !== undefined ? { requestedAreaIds: body.requestedAreaIds } : {}),
                ...(body.source !== undefined ? { source: body.source?.trim() || null } : {}),
                ...(body.status !== undefined ? { status: body.status } : {}),
                ...(body.notes !== undefined ? { notes: body.notes?.trim() || null } : {}),
                ...(body.reviewNotes !== undefined ? { reviewNotes: body.reviewNotes?.trim() || null } : {}),
                reviewedById: req.user.id,
            },
        });
        await writeAudit({
            organizationId: event?.orgId, eventId, actorUserId: req.user.id,
            action: AuditActions.WORKFORCE_APPLICATION_UPDATED, resourceType: 'workforce_application', resourceId: applicationId,
            previousValue: existing, newValue: body, sourceIp: req.ip,
        });
        return { data: updated };
    });
    app.post('/applications/:applicationId/convert', async (req) => {
        const { eventId, applicationId } = req.params;
        await requirePermission(req, 'workforce.convert', { eventId });
        const body = convertSchema.parse(req.body);
        const appRow = await prisma.workforceApplication.findFirst({ where: { id: applicationId, eventId } });
        if (!appRow)
            throw errors.notFound('Application not found');
        const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, orgId: true, name: true } });
        if (!event)
            throw errors.notFound('Event not found');
        let userId = body.userId;
        let tempPassword = null;
        let createdUserEmail = null;
        if (!userId) {
            if (!appRow.email)
                throw errors.badRequest('Application email or userId required for conversion');
            const email = appRow.email.toLowerCase();
            const existingUser = await prisma.user.findUnique({ where: { email } });
            if (existingUser) {
                userId = existingUser.id;
            }
            else if (body.createUserIfMissing) {
                tempPassword = crypto.randomBytes(9).toString('base64url').slice(0, 12) + 'A1!';
                const passwordHash = await hashPassword(tempPassword);
                const user = await prisma.user.create({
                    data: { email, name: appRow.fullName, phone: appRow.phone ?? null, passwordHash, status: 'ACTIVE' },
                    select: { id: true, email: true, name: true },
                });
                userId = user.id;
                createdUserEmail = user.email;
            }
            else {
                throw errors.badRequest('User account not found');
            }
        }
        // Legacy SAC role codes are translated to existing TKT roles. Unknown
        // values resolve to null and therefore cannot grant any access.
        const requestedRoleCode = resolveLegacyRoleCode(appRow.requestedRoleCode);
        const role = body.roleId
            ? await prisma.role.findUnique({ where: { id: body.roleId } })
            : requestedRoleCode
                ? await prisma.role.findFirst({ where: { code: requestedRoleCode } })
                : null;
        if (!role || (role.orgId && role.orgId !== event.orgId)) {
            throw errors.badRequest('Role not found for conversion');
        }
        if (!EVENT_LEVEL_SCOPES.has(role.scope)) {
            throw errors.badRequest('Only event-level roles can be assigned at event level');
        }
        const teamId = body.teamId !== undefined ? body.teamId : appRow.requestedTeamId;
        const areaIds = body.areaIds ?? (Array.isArray(appRow.requestedAreaIds) ? appRow.requestedAreaIds : []);
        const uniqueAreaIds = [...new Set(areaIds)];
        if (teamId) {
            const team = await prisma.team.findFirst({ where: { id: teamId, eventId }, select: { id: true } });
            if (!team)
                throw errors.badRequest('Team not found in this event');
        }
        if (uniqueAreaIds.length) {
            const count = await prisma.area.count({ where: { id: { in: uniqueAreaIds }, eventId } });
            if (count !== uniqueAreaIds.length)
                throw errors.badRequest('One or more areas not found in this event');
        }
        const result = await prisma.$transaction(async (tx) => {
            await tx.organizationMember.upsert({
                where: { orgId_userId: { orgId: event.orgId, userId } },
                update: {},
                create: { orgId: event.orgId, userId, role: 'VIEWER' },
            });
            const member = await tx.eventMember.upsert({
                where: { eventId_userId: { eventId, userId } },
                update: { roleId: role.id, teamId: teamId ?? null, status: 'ACTIVE' },
                create: { eventId, userId, roleId: role.id, teamId: teamId ?? null, invitedBy: req.user.id, status: 'ACTIVE' },
            });
            await tx.memberArea.deleteMany({ where: { eventMemberId: member.id } });
            if (uniqueAreaIds.length) {
                await tx.memberArea.createMany({ data: uniqueAreaIds.map((areaId) => ({ eventMemberId: member.id, areaId })) });
            }
            await tx.staffProfile.upsert({
                where: { userId },
                update: { eventId, nationalId: appRow.nationalId ?? undefined, onboardingComplete: false },
                create: { userId, eventId, nationalId: appRow.nationalId ?? null, workerCode: workerCode(), onboardingComplete: false },
            });
            const updatedApp = await tx.workforceApplication.update({
                where: { id: applicationId },
                data: { status: 'CONVERTED', reviewedById: req.user.id, convertedUserId: userId, convertedAt: new Date() },
            });
            return { member, updatedApp };
        });
        await writeAudit({
            organizationId: event.orgId, eventId, actorUserId: req.user.id,
            action: AuditActions.WORKFORCE_APPLICATION_CONVERTED, resourceType: 'workforce_application', resourceId: applicationId,
            newValue: { userId, roleId: role.id, teamId, areaIds }, sourceIp: req.ip,
        });
        let onboardingEmailOk = false;
        let onboardingEmailError = null;
        if (tempPassword && createdUserEmail) {
            const loginUrl = `${process.env.PUBLIC_URL ?? 'http://localhost:5173'}/login`;
            const sent = await sendMail({
                to: createdUserEmail,
                subject: `Your TKT staff account — ${event.name}`,
                html: ticketEmailShell({
                    preheader: `Staff account created for ${event.name}`,
                    title: 'Welcome to the team',
                    body: `Your staff account for <strong>${event.name}</strong> is ready. Sign in with the temporary password below and change it after first login.`,
                    rows: [
                        { label: 'Email', value: createdUserEmail },
                        { label: 'Temporary password', value: tempPassword },
                        { label: 'Login', value: loginUrl },
                        { label: 'Role', value: role.name },
                    ],
                    footer: 'TKT · Do not share this password. Change it after signing in.',
                }),
            });
            onboardingEmailOk = sent.ok;
            onboardingEmailError = sent.error ?? null;
            await writeAudit({
                organizationId: event.orgId, eventId, actorUserId: req.user.id,
                action: sent.ok ? 'workforce.onboarding_email.sent' : 'workforce.onboarding_email.failed',
                resourceType: 'user', resourceId: userId,
                newValue: { email: createdUserEmail, error: onboardingEmailError }, sourceIp: req.ip,
            });
        }
        return { data: { ...result, onboardingEmailOk, onboardingEmailError, accountCreated: Boolean(tempPassword) } };
    });
    app.get('/profiles', async (req) => {
        const { eventId } = req.params;
        await requirePermission(req, 'workforce.view', { eventId });
        const profiles = await prisma.staffProfile.findMany({
            where: { OR: [{ eventId }, { user: { eventMemberships: { some: { eventId } } } }] },
            include: { user: { select: { id: true, name: true, email: true, phone: true } } },
            orderBy: { updatedAt: 'desc' },
        });
        return { data: profiles };
    });
    app.post('/profiles', async (req) => {
        const { eventId } = req.params;
        await requirePermission(req, 'workforce.manage', { eventId });
        const body = profileSchema.parse(req.body);
        const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } });
        if (!event)
            throw errors.notFound('Event not found');
        const profile = await prisma.staffProfile.upsert({
            where: { userId: body.userId },
            update: {
                eventId,
                nationalId: body.nationalId?.trim() || null,
                workerCode: body.workerCode?.trim() || undefined,
                title: body.title?.trim() || null,
                department: body.department?.trim() || null,
                phoneSecondary: body.phoneSecondary?.trim() || null,
                emergencyContact: body.emergencyContact?.trim() || null,
                notes: body.notes?.trim() || null,
                onboardingComplete: body.onboardingComplete ?? undefined,
            },
            create: {
                userId: body.userId,
                eventId,
                nationalId: body.nationalId?.trim() || null,
                workerCode: body.workerCode?.trim() || workerCode(),
                title: body.title?.trim() || null,
                department: body.department?.trim() || null,
                phoneSecondary: body.phoneSecondary?.trim() || null,
                emergencyContact: body.emergencyContact?.trim() || null,
                notes: body.notes?.trim() || null,
                onboardingComplete: body.onboardingComplete ?? false,
            },
            include: { user: { select: { id: true, name: true, email: true } } },
        });
        await writeAudit({
            organizationId: event.orgId, eventId, actorUserId: req.user.id,
            action: AuditActions.WORKFORCE_PROFILE_UPSERTED, resourceType: 'staff_profile', resourceId: profile.id,
            newValue: body, sourceIp: req.ip,
        });
        return { data: profile };
    });
    app.post('/id-token', async (req) => {
        const { eventId } = req.params;
        await requirePermission(req, 'workforce.id.issue', { eventId });
        const body = z.object({ userId: z.string(), ttlSeconds: z.number().int().min(60).max(86400).optional() }).parse(req.body);
        const member = await prisma.eventMember.findUnique({ where: { eventId_userId: { eventId, userId: body.userId } }, include: { user: { select: { id: true, name: true, email: true } }, role: true } });
        if (!member)
            throw errors.notFound('Staff member not found in event');
        const ttl = body.ttlSeconds ?? 3600;
        const exp = Math.floor(Date.now() / 1000) + ttl;
        const payload = { sub: member.user.id, eventId, role: member.role.code, type: 'staff_id', exp };
        const secret = config.jwt.staffSecret;
        const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
        const token = `${encoded}.${sig}`;
        await prisma.staffProfile.upsert({
            where: { userId: body.userId },
            update: { idCardIssuedAt: new Date(), eventId },
            create: { userId: body.userId, eventId, workerCode: workerCode(), idCardIssuedAt: new Date() },
        });
        const event = await prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } });
        await writeAudit({
            organizationId: event?.orgId, eventId, actorUserId: req.user.id,
            action: AuditActions.WORKFORCE_ID_ISSUED, resourceType: 'staff_profile', resourceId: body.userId,
            newValue: { userId: body.userId, expiresAt: new Date(exp * 1000).toISOString() }, sourceIp: req.ip,
        });
        return { data: { token, expiresAt: new Date(exp * 1000).toISOString(), payload } };
    });
    app.delete('/applications/:id', async (req, reply) => {
        const { eventId, id } = req.params;
        await requirePermission(req, 'workforce.manage', { eventId });
        const existing = await prisma.workforceApplication.findFirst({ where: { id, eventId } });
        if (!existing)
            throw errors.notFound('Application not found');
        await prisma.workforceApplication.delete({ where: { id } });
        await writeAudit({ eventId, actorUserId: req.user.id, action: 'workforce.application.deleted', resourceType: 'workforce_application', resourceId: id, previousValue: { fullName: existing.fullName, status: existing.status }, sourceIp: req.ip });
        return reply.status(204).send();
    });
    app.delete('/profiles/:profileId', async (req, reply) => {
        const { eventId, profileId } = req.params;
        await requirePermission(req, 'workforce.manage', { eventId });
        const existing = await prisma.staffProfile.findFirst({ where: { id: profileId, OR: [{ eventId }, { eventId: null }] } });
        if (!existing)
            throw errors.notFound('Profile not found');
        await prisma.staffProfile.delete({ where: { id: profileId } });
        await writeAudit({ eventId, actorUserId: req.user.id, action: 'workforce.profile.deleted', resourceType: 'staff_profile', resourceId: profileId, previousValue: { userId: existing.userId }, sourceIp: req.ip });
        return reply.status(204).send();
    });
}
//# sourceMappingURL=routes.js.map