import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { parseCorsOrigins } from '../src/config.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('CORS origin parsing', () => {
  it('always allows local development and the deployed frontend', () => {
    expect(parseCorsOrigins()).toContain('http://localhost:5173')
    expect(parseCorsOrigins()).toContain('https://ticketak.vercel.app')
  })

  it('adds configured origins without spaces or duplicates', () => {
    expect(parseCorsOrigins(' https://preview.example , https://ticketak.vercel.app , ')).toEqual([
      'http://localhost:5173',
      'https://ticketak.vercel.app',
      'https://preview.example',
    ])
  })
})

describe('CORS headers', () => {
  it('allows credentialed requests from the deployed frontend', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://ticketak.vercel.app' },
    })
    expect(res.headers['access-control-allow-origin']).toBe('https://ticketak.vercel.app')
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('does not echo an unknown origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})
