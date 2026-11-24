import { prisma } from './db.js';
/** Audit records are immutable by design — no update/delete API exists. */
export async function writeAudit(input) {
    try {
        await prisma.auditLog.create({
            data: {
                organizationId: input.organizationId ?? null,
                eventId: input.eventId ?? null,
                actorUserId: input.actorUserId ?? null,
                action: input.action,
                resourceType: input.resourceType,
                resourceId: input.resourceId ?? null,
                previousValue: input.previousValue ?? undefined,
                newValue: input.newValue ?? undefined,
                sourceDevice: input.sourceDevice ?? null,
                sourceIp: input.sourceIp ?? null,
                result: input.result ?? 'SUCCESS',
                metadata: input.metadata ?? undefined,
            },
        });
    }
    catch (err) {
        console.error('[audit] failed to write audit record', err);
    }
}
//# sourceMappingURL=audit.js.map