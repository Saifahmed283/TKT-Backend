import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  eventFindUnique: vi.fn(async (_args?: any) => ({ id: 'evt-1', orgId: 'org-1' })),
  attendeeFindFirst: vi.fn(async (_args?: any) => ({ id: 'att-1', eventId: 'evt-1' })),
  ticketTypeFindFirst: vi.fn(async (_args?: any) => ({
    id: 'tt-1',
    eventId: 'evt-1',
    price: 75,
  })),
  ticketCreate: vi.fn(async (args: any) => ({ id: 'ticket-1', ...args.data })),
  requirePermission: vi.fn(async (..._args: any[]) => undefined),
  writeAudit: vi.fn(async (..._args: any[]) => undefined),
}))

vi.mock('../src/lib/db.js', () => ({
  prisma: {
    event: { findUnique: mocks.eventFindUnique },
    attendee: { findFirst: mocks.attendeeFindFirst },
    ticketType: { findFirst: mocks.ticketTypeFindFirst },
    ticket: { create: mocks.ticketCreate },
  },
}))

vi.mock('../src/middleware/auth.js', () => ({
  authenticate: async (req: any) => {
    req.user = { id: 'test-user' }
  },
}))
vi.mock('../src/middleware/authorize.js', () => ({ requirePermission: mocks.requirePermission }))
vi.mock('../src/lib/audit.js', () => ({ writeAudit: mocks.writeAudit }))

import { ticketRoutes } from '../src/features/tickets/routes.js'

async function buildApp() {
  const app = Fastify()
  app.setErrorHandler((err: any, _req, reply) => {
    reply.status(err.statusCode ?? 500).send({
      error: { code: err.code ?? 'INTERNAL', message: err.message, details: err.details },
    })
  })
  await app.register(ticketRoutes, { prefix: '/events/:eventId/tickets' })
  await app.ready()
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ticket issue pricing', () => {
  it('ignores a client-supplied price and uses the ticket type price', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt-1/tickets',
      payload: { attendeeId: 'att-1', ticketTypeId: 'tt-1', price: 1 },
    })

    expect(res.statusCode).toBe(201)
    expect(mocks.ticketCreate.mock.calls[0][0].data.price).toBe(75)
    expect(mocks.writeAudit.mock.calls[0][0].newValue.price).toBe(75)
  })
})
