import Fastify from 'fastify'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  eventFindUnique: vi.fn(async (_args?: any) => ({ orgId: 'org-1' })),
  webhookCreate: vi.fn(async (args: any) => ({ id: 'hook-1', ...args.data })),
  requirePermission: vi.fn(async (..._args: any[]) => undefined),
  writeAudit: vi.fn(async (..._args: any[]) => undefined),
  dnsLookup: vi.fn(async (_hostname: string, _options?: any): Promise<any> => []),
}))

vi.mock('node:dns/promises', () => ({ lookup: mocks.dnsLookup }))

vi.mock('../src/lib/db.js', () => ({
  prisma: {
    event: { findUnique: mocks.eventFindUnique },
    webhookSubscription: { create: mocks.webhookCreate },
  },
}))
vi.mock('../src/middleware/auth.js', () => ({
  authenticate: async (req: any) => {
    req.user = { id: 'test-user' }
  },
}))
vi.mock('../src/middleware/authorize.js', () => ({ requirePermission: mocks.requirePermission }))
vi.mock('../src/lib/audit.js', () => ({ writeAudit: mocks.writeAudit }))

import { integrationRoutes } from '../src/features/integrations/routes.js'
import {
  assertSafeWebhookUrl,
  resolveResponse,
  validateAndPinWebhookUrl,
  verifyPinnedCertificate,
  verifyPinnedTarget,
} from '../src/lib/webhookTarget.js'

async function buildApp() {
  const app = Fastify()
  app.setErrorHandler((err: any, _req, reply) => {
    reply.status(err.statusCode ?? 500).send({
      error: { code: err.code ?? 'INTERNAL', message: err.message },
    })
  })
  await app.register(integrationRoutes, { prefix: '/events/:eventId/integrations' })
  await app.ready()
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.dnsLookup.mockImplementation(async (hostname: string) =>
    hostname === 'localhost'
      ? [{ address: '127.0.0.1', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }],
  )
})

describe('webhook target validation', () => {
  it('rejects a loopback IP literal over https', async () => {
    await expect(assertSafeWebhookUrl('https://127.0.0.1/hook')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects a non-loopback http URL', async () => {
    await expect(assertSafeWebhookUrl('http://example.com/hook')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects credentials embedded in the URL', async () => {
    await expect(assertSafeWebhookUrl('https://user:pass@example.com/hook')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('does not persist a client-supplied secret or headers', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt-1/integrations/webhooks',
      payload: {
        name: 'Ops hook',
        url: 'http://localhost:4000/hook',
        secret: 'client-secret',
        headers: { authorization: 'Bearer attacker' },
        events: ['*'],
      },
    })

    expect(res.statusCode).toBe(201)
    const data = mocks.webhookCreate.mock.calls[0][0].data
    expect(data.secret).toBeTruthy()
    expect(data.secret).not.toBe('client-secret')
    expect(data.headers).toBeUndefined()
    expect(JSON.parse(res.body).data.secret).toBeUndefined()
    expect(JSON.parse(res.body).data.headers).toBeUndefined()
  })

  it('rejects an unsafe URL before creating the subscription', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt-1/integrations/webhooks',
      payload: { name: 'Bad hook', url: 'http://169.254.169.254/latest/meta-data' },
    })

    expect(res.statusCode).toBe(400)
    expect(mocks.webhookCreate).not.toHaveBeenCalled()
  })

  it('rejects a hostname that resolves to a private address at validation time', async () => {
    mocks.dnsLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }])

    await expect(validateAndPinWebhookUrl('https://hooks.example.com/deliver')).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('pins resolved addresses and rejects a tampered target', async () => {
    mocks.dnsLookup.mockResolvedValueOnce([
      { address: '93.184.216.35', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ])

    const target = await validateAndPinWebhookUrl('https://hooks.example.com/deliver')
    expect(target.pinnedIps).toEqual(['93.184.216.34', '93.184.216.35'])
    expect(verifyPinnedTarget(target)).toBe(true)

    expect(verifyPinnedTarget({ ...target, pinnedIps: ['169.254.169.254'] })).toBe(false)
  })
})

describe('webhook delivery response handling', () => {
  function fakeResponse(statusCode: number, body = '') {
    const res: any = new EventEmitter()
    res.statusCode = statusCode
    res.headers = { 'content-type': 'application/json' }
    queueMicrotask(() => {
      res.emit('data', Buffer.from(body))
      res.emit('end')
    })
    return res
  }

  it('accepts bodyless 204/205/304 acknowledgements', async () => {
    for (const status of [204, 205, 304]) {
      const response = await new Promise<Response>((resolve, reject) => {
        resolveResponse(fakeResponse(status, 'ignored'), resolve, reject)
      })
      expect(response.status).toBe(status)
      expect(await response.text()).toBe('')
    }
  })

  it('keeps a normal response body', async () => {
    const response = await new Promise<Response>((resolve, reject) => {
      resolveResponse(fakeResponse(200, '{"ok":true}'), resolve, reject)
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('verifies the certificate against the exact hostname', () => {
    const matching = {
      subject: { CN: 'hooks.example.com' },
      subjectaltname: 'DNS:hooks.example.com',
    }
    const unrelated = {
      subject: { CN: 'hooks.example.com.attacker.test' },
      subjectaltname: 'DNS:hooks.example.com.attacker.test',
    }

    expect(verifyPinnedCertificate('hooks.example.com', matching)).toBeUndefined()
    expect(verifyPinnedCertificate('hooks.example.com', unrelated)).toBeInstanceOf(Error)
  })
})
