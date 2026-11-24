import { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { credentialCode } from '../../lib/credentials.js';
import { writeAudit } from '../../lib/audit.js';
import { AuditActions } from '../../lib/audit-actions.js';
import { logActivity } from '../../lib/activity.js';
import { normalizeReservationEmail, normalizeReservationPhone } from '../reservations/service.js';
export const ACCESS_CODE_TYPES = ['VIP_GUEST', 'VIP_TICKET', 'INVITE', 'COMP'];
export const ACCESS_CODE_STATUSES = ['ACTIVE', 'REDEEMED', 'REVOKED', 'EXPIRED'];
export function normalizeAccessCode(value) {
    const raw = String(value ?? '').trim().toUpperCase();
    if (!raw)
        return '';
    if (/^\d{3}$/.test(raw))
        return `TKT-VIP-${raw}`;
    return raw.replace(/\s+/g, '');
}
export function isAccessCodeExpired(code) {
    if (String(code.status ?? '').toUpperCase() === 'EXPIRED')
        return true;
    if (!code.expiresAt)
        return false;
    return code.expiresAt.getTime() <= Date.now();
}
export function canRedeemAccessCode(code) {
    const status = String(code.status ?? '').toUpperCase();
    if (status === 'REVOKED')
        return { ok: false, reason: 'REVOKED' };
    if (isAccessCodeExpired(code))
        return { ok: false, reason: 'EXPIRED' };
    const max = Math.max(1, Number(code.maxRedemptions ?? 1));
    const used = Math.max(0, Number(code.redemptionCount ?? 0));
    if (status === 'REDEEMED' || used >= max)
        return { ok: false, reason: 'REDEEMED' };
    if (status !== 'ACTIVE')
        return { ok: false, reason: 'INVALID' };
    return { ok: true };
}
export async function issueCredentialForTicket(tx, params) {
    const validFrom = params.eventStartAt;
    const validUntil = params.eventEndAt ?? null;
    const payload = {
        v: 1,
        credId: '',
        attendeeId: params.attendeeId,
        eventId: params.eventId,
        ticketType: params.ticketTypeName,
        attendeeName: params.attendeeName,
        validFrom: validFrom.getTime(),
        validUntil: validUntil ? validUntil.getTime() : null,
        singleUse: true,
        allowReentry: false,
    };
    const credential = await tx.credential.create({
        data: {
            eventId: params.eventId,
            attendeeId: params.attendeeId,
            ticketId: params.ticketId,
            type: 'QR',
            code: `PENDING-${randomUUID()}`,
            status: 'ACTIVE',
            validFrom,
            validUntil,
            singleUse: true,
            allowReentry: false,
            areaIds: [],
            issuedById: params.issuedById ?? null,
        },
    });
    payload.credId = credential.id;
    const code = credentialCode.encode(payload);
    return tx.credential.update({ where: { id: credential.id }, data: { code } });
}
export async function redeemAccessCode(params) {
    const codeNorm = normalizeAccessCode(params.codeRaw);
    if (!codeNorm)
        throw errors.badRequest('Access code is required');
    return prisma.$transaction(async (tx) => {
        const accessCode = await tx.accessCode.findFirst({
            where: { eventId: params.eventId, code: codeNorm },
            include: { ticketType: true, event: { select: { id: true, orgId: true, name: true, startAt: true, endAt: true } } },
        });
        if (!accessCode)
            throw errors.notFound('Access code not found');
        const redeemable = canRedeemAccessCode(accessCode);
        if (!redeemable.ok) {
            if (redeemable.reason === 'EXPIRED')
                throw errors.conflict('Access code expired');
            if (redeemable.reason === 'REVOKED')
                throw errors.conflict('Access code revoked');
            if (redeemable.reason === 'REDEEMED')
                throw errors.conflict('Access code already redeemed');
            throw errors.conflict('Access code is not redeemable');
        }
        const email = normalizeReservationEmail(params.email);
        const phone = normalizeReservationPhone(params.phone);
        const fullName = params.fullName.trim();
        if (!fullName)
            throw errors.badRequest('Name is required');
        // Match intended recipient when code has identity bound
        const boundEmail = normalizeReservationEmail(accessCode.email);
        const boundPhone = normalizeReservationPhone(accessCode.phone);
        if (boundEmail && email !== boundEmail)
            throw errors.forbidden('Access code identity mismatch');
        if (boundPhone && phone !== boundPhone)
            throw errors.forbidden('Access code identity mismatch');
        let attendee = null;
        if (email)
            attendee = await tx.attendee.findFirst({ where: { eventId: params.eventId, email } });
        if (!attendee && phone)
            attendee = await tx.attendee.findFirst({ where: { eventId: params.eventId, phone } });
        if (!attendee) {
            attendee = await tx.attendee.create({
                data: {
                    eventId: params.eventId,
                    name: fullName,
                    email: email || null,
                    phone: phone || null,
                    category: accessCode.attendeeCategory ?? (accessCode.type === 'VIP_GUEST' ? 'VIP' : 'GUEST'),
                    status: 'REGISTERED',
                    metadata: { source: 'access_code', accessCodeId: accessCode.id, accessCode: accessCode.code },
                },
            });
        }
        else {
            attendee = await tx.attendee.update({
                where: { id: attendee.id },
                data: {
                    name: fullName || attendee.name,
                    email: email || attendee.email,
                    phone: phone || attendee.phone,
                    category: attendee.category ?? accessCode.attendeeCategory ?? 'GUEST',
                    metadata: { ...(attendee.metadata ?? {}), accessCodeId: accessCode.id, accessCode: accessCode.code },
                },
            });
        }
        let ticketType = accessCode.ticketType;
        if (!ticketType) {
            ticketType = await tx.ticketType.findFirst({ where: { eventId: params.eventId, active: true }, orderBy: { createdAt: 'asc' } });
        }
        if (!ticketType)
            throw errors.conflict('No active ticket type available for redemption');
        let ticket = await tx.ticket.findFirst({
            where: { eventId: params.eventId, attendeeId: attendee.id, ticketTypeId: ticketType.id, status: { not: 'CANCELLED' } },
            orderBy: { issuedAt: 'desc' },
            include: { credential: true },
        });
        if (!ticket) {
            ticket = await tx.ticket.create({
                data: {
                    eventId: params.eventId,
                    attendeeId: attendee.id,
                    ticketTypeId: ticketType.id,
                    price: ticketType.price ?? 0,
                    status: 'ACTIVE',
                    issuedById: params.actorUserId ?? null,
                    reservationCode: `AC-${accessCode.code}-${randomUUID().slice(0, 6).toUpperCase()}`,
                    reservationEmail: email || null,
                    reservationPhone: phone || null,
                    reservationName: fullName,
                    approvalStatus: 'APPROVED',
                    paymentStatus: 'NOT_REQUIRED',
                    deliveryChannel: 'EMAIL',
                    deliveryStatus: 'PENDING',
                    approvedAt: new Date(),
                    approvedById: params.actorUserId ?? null,
                    metadata: { source: 'access_code', accessCodeId: accessCode.id, accessCode: accessCode.code },
                },
                include: { credential: true },
            });
        }
        let credential = ticket.credential;
        if (!credential) {
            credential = await issueCredentialForTicket(tx, {
                eventId: params.eventId,
                attendeeId: attendee.id,
                attendeeName: attendee.name,
                ticketId: ticket.id,
                ticketTypeName: ticketType.name,
                eventStartAt: accessCode.event.startAt,
                eventEndAt: accessCode.event.endAt,
                issuedById: params.actorUserId ?? null,
            });
        }
        const nextCount = (accessCode.redemptionCount ?? 0) + 1;
        const max = Math.max(1, accessCode.maxRedemptions ?? 1);
        const fullyRedeemed = nextCount >= max;
        const updatedCode = await tx.accessCode.update({
            where: { id: accessCode.id },
            data: {
                redemptionCount: nextCount,
                status: fullyRedeemed ? 'REDEEMED' : 'ACTIVE',
                redeemedAt: accessCode.redeemedAt ?? new Date(),
                lastRedeemedAt: new Date(),
                redeemedByAttendeeId: attendee.id,
                redeemedTicketId: ticket.id,
            },
        });
        await writeAudit({
            organizationId: accessCode.event.orgId,
            eventId: params.eventId,
            actorUserId: params.actorUserId ?? null,
            action: AuditActions.ACCESS_CODE_REDEEMED,
            resourceType: 'access_code',
            resourceId: accessCode.id,
            newValue: { code: accessCode.code, attendeeId: attendee.id, ticketId: ticket.id, credentialId: credential.id, redemptionCount: nextCount },
            sourceIp: params.sourceIp ?? null,
        });
        logActivity(params.eventId, 'attendee', `Access code redeemed ? ${accessCode.code}`, fullName);
        return { accessCode: updatedCode, attendee, ticket, credential };
    });
}
//# sourceMappingURL=service.js.map