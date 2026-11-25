import { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { credentialCode, generateUniqueShortCode } from '../../lib/credentials.js';
import { getDeliveryAdapter, ticketEmailShell } from '../../lib/delivery.js';
import { qrDataUrl } from '../../lib/qr.js';
import { writeAudit } from '../../lib/audit.js';
import { AuditActions } from '../../lib/audit-actions.js';
import { dispatchEventWebhooks } from '../integrations/dispatch.js';
import { logActivity } from '../../lib/activity.js';
import { purgeReservationTx } from './purge.js';
export function normalizeReservationEmail(email) {
    const v = String(email ?? '').trim().toLowerCase();
    return v || null;
}
export function normalizeReservationPhone(phone) {
    const v = String(phone ?? '').replace(/[^0-9]+/g, '');
    return v || null;
}
export function reservationCodeOf(ticket) {
    if (typeof ticket.reservationCode === 'string' && ticket.reservationCode.trim())
        return ticket.reservationCode;
    const meta = ticket.metadata ?? {};
    return typeof meta.reservationCode === 'string' && meta.reservationCode.trim() ? meta.reservationCode : null;
}
export function reservationApprovalOf(ticket) {
    const explicit = String(ticket.approvalStatus ?? '').toUpperCase();
    if (explicit === 'PENDING' || explicit === 'APPROVED' || explicit === 'REJECTED' || explicit === 'NONE') {
        return explicit;
    }
    const meta = ticket.metadata ?? {};
    if (meta.channel !== 'public')
        return 'APPROVED';
    const legacy = String(meta.approval ?? '').toUpperCase();
    if (legacy === 'PENDING' || legacy === 'APPROVED' || legacy === 'REJECTED')
        return legacy;
    return Number(meta.price ?? ticket.price ?? 0) > 0 ? 'PENDING' : 'APPROVED';
}
export function reservationPaymentOf(ticket) {
    const explicit = String(ticket.paymentStatus ?? '').toUpperCase();
    if (explicit === 'NOT_REQUIRED' || explicit === 'PENDING' || explicit === 'CONFIRMED' || explicit === 'FAILED' || explicit === 'REFUNDED') {
        return explicit;
    }
    const meta = ticket.metadata ?? {};
    const paid = Number(meta.price ?? ticket.price ?? 0) > 0;
    if (!paid)
        return 'NOT_REQUIRED';
    const approval = reservationApprovalOf(ticket);
    if (approval === 'APPROVED')
        return 'CONFIRMED';
    if (approval === 'REJECTED')
        return 'FAILED';
    return 'PENDING';
}
export function isPaidTicket(ticket) {
    const ticketPrice = Number(ticket.price);
    const typePrice = Number(ticket.ticketType?.price ?? 0);
    const price = Number.isFinite(ticketPrice) && ticketPrice > 0 ? ticketPrice : typePrice;
    return Number.isFinite(price) && price > 0;
}
export function canIssueReservationCredential(ticket) {
    if (String(ticket.status ?? '').toUpperCase() === 'CANCELLED')
        return false;
    const approval = reservationApprovalOf(ticket);
    if (approval !== 'APPROVED')
        return false;
    const payment = reservationPaymentOf(ticket);
    if (payment === 'PENDING' || payment === 'FAILED')
        return false;
    return true;
}
export function reservationStatePatch(params) {
    if (!params.paid) {
        return {
            approvalStatus: 'APPROVED',
            paymentStatus: 'NOT_REQUIRED',
        };
    }
    if (params.rejected) {
        return {
            approvalStatus: 'REJECTED',
            paymentStatus: 'FAILED',
        };
    }
    if (params.approved) {
        return {
            approvalStatus: 'APPROVED',
            paymentStatus: 'CONFIRMED',
        };
    }
    return {
        approvalStatus: 'PENDING',
        paymentStatus: 'PENDING',
    };
}
async function recordDeliveryAttempt(input) {
    return prisma.credentialDeliveryAttempt.create({ data: input }).catch(() => null);
}
export async function resendReservationCredential(params) {
    const ticket = await prisma.ticket.findFirst({
        where: { id: params.ticketId, eventId: params.eventId },
        include: {
            attendee: { select: { id: true, name: true, email: true, phone: true } },
            ticketType: { select: { id: true, name: true, price: true } },
            credential: true,
            event: { select: { id: true, orgId: true, name: true, startAt: true, endAt: true, venueName: true, settings: true } },
        },
    });
    if (!ticket)
        throw errors.notFound('Reservation not found');
    if (!canIssueReservationCredential(ticket)) {
        throw errors.conflict('Reservation is not eligible for credential delivery');
    }
    if (!ticket.credential) {
        throw errors.conflict('Credential has not been issued for this reservation');
    }
    const to = (params.toEmail ?? ticket.attendee.email ?? '').trim();
    if (!to)
        throw errors.badRequest('Recipient email is missing');
    const settings = (ticket.event.settings ?? {});
    const tpl = (settings.ticketEmail ?? {});
    const qr = await qrDataUrl(ticket.credential.code).catch(() => null);
    const codeOf = reservationCodeOf(ticket);
    const shortCode = ticket.credential.shortCode ?? null;
    const attempt = (ticket.deliveryAttempts ?? 0) + 1;
    const delivery = await getDeliveryAdapter('EMAIL').send({
        to,
        subject: typeof tpl.subject === 'string' && tpl.subject ? tpl.subject.replace('{event}', ticket.event.name) : `Your ticket — ${ticket.event.name}`,
        html: ticketEmailShell({
            preheader: typeof tpl.preheader === 'string' && tpl.preheader ? tpl.preheader : `Ticket for ${ticket.event.name} — present your QR at check-in`,
            title: typeof tpl.title === 'string' && tpl.title ? tpl.title.replace('{event}', ticket.event.name) : `Your ticket for ${ticket.event.name}`,
            body: typeof tpl.body === 'string' && tpl.body ? tpl.body.replace('{event}', `<strong>${ticket.event.name}</strong>`) : `Here is your signed QR ticket for <strong>${ticket.event.name}</strong>. Present it at check-in.`,
            rows: [
                { label: 'Event', value: ticket.event.name },
                { label: 'Ticket', value: ticket.ticketType.name },
                { label: 'Date', value: ticket.event.startAt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) },
                { label: 'Venue', value: ticket.event.venueName ?? 'TBA' },
                ...(codeOf ? [{ label: 'Reservation', value: codeOf }] : []),
                ...(shortCode ? [{ label: 'Ticket code', value: shortCode }] : []),
                ...await (async () => {
                    const seats = await prisma.busSeat.findMany({ where: { ticketId: ticket.id }, select: { label: true, passengerName: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } }).catch(() => []);
                    return seats.length ? [{ label: 'Seats', value: seats.map((s) => `${s.bus?.name ? s.bus.name + ' ' : ''}${s.label}${s.passengerName ? ` (${s.passengerName})` : ''}`).join(', ') }] : [];
                })(),
            ],
            qrDataUrl: qr,
            footer: typeof tpl.footer === 'string' && tpl.footer ? tpl.footer : 'TKT · Control center for live events',
        }),
    });
    const deliveryOk = delivery.ok;
    const updated = await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
            deliveryStatus: deliveryOk ? 'SENT' : 'FAILED',
            lastDeliveryAt: deliveryOk ? new Date() : undefined,
            deliveryAttempts: { increment: 1 },
            deliveryChannel: 'EMAIL',
        },
        include: { credential: { select: { id: true, code: true, status: true } } },
    });
    await recordDeliveryAttempt({
        eventId: ticket.eventId,
        ticketId: ticket.id,
        credentialId: ticket.credential.id,
        channel: 'EMAIL',
        status: deliveryOk ? 'SENT' : 'FAILED',
        recipient: to,
        provider: delivery.provider,
        providerMessageId: delivery.providerMessageId ?? null,
        error: delivery.error ?? null,
        attempt,
        metadata: { resend: true, toOverride: Boolean(params.toEmail) },
        createdById: params.actorUserId,
    });
    await writeAudit({
        organizationId: ticket.event.orgId,
        eventId: ticket.eventId,
        actorUserId: params.actorUserId,
        action: deliveryOk ? AuditActions.CREDENTIAL_DELIVERY_SENT : AuditActions.CREDENTIAL_DELIVERY_FAILED,
        resourceType: 'ticket',
        resourceId: ticket.id,
        newValue: { channel: 'EMAIL', credentialId: ticket.credential.id, resend: true },
    });
    logActivity(ticket.eventId, 'credential', `Credential ${deliveryOk ? 'resent' : 'resend failed'} · ${codeOf ?? ticket.id.slice(0, 8)}`, params.actorName);
    return { ticket: updated, credential: ticket.credential, deliveryOk };
}
/**
 * Email an already-minted credential and record the delivery attempt.
 * Split out of issueReservationCredential so the public reservation endpoint
 * can mint the QR synchronously and hand the SMTP round-trip to a
 * fire-and-forget task. TODO: replace that pattern with a durable queue.
 */
