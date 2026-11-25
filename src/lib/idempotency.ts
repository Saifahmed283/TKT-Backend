import type { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60
const PROCESSING_TTL_SECONDS = 5 * 60
const PROCESSING_MARKER = { __tktIdempotency: 'PROCESSING' }

type IdempotencyStore = Pick<PrismaClient, 'idempotencyKey'>
type StoredKey = { response: unknown; expiresAt: Date }

export type AcquireIdempotencyResult =
  | { state: 'acquired' }
  | { state: 'replay'; response: unknown }
  | { state: 'processing' }

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function isProcessing(response: unknown): boolean {
  return Boolean(
    response &&
    typeof response === 'object' &&
    (response as Record<string, unknown>).__tktIdempotency === 'PROCESSING',
  )
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
    try {
      await client.idempotencyKey.create({
        data: {
          keyHash,
          response: PROCESSING_MARKER as any,
          expiresAt: new Date(Date.now() + PROCESSING_TTL_SECONDS * 1000),
        },
      })
      return { state: 'acquired' }
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

/** Replace the processing marker with the completed response. */
export async function completeIdempotencyKey(
  client: IdempotencyStore,
  key: string,
  response: unknown,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const keyHash = hashKey(key)
  await client.idempotencyKey.update({
    where: { keyHash },
    data: {
      response: response as any,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    },
  })
}

/** Release a reservation so a failed request can retry with the same key. */
export async function releaseIdempotencyKey(
  client: IdempotencyStore,
  key: string,
): Promise<void> {
  await client.idempotencyKey.deleteMany({ where: { keyHash: hashKey(key) } })
}
