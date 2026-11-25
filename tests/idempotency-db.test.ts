import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '../src/lib/db.js'
import {
  acquireIdempotencyKey,
  completeIdempotencyKey,
  releaseIdempotencyKey,
} from '../src/lib/idempotency.js'

describe('idempotency persistence', () => {
  it('owner-scoped writes work against the real schema', async () => {
    const key = `db-test-${Date.now()}-${Math.random()}`
    const keyHash = createHash('sha256').update(key).digest('hex')

    try {
      const first = await acquireIdempotencyKey(prisma, key)
      expect(first.state).toBe('acquired')
      if (first.state !== 'acquired') return

      await releaseIdempotencyKey(prisma, key, 'not-the-owner')
      expect(await prisma.idempotencyKey.count({ where: { keyHash } })).toBe(1)
      await releaseIdempotencyKey(prisma, key, first.owner)
      expect(await prisma.idempotencyKey.count({ where: { keyHash } })).toBe(0)

      const second = await acquireIdempotencyKey(prisma, key)
      expect(second.state).toBe('acquired')
      if (second.state !== 'acquired') return
      await completeIdempotencyKey(prisma, key, second.owner, { data: 'ok' })
      expect(await acquireIdempotencyKey(prisma, key)).toEqual({
        state: 'replay',
        response: { data: 'ok' },
      })
    } finally {
      await prisma.idempotencyKey.deleteMany({ where: { keyHash } })
    }
  })
})