export async function deliverReservationCredentialEmail(params) {
    const { event, ticket, credential, issuerUserId = null } = params;
    const codeOf = reservationCodeOf(ticket);
    const shortCode = credential.shortCode ?? null;
    const qr = await qrDataUrl(credential.code).catch(() => null);
    const attempt = (ticket.deliveryAttempts ?? 0) + 1;
    const settings = (event.settings ?? {});
    const tpl = (settings.ticketEmail ?? {});
    const eventDate = event.startAt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const delivery = await getDeliveryAdapter('EMAIL').send({
        to: ticket.attendee.email ?? '',
        subject: typeof tpl.subject === 'string' && tpl.subject ? tpl.subject.replaceAll('{event}', event.name) : `Your ticket — ${event.name}`,
        html: ticketEmailShell({
            preheader: typeof tpl.preheader === 'string' && tpl.preheader ? tpl.preheader.replaceAll('{event}', event.name) : `Ticket for ${event.name} — present your QR at check-in`,
            title: typeof tpl.title === 'string' && tpl.title ? tpl.title.replaceAll('{event}', event.name) : `You're in, ${ticket.attendee.name.split(' ')[0]}`,
            body: typeof tpl.body === 'string' && tpl.body ? tpl.body.replaceAll('{event}', `<strong>${event.name}</strong>`) : `Your reservation for <strong>${event.name}</strong> is confirmed. Show this QR at the gate — it is signed, single-use and cannot be forged.`,
            rows: [
                { label: 'Event', value: event.name },
                { label: 'Ticket', value: ticket.ticketType.name },
                { label: 'Date', value: eventDate },
                { label: 'Venue', value: event.venueName ?? 'TBA' },
                ...(codeOf ? [{ label: 'Reservation', value: codeOf }] : []),
                ...(shortCode ? [{ label: 'Ticket code', value: shortCode }] : []),
                ...await (async () => {
                    const seats = await prisma.busSeat.findMany({ where: { ticketId: ticket.id }, select: { label: true, passengerName: true, bus: { select: { name: true } } }, orderBy: { label: 'asc' } }).catch(() => []);
                    return seats.length ? [{ label: 'Seats', value: seats.map((s) => `${s.bus?.name ? s.bus.name + ' ' : ''}${s.label}${s.passengerName ? ` (${s.passengerName})` : ''}`).join(', ') }] : [];
                })(),
            ],
            qrDataUrl: qr,
            footer: typeof tpl.footer === 'string' && tpl.footer ? tpl.footer : 'TKT · Control center for live events',
        }),
    });
    const deliveryOk = delivery.ok;
    await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
            deliveryStatus: deliveryOk ? 'SENT' : 'FAILED',
            lastDeliveryAt: deliveryOk ? new Date() : undefined,
            deliveryAttempts: { increment: 1 },
            deliveryChannel: 'EMAIL',
        },
    }).catch(() => { });
    await recordDeliveryAttempt({
        eventId: event.id,
        ticketId: ticket.id,
        credentialId: credential.id,
        channel: 'EMAIL',
        status: deliveryOk ? 'SENT' : 'FAILED',
        recipient: ticket.attendee.email ?? null,
        provider: delivery.provider,
        providerMessageId: delivery.providerMessageId ?? null,
        error: delivery.error ?? null,
        attempt,
        metadata: { source: 'reservation_issue' },
        createdById: issuerUserId,
    });
    await writeAudit({
        organizationId: event.orgId,
        eventId: event.id,
        actorUserId: issuerUserId,
        action: deliveryOk ? AuditActions.CREDENTIAL_DELIVERY_SENT : AuditActions.CREDENTIAL_DELIVERY_FAILED,
        resourceType: 'ticket',
        resourceId: ticket.id,
        newValue: { channel: 'EMAIL', credentialId: credential.id },
    });
    // Issuance audit + webhook live here too: the public reservation path calls
    // this helper after the HTTP response, so neither write blocks the attendee.
    await writeAudit({
        organizationId: event.orgId,
        eventId: event.id,
        actorUserId: issuerUserId,
        action: AuditActions.CREDENTIAL_ISSUED_RESERVATION,
        resourceType: 'credential',
        resourceId: credential.id,
        newValue: { attendeeId: ticket.attendee.id, ticketId: ticket.id, channel: 'public', deliveryOk },
    });
    void dispatchEventWebhooks(event.id, 'credential.issued', { ticketId: ticket.id, credentialId: credential.id, attendeeId: ticket.attendee.id, deliveryOk });
    return deliveryOk;
}
/**
 * Mint a signed TKT1 credential for a reservation ticket and email the
 * QR ticket to the attendee when sendEmail is true. Idempotent per ticket.
 */
