import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { canRedeemAccessCode, normalizeAccessCode, redeemAccessCode } from '../access-codes/service.js'

export async function accessCodeRoutes(app: FastifyInstance) {
// ── Access code lookup / redemption (VIP / guest controls) ──
  app.get('/events/:eventId/access-codes/:code', async (req) => {
    const { eventId, code } = req.params as { eventId: string; code: string }
    const email = String((req.query as any)?.email ?? '').trim().toLowerCase()
    const phone = String((req.query as any)?.phone ?? '').trim()
    const normalized = normalizeAccessCode(code)
    if (!normalized) throw errors.badRequest('Invalid access code')

    const accessCode = await prisma.accessCode.findFirst({
      where: { eventId, code: normalized },
      select: { id: true, code: true, type: true, status: true, fullName: true, email: true, phone: true, attendeeCategory: true, ticketTypeId: true, maxRedemptions: true, redemptionCount: true, expiresAt: true },
    })
    if (!accessCode) throw errors.notFound('Access code not found')

    // Protect PII: if code is bound to identity, require matching email or phone query param.
    const boundEmail = String(accessCode.email ?? '').trim().toLowerCase()
    const boundPhone = String(accessCode.phone ?? '').replace(/\D/g, '')
    const claimedPhone = phone.replace(/\D/g, '')
    if (boundEmail || boundPhone) {
      const emailOk = boundEmail && email && email === boundEmail
      const phoneOk = boundPhone && claimedPhone.length >= 6 && claimedPhone === boundPhone
      if (!emailOk && !phoneOk) throw errors.notFound('Access code not found')
    }

    const redeemable = canRedeemAccessCode(accessCode)
    return {
      data: {
        id: accessCode.id,
        code: accessCode.code,
        type: accessCode.type,
        status: accessCode.status,
        fullName: accessCode.fullName,
        attendeeCategory: accessCode.attendeeCategory,
        ticketTypeId: accessCode.ticketTypeId,
        maxRedemptions: accessCode.maxRedemptions,
        redemptionCount: accessCode.redemptionCount,
        expiresAt: accessCode.expiresAt,
        redeemable: redeemable.ok,
        reason: redeemable.ok ? null : redeemable.reason,
      },
    }
  })

  app.post('/events/:eventId/access-codes/redeem', async (req) => {
    const { eventId } = req.params as { eventId: string }
    const body = z.object({
      code: z.string().min(3),
      name: z.string().min(2),
      email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
      phone: z.string().optional(),
    }).parse(req.body)

    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, status: true } })
    if (!event || !['PUBLISHED', 'LIVE', 'COMPLETED'].includes(event.status)) throw errors.notFound('Event not found')

    const result = await redeemAccessCode({
      eventId,
      codeRaw: body.code,
      fullName: body.name,
      email: body.email ?? null,
      phone: body.phone ?? null,
      sourceIp: req.ip,
    })
    return { data: { ok: true, reservationCode: result.ticket.reservationCode ?? null, credentialCode: result.credential.code, attendeeId: result.attendee.id, ticketId: result.ticket.id } }
  })

}
