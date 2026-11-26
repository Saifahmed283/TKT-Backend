import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  busCreate: vi.fn(async (args: any) => ({ id: 'bus-1', ...args.data })),
  eventFindUnique: vi.fn(async (_args?: any) => ({ orgId: 'org-1' })),
  eventFindMany: vi.fn(async (_args?: any) => []),
  requirePermission: vi.fn(async (..._args: any[]) => undefined),
  writeAudit: vi.fn(async (..._args: any[]) => undefined),
}))

vi.mock('../src/lib/db.js', () => ({
  prisma: {
    bus: { create: mocks.busCreate },
    event: { findUnique: mocks.eventFindUnique, findMany: mocks.eventFindMany },
  },
}))
vi.mock('../src/middleware/auth.js', () => ({
  authenticate: async (req: any) => { req.user = { id: 'test-user' } },
}))
vi.mock('../src/middleware/authorize.js', () => ({ requirePermission: mocks.requirePermission }))
vi.mock('../src/lib/audit.js', () => ({ writeAudit: mocks.writeAudit }))

import { busRoutes } from '../src/features/buses/routes.js'
import { eventRoutes } from '../src/features/public/events.js'

async function buildApp() {
  const app = Fastify()
  app.setErrorHandler((error: any, _req, reply) => {
    reply.status(error.statusCode ?? 500).send({
      error: { code: error.code ?? 'INTERNAL', message: error.message, details: error.details },
    })
  })
  await app.register(busRoutes, { prefix: '/events/:eventId/buses' })
  await app.register(eventRoutes, { prefix: '/public' })
  await app.ready()
  return app
}

const canonicalLayout = {
  schemaVersion: 2,
  template: 'mect49',
  name: 'TKT VOYAGER 49',
  look: 'signature',
  rows: 13,
  cols: 5,
  aisleAfterCol: 2,
  viewBox: { w: 920, h: 1370 },
  cabin: { width: 2.5, length: 11.9, height: 2.45 },
  features: [
    { id: 'front-tv', kind: 'tv', label: 'TV', labelAr: 'شاشة', x: 390, y: 90, w: 140, h: 42 },
    { id: 'wc', kind: 'wc', label: 'WC', labelAr: 'دورة مياه', x: 566, y: 690, w: 82, h: 60 },
  ],
  seats: [
    { label: '1', row: 1, col: 1, state: 'AVAILABLE', kind: 'seat', x: 292, y: 260, mx: -0.78, z: -4.36, width: 0.385, side: 'left' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('canonical bus layouts', () => {
  it('persists geometry and cabin features while creating a minimal seat inventory', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt-1/buses',
      payload: { name: 'Voyager 49', seatPrice: 25, currency: 'EGP', layout: canonicalLayout },
    })

    expect(res.statusCode).toBe(201)
    const data = mocks.busCreate.mock.calls[0][0].data
    expect(data.layout).toEqual(canonicalLayout)
    expect(data.seats.create).toEqual([
      { label: '1', row: 1, col: 1, state: 'AVAILABLE' },
    ])
    expect(data.seatPrice).toBe(25)
    expect(data.currency).toBe('EGP')
  })

  it('exposes bus seat pricing in the public event list', async () => {
    mocks.eventFindMany.mockResolvedValueOnce([{
      id: 'evt-1',
      name: 'Rally',
      description: null,
      type: 'CONFERENCE',
      category: null,
      status: 'PUBLISHED',
      startAt: new Date(Date.now() + 86_400_000),
      endAt: null,
      timezone: 'Africa/Cairo',
      venueName: 'Venue',
      venueAddress: 'Cairo',
      coverImageUrl: null,
      settings: {},
      org: { id: 'org-1', name: 'TKT', logoUrl: null },
      ticketTypes: [],
      buses: [{
        id: 'bus-1',
        name: 'Voyager 49',
        layout: canonicalLayout,
        seatPrice: 25,
        currency: 'EGP',
        seats: [{ id: 'seat-1', label: '1', row: 1, col: 1, state: 'AVAILABLE' }],
        _count: { seats: 1 },
      }],
      _count: { attendees: 0, tickets: 0, accessLogs: 0 },
    }])
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/public/events?scope=upcoming' })

    expect(res.statusCode).toBe(200)
    expect(res.json().data[0].buses[0]).toMatchObject({ seatPrice: '25', currency: 'EGP' })
  })
})