export async function issueReservationCredential(params) {
    const { event, ticket, issuerUserId, sendEmail = true } = params;
    if (!canIssueReservationCredential(ticket)) {
        throw errors.conflict('Reservation is not eligible for credential issuance');
    }
    const existing = await prisma.credential.findUnique({ where: { ticketId: ticket.id } });
    if (existing)
        return { credential: existing, qrCode: existing.code };
    const shortCode = await generateUniqueShortCode();
    const payload = {
        v: 1,
        credId: '',
        shortCode,
        attendeeId: ticket.attendee.id,
        eventId: event.id,
        ticketType: ticket.ticketType.name,
        attendeeName: ticket.attendee.name,
        validFrom: event.startAt.getTime(),
        validUntil: event.endAt ? event.endAt.getTime() : null,
        singleUse: true,
        allowReentry: false,
    };
    const credential = await prisma.credential.create({
        data: {
            eventId: event.id,
            attendeeId: ticket.attendee.id,
            ticketId: ticket.id,
            type: 'QR',
            shortCode,
            code: `PENDING-${randomUUID()}`,
            status: 'ACTIVE',
            validFrom: event.startAt,
            validUntil: event.endAt,
            singleUse: true,
            allowReentry: false,
            areaIds: [],
            issuedById: issuerUserId,
        },
    });
    payload.credId = credential.id;
    const code = credentialCode.encode(payload);
    const final = await prisma.credential.update({ where: { id: credential.id }, data: { code } });
    if (sendEmail) {
        await deliverReservationCredentialEmail({
            event,
            ticket,
            credential: { id: credential.id, code, shortCode },
            issuerUserId: issuerUserId ?? null,
        });
    }
    return { credential: final, qrCode: code };
}
/** Approve or reject a pending public reservation ticket. */
export async function decideReservation(params) {
    const { eventId, ticketId, approved, actorUserId, reason } = params;
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event)
        throw errors.notFound('Event not found');
    const decided = await prisma.$transaction(async (tx) => {
        const current = await tx.ticket.findFirst({
            where: { id: ticketId, eventId },
            include: {
                attendee: { select: { id: true, name: true, email: true, phone: true } },
                ticketType: { select: { id: true, name: true, price: true } },
                credential: { select: { id: true, code: true, status: true } },
            },
        });
        if (!current)
            throw errors.notFound('Reservation not found');
        const approval = reservationApprovalOf(current);
        if (approval !== 'PENDING') {
            const same = (approved && approval === 'APPROVED') || (!approved && approval === 'REJECTED');
            if (same)
                return { ticket: current, credential: current.credential, alreadyDecided: true, purged: false };
            throw errors.conflict('Reservation is not awaiting approval');
        }
        const meta = current.metadata ?? {};
        const paid = isPaidTicket(current);
        const snapshot = {
            ...current,
            status: approved ? 'ACTIVE' : 'CANCELLED',
            approvalStatus: approved ? 'APPROVED' : 'REJECTED',
            paymentStatus: approved ? (paid ? 'CONFIRMED' : 'NOT_REQUIRED') : 'FAILED',
            metadata: {
                ...meta,
                approval: approved ? 'APPROVED' : 'REJECTED',
                rejectedReason: approved ? null : (reason?.trim() || 'Rejected by event team'),
            },
            credential: null,
        };
        if (approved) {
            const nextState = reservationStatePatch({ paid, approved, rejected: false });
            const ticket = await tx.ticket.update({
                where: { id: current.id },
                data: {
                    status: 'ACTIVE',
                    approvedAt: new Date(),
                    approvedById: actorUserId,
                    rejectedReason: null,
                    paymentConfirmedAt: paid ? new Date() : null,
                    ...nextState,
                    metadata: {
                        ...meta,
                        approval: 'APPROVED',
                        approvedAt: new Date().toISOString(),
                        approvedById: actorUserId,
                        rejectedReason: null,
                    },
                },
                include: {
                    attendee: { select: { id: true, name: true, email: true, phone: true } },
                    ticketType: { select: { id: true, name: true, price: true } },
                    credential: { select: { id: true, code: true, status: true } },
                },
            });
            await tx.attendee.update({
                where: { id: current.attendeeId },
                data: { status: 'CONFIRMED' },
            });
            return { ticket, credential: ticket.credential, alreadyDecided: false, purged: false };
        }
        await purgeReservationTx(tx, current);
        return { ticket: snapshot, credential: null, alreadyDecided: false, purged: true };
    });
    if (decided.alreadyDecided) {
        return { ticket: decided.ticket, credential: decided.credential, alreadyDecided: true };
    }
    const eventForCred = { id: event.id, orgId: event.orgId, name: event.name, startAt: event.startAt, endAt: event.endAt, venueName: event.venueName };
    let credential = decided.credential;
    if (approved) {
        const issued = await issueReservationCredential({
            event: eventForCred,
            ticket: decided.ticket,
            issuerUserId: actorUserId,
        });
        credential = issued.credential;
        await writeAudit({
            organizationId: event.orgId,
            eventId,
            actorUserId,
            action: AuditActions.RESERVATION_APPROVED,
            resourceType: 'ticket',
            resourceId: decided.ticket.id,
            previousValue: { approval: 'PENDING' },
            newValue: { approval: 'APPROVED', paymentStatus: reservationPaymentOf(decided.ticket) },
        });
        logActivity(eventId, 'reservation', `Reservation approved · ${reservationCodeOf(decided.ticket) ?? decided.ticket.id.slice(0, 8)}`, params.actorName);
    }
    else {
        const codeOf = reservationCodeOf(decided.ticket);
        const rejectionDelivery = await getDeliveryAdapter('EMAIL').send({
            to: decided.ticket.attendee.email ?? '',
            subject: `Reservation update — ${event.name}`,
            html: ticketEmailShell({
                preheader: `Your reservation for ${event.name}`,
                title: 'Reservation not approved',
                body: `We're sorry — your reservation for <strong>${event.name}</strong> could not be approved. If you believe this is a mistake, contact the event team directly.`,
                rows: [
                    { label: 'Event', value: event.name },
                    { label: 'Ticket', value: decided.ticket.ticketType.name },
                    ...(codeOf ? [{ label: 'Reservation', value: codeOf }] : []),
                    { label: 'Status', value: 'Not approved' },
                ],
                footer: 'TKT · Control center for live events',
            }),
        }).catch(() => ({ ok: false, provider: 'smtp', providerMessageId: null, error: 'send failed' }));
        await writeAudit({
            organizationId: event.orgId,
            eventId,
            actorUserId,
            action: AuditActions.RESERVATION_REJECTED,
            resourceType: 'ticket',
            resourceId: decided.ticket.id,
            previousValue: { approval: 'PENDING' },
            newValue: { approval: 'REJECTED', reason: reason?.trim() || 'Rejected by event team' },
        });
        logActivity(eventId, 'reservation', `Reservation rejected · ${reservationCodeOf(decided.ticket) ?? decided.ticket.id.slice(0, 8)}`, params.actorName);
    }
    if (decided.purged)
        return { ticket: decided.ticket, credential: null, alreadyDecided: false };
    const updated = await prisma.ticket.findUnique({
        where: { id: decided.ticket.id },
        include: { credential: { select: { id: true, code: true, status: true } } },
    });
    return { ticket: updated, credential, alreadyDecided: false };
}
//# sourceMappingURL=service.js.map