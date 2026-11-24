import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  eventFindUnique: vi.fn(async (_args?: any) => ({ orgId: 'org-1' })),
  webhookCreate: vi.fn(async (args: any) => ({ id: 'hook-1', ...args.data })),
  requirePermission: vi.fn(async (..._args: any[]) => undefined),
  writeAudit: vi.fn(async (..._args: any[]) => undefined),
}))

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
import { assertSafeWebhookUrl } from '../src/lib/webhookTarget.js'

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
})
