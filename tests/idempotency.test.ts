import { describe, expect, it } from 'vitest'
import {
  acquireIdempotencyKey,
  completeIdempotencyKey,
  releaseIdempotencyKey,
} from '../src/lib/idempotency.js'

type Row = { keyHash: string; response: any; expiresAt: Date }

/** In-memory stand-in for the unique-key semantics of IdempotencyKey. */
function createClient() {
  const rows = new Map<string, Row>()

  const matches = (row: Row, where: any): boolean => {
    if (where.keyHash !== undefined && row.keyHash !== where.keyHash) return false
    if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt)) return false
    if (where.AND) {
      const clauses = Array.isArray(where.AND) ? where.AND : [where.AND]
      if (!clauses.every((clause: any) => matches(row, clause))) return false
    }
    if (where.response?.path) {
      let value: any = row.response
      for (const part of where.response.path) value = value?.[part]
      if (value !== where.response.equals) return false
    }
    return true
  }

  const client = {
    idempotencyKey: {
      create: async ({ data }: any) => {
        if (rows.has(data.keyHash)) {
          const error: any = new Error('Unique constraint failed')
          error.code = 'P2002'
          throw error
        }
        rows.set(data.keyHash, { ...data })
        return data
      },
      findUnique: async ({ where }: any) => rows.get(where.keyHash) ?? null,
      deleteMany: async ({ where }: any) => {
        let count = 0
        for (const [key, row] of rows) {
          if (matches(row, where)) {
            rows.delete(key)
            count++
          }
        }
        return { count }
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0
        for (const [key, row] of rows) {
          if (matches(row, where)) {
            rows.set(key, { ...row, ...data })
            count++
          }
        }
        return { count }
      },
    },
  }

  return { client: client as any, rows }
}

describe('idempotency keys', () => {
  it('reserves the key for exactly one concurrent caller', async () => {
    const { client } = createClient()
    const results = await Promise.all([
      acquireIdempotencyKey(client, 'concurrent-key'),
      acquireIdempotencyKey(client, 'concurrent-key'),
    ])

    expect(results.filter((result) => result.state === 'acquired')).toHaveLength(1)
    expect(results.filter((result) => result.state !== 'acquired')).toHaveLength(1)
  })

  it('replays the completed response to a later caller', async () => {
    const { client } = createClient()
    const first = await acquireIdempotencyKey(client, 'replay-key')
    expect(first.state).toBe('acquired')

    if (first.state !== 'acquired') return
    await completeIdempotencyKey(client, 'replay-key', first.owner, { data: 'done' })
    expect(await acquireIdempotencyKey(client, 'replay-key')).toEqual({
      state: 'replay',
      response: { data: 'done' },
    })
  })

  it('only lets the owning request release its reservation', async () => {
    const { client, rows } = createClient()
    const first = await acquireIdempotencyKey(client, 'release-key')
    if (first.state !== 'acquired') throw new Error('expected to acquire')

    await releaseIdempotencyKey(client, 'release-key', 'another-owner')
    expect(rows.size).toBe(1)
    await releaseIdempotencyKey(client, 'release-key', first.owner)
    expect(rows.size).toBe(0)
  })

  it('does not let a stale owner overwrite a newer owner after marker expiry', async () => {
    const { client, rows } = createClient()
    const first = await acquireIdempotencyKey(client, 'stale-key')
    if (first.state !== 'acquired') throw new Error('expected to acquire')

    const row = [...rows.values()][0]!
    row.expiresAt = new Date(Date.now() - 1000)
    const second = await acquireIdempotencyKey(client, 'stale-key')
    if (second.state !== 'acquired') throw new Error('expected reacquire')

    await completeIdempotencyKey(client, 'stale-key', first.owner, { data: 'stale' })
    await releaseIdempotencyKey(client, 'stale-key', first.owner)
    expect(rows.size).toBe(1)

    await completeIdempotencyKey(client, 'stale-key', second.owner, { data: 'fresh' })
    expect(await acquireIdempotencyKey(client, 'stale-key')).toEqual({
      state: 'replay',
      response: { data: 'fresh' },
    })
  })
})
