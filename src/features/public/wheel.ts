import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/db.js'
import { WHEEL_SEGMENTS, clientIp, reservationCode } from './schemas.js'

export async function wheelRoutes(app: FastifyInstance) {
// ── Prize wheel ───────────────────────────────────────────
  app.get('/wheel/segments', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async () => {
    return {
      data: WHEEL_SEGMENTS.map((s) => ({ reward: s.reward, label: s.label })),
    }
  })

  app.get('/wheel/status', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req) => {
    const ip = clientIp(req)
    const record = await prisma.wheelSpin.findUnique({ where: { ip } })
    if (!record) {
      return { data: { canSpin: true, spinsUsed: 0, remainingSpins: 1, lastReward: null, lastLabel: null, lastCode: null } }
    }
    const maxSpins = record.lastReward === 'RETRY' ? 2 : 1
    return {
      data: {
        canSpin: record.spins < maxSpins,
        spinsUsed: record.spins,
        remainingSpins: Math.max(0, maxSpins - record.spins),
        lastReward: record.lastReward,
        lastLabel: record.lastLabel,
        lastCode: record.lastCode,
      },
    }
  })

  app.post('/wheel/spin', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const ip = clientIp(req)
    const record = await prisma.wheelSpin.upsert({ where: { ip }, update: {}, create: { ip } })
    const maxSpins = record.lastReward === 'RETRY' ? 2 : 1
    if (record.spins >= maxSpins) {
      return reply.code(409).send({
        error: { code: 'WHEEL_LIMIT', message: 'Your free spin is used up. Come back for the next campaign.' },
      })
    }

    const total = WHEEL_SEGMENTS.reduce((sum, s) => sum + s.weight, 0)
    let roll = Math.random() * total
    let index = WHEEL_SEGMENTS.length - 1
    for (let i = 0; i < WHEEL_SEGMENTS.length; i++) {
      const seg = WHEEL_SEGMENTS[i]!
      roll -= seg.weight
      if (roll <= 0) {
        index = i
        break
      }
    }
    const segment = WHEEL_SEGMENTS[index]!
    const code = segment.reward === 'RETRY' ? null : reservationCode()
    const updated = await prisma.wheelSpin.update({
      where: { id: record.id },
      data: { spins: record.spins + 1, lastReward: segment.reward, lastLabel: segment.label, lastCode: code },
    })

    const remaining = segment.reward === 'RETRY' && record.spins === 0 ? 1 : 0
    return reply.send({
      data: {
        index,
        reward: segment.reward,
        label: segment.label,
        code,
        spinsUsed: updated.spins,
        remainingSpins: remaining,
      },
    })
  })
}
