import type { PrismaClient } from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60
const PROCESSING_TTL_SECONDS = 5 * 60

type IdempotencyStore = Pick<PrismaClient, 'idempotencyKey'>
type StoredKey = { response: unknown; expiresAt: Date }

export type AcquireIdempotencyResult =
  | { state: 'acquired'; owner: string }
  | { state: 'replay'; response: unknown }
  | { state: 'processing' }

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function processingMarker(owner: string) {
  return { __tktIdempotency: 'PROCESSING', __tktOwner: owner }
}

function isProcessing(response: unknown): boolean {
  return Boolean(
    response &&
    typeof response === 'object' &&
    (response as Record<string, unknown>).__tktIdempotency === 'PROCESSING',
  )
}

/**
 * Only the request that acquired the key may complete or release it. Without
 * this, a slow owner could overwrite a newer owner's response after the
 * processing marker expired.
 */
function ownerFilter(owner: string) {
  return {
    AND: [
      { response: { path: ['__tktIdempotency'], equals: 'PROCESSING' } },
      { response: { path: ['__tktOwner'], equals: owner } },
    ],
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readKey(client: IdempotencyStore, keyHash: string): Promise<StoredKey | null> {
  return client.idempotencyKey.findUnique({
    where: { keyHash },
    select: { response: true, expiresAt: true },
  }) as Promise<StoredKey | null>
}

/**
 * Atomically reserve an idempotency key before a mutation starts. Concurrent
 * requests wait briefly for the owner to finish; failed owners delete the key
 * so the same request can be retried safely.
 */
export async function acquireIdempotencyKey(
  client: IdempotencyStore,
  key: string,
): Promise<AcquireIdempotencyResult> {
  const keyHash = hashKey(key)

  for (let attempt = 0; attempt < 3; attempt++) {
    const owner = randomUUID()
    try {
      await client.idempotencyKey.create({
        data: {
          keyHash,
          response: processingMarker(owner) as any,
          expiresAt: new Date(Date.now() + PROCESSING_TTL_SECONDS * 1000),
        },
      })
      return { state: 'acquired', owner }
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error

      const existing = await readKey(client, keyHash)
      const now = new Date()
      if (!existing || existing.expiresAt <= now) {
        await client.idempotencyKey.deleteMany({ where: { keyHash } })
        continue
      }
      if (!isProcessing(existing.response)) {
        return { state: 'replay', response: existing.response }
      }

      let retryAcquire = false
      for (let poll = 0; poll < 20; poll++) {
        await delay(100)
        const current = await readKey(client, keyHash)
        if (!current) {
          retryAcquire = true
          break
        }
        if (current.expiresAt <= new Date()) {
          await client.idempotencyKey.deleteMany({ where: { keyHash } })
          retryAcquire = true
          break
        }
        if (!isProcessing(current.response)) {
          return { state: 'replay', response: current.response }
        }
      }
      if (retryAcquire) continue
      return { state: 'processing' }
    }
  }

  return { state: 'processing' }
}

/** Replace the processing marker with the completed response, if still owned. */
export async function completeIdempotencyKey(
  client: IdempotencyStore,
  key: string,
  owner: string,
  response: unknown,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  await client.idempotencyKey.updateMany({
    where: { keyHash: hashKey(key), ...ownerFilter(owner) },
    data: {
      response: response as any,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    },
  })
}

/** Release a reservation so a failed request can retry with the same key, if still owned. */
export async function releaseIdempotencyKey(
  client: IdempotencyStore,
  key: string,
  owner: string,
): Promise<void> {
  await client.idempotencyKey.deleteMany({
    where: { keyHash: hashKey(key), ...ownerFilter(owner) },
  })
}
