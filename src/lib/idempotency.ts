import type { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60
type IdempotencyStore = Pick<PrismaClient, 'idempotencyKey'>

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * Look up a completed idempotent response. Expired keys are removed so they
 * cannot block a legitimate retry after the TTL.
 */
export async function getIdempotencyResponse(
  client: IdempotencyStore,
  key: string,
): Promise<unknown | null> {
  const keyHash = hashKey(key)
  const existing = await client.idempotencyKey.findUnique({
    where: { keyHash },
    select: { response: true, expiresAt: true },
  })
  if (!existing) return null
  if (existing.expiresAt <= new Date()) {
    await client.idempotencyKey.deleteMany({ where: { keyHash } })
    return null
  }
  return existing.response
}

/**
 * Store a response only after the mutation succeeded. A failed request must
 * not leave a key that makes retries return a stale or empty response.
 */
export async function completeIdempotencyKey(
  client: IdempotencyStore,
  key: string,
  response: unknown,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<unknown | null> {
  const keyHash = hashKey(key)
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
  try {
    await client.idempotencyKey.create({
      data: { keyHash, response: response as any, expiresAt },
    })
    return null
  } catch (error: any) {
    if (error?.code !== 'P2002') throw error
    // A concurrent request with the same key already finished. Return its
    // response so both callers observe the same result.
    const existing = await client.idempotencyKey.findUnique({
      where: { keyHash },
      select: { response: true, expiresAt: true },
    })
    if (existing && existing.expiresAt > new Date()) return existing.response
    await client.idempotencyKey.deleteMany({ where: { keyHash } })
    return completeIdempotencyKey(client, key, response, ttlSeconds)
  }
}
