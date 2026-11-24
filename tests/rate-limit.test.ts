import { describe, expect, it } from 'vitest'

process.env.TKT_RATE_LIMIT_TEST = 'true'
const { buildApp } = await import('../src/app.js')

describe('rate limits', () => {
  it('returns a 429 RATE_LIMITED response when a scoped limit is exceeded', async () => {
    const app = await buildApp()
    try {
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {},
        })
        expect(res.statusCode).toBe(400)
      }

      const limited = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {},
      })

      expect(limited.statusCode).toBe(429)
      expect(limited.json()).toMatchObject({
        error: { code: 'RATE_LIMITED' },
      })
    } finally {
      await app.close()
    }
  })
})
