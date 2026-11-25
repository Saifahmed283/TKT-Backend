import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}))

vi.mock('../src/config.js', () => ({ config: { isProd: true } }))
vi.mock('../src/lib/db.js', () => ({ prisma: { $queryRaw: mocks.queryRaw } }))

vi.spyOn(console, 'warn').mockImplementation(() => undefined)
vi.spyOn(console, 'error').mockImplementation(() => undefined)

const { distributedRateLimit } = await import('../src/lib/distributedRateLimit.js')

describe('Postgres rate-limit fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
  })

  it('allows a request within the counted window', async () => {
    mocks.queryRaw.mockResolvedValueOnce([{ count: 1n, windowStart: new Date() }])
    const result = await distributedRateLimit('test:allow', { max: 3, windowMs: 60_000 })
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(2)
    expect(result.resetAt).toBeGreaterThan(Date.now())
  })

  it('rejects a request after the counter exceeds the limit', async () => {
    mocks.queryRaw.mockResolvedValueOnce([{ count: 4n, windowStart: new Date() }])
    const result = await distributedRateLimit('test:limit', { max: 3, windowMs: 60_000 })
    expect(result).toMatchObject({ allowed: false, remaining: 0 })
  })

  it('fails closed in production when the counter query fails', async () => {
    mocks.queryRaw.mockRejectedValueOnce(new Error('database unavailable'))
    const result = await distributedRateLimit('test:error', { max: 3, windowMs: 60_000 })
    expect(result.allowed).toBe(false)
  })
})
