import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  eventCreate: vi.fn(async (args: any) => ({ id: 'evt-1', ...args.data })),
  eventFindUnique: vi.fn(async (_args?: any) => ({
    orgId: 'org-1',
    settings: {},
    type: 'CONFERENCE',
    category: 'CONFERENCE',
  })),
  eventUpdate: vi.fn(async (args: any) => ({ id: 'evt-1', ...args.data })),
  eventMemberCreate: vi.fn(async (args: any) => ({ id: 'member-1', ...args.data })),
  eventMemberFindUnique: vi.fn(async (_args?: any) => null),
  roleFindUnique: vi.fn(async (_args?: any) => null),
  organizationFolderFindFirst: vi.fn(async (_args?: any) => ({ id: 'folder-1' })),

  attendeeCreate: vi.fn(async (args: any) => ({ id: 'att-1', ...args.data })),
  attendeeUpdate: vi.fn(async (args: any) => ({ id: 'att-1', ...args.data })),
  attendeeFindFirst: vi.fn(async (_args?: any) => ({ id: 'att-1', eventId: 'evt-1' })),
  attendeeFindMany: vi.fn(async (_args?: any) => []),

  ticketTypeCreate: vi.fn(async (args: any) => ({ id: 'tt-1', ...args.data })),
  ticketTypeUpdate: vi.fn(async (args: any) => ({ id: 'tt-1', ...args.data })),
  ticketTypeFindFirst: vi.fn(async (_args?: any) => ({
    id: 'tt-1',
    eventId: 'evt-1',
    salesStartAt: null,
    salesEndAt: null,
  })),

  requirePermission: vi.fn(async (..._args: any[]) => undefined),
  resolveOrgContext: vi.fn(async (_req: any, _orgId: string) => ({ isAdmin: true })),
  writeAudit: vi.fn(async (..._args: any[]) => undefined),
  publish: vi.fn(async (..._args: any[]) => undefined),
  logActivity: vi.fn(async (..._args: any[]) => undefined),
}))

vi.mock('../src/lib/db.js', () => ({
  prisma: {
    event: {
      create: mocks.eventCreate,
      findUnique: mocks.eventFindUnique,
      update: mocks.eventUpdate,
    },
    eventMember: { create: mocks.eventMemberCreate, findUnique: mocks.eventMemberFindUnique },
    role: { findUnique: mocks.roleFindUnique },
    organizationFolder: { findFirst: mocks.organizationFolderFindFirst },
    attendee: {
      create: mocks.attendeeCreate,
      update: mocks.attendeeUpdate,
      findFirst: mocks.attendeeFindFirst,
      findMany: mocks.attendeeFindMany,
    },
    ticketType: {
      create: mocks.ticketTypeCreate,
      update: mocks.ticketTypeUpdate,
      findFirst: mocks.ticketTypeFindFirst,
    },
  },
}))

vi.mock('../src/middleware/auth.js', () => ({
  authenticate: async (req: any) => {
    req.user = { id: 'test-user' }
  },
}))

vi.mock('../src/middleware/authorize.js', () => ({
  requirePermission: mocks.requirePermission,
  resolveOrgContext: mocks.resolveOrgContext,
}))

vi.mock('../src/lib/audit.js', () => ({ writeAudit: mocks.writeAudit }))
vi.mock('../src/lib/realtime.js', () => ({
  publish: mocks.publish,
  channelFor: () => 'taxonomy-test',
}))
vi.mock('../src/lib/activity.js', () => ({ logActivity: mocks.logActivity }))

import { attendeeRoutes } from '../src/features/attendees/routes.js'
import { eventRoutes } from '../src/features/events/routes.js'
import { ticketRoutes } from '../src/features/tickets/routes.js'

async function buildScopedApp() {
  const app = Fastify()
  app.setErrorHandler((err: any, _req, reply) => {
    reply.status(err.statusCode ?? 500).send({
      error: { code: err.code ?? 'INTERNAL', message: err.message, details: err.details },
    })
  })
  await app.register(eventRoutes, { prefix: '/events' })
  await app.register(attendeeRoutes, { prefix: '/events/:eventId/attendees' })
  await app.register(ticketRoutes, { prefix: '/events/:eventId/tickets' })
  await app.ready()
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.eventFindUnique.mockResolvedValue({
    orgId: 'org-1',
    settings: {},
    type: 'CONFERENCE',
    category: 'CONFERENCE',
  })
  mocks.attendeeFindFirst.mockResolvedValue({ id: 'att-1', eventId: 'evt-1' })
  mocks.ticketTypeFindFirst.mockResolvedValue({
    id: 'tt-1',
    eventId: 'evt-1',
    salesStartAt: null,
    salesEndAt: null,
  })
})

describe('event taxonomy persistence', () => {
  it('stores the domain in settings without copying the format into legacy category', async () => {
    const app = await buildScopedApp()
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        organizationId: 'org-1',
        name: 'Revenue Summit',
        type: 'CORPORATE',
        category: 'OTHER',
        domain: 'BUSINESS',
        startAt: '2026-01-01T10:00:00.000Z',
      },
    })

    expect(res.statusCode).toBe(201)
    const data = mocks.eventCreate.mock.calls[0][0].data
    expect(data.category).toBe('OTHER')
    expect(data.settings.taxonomy).toMatchObject({
      format: 'CORPORATE',
      category: 'OTHER',
      domain: 'BUSINESS',
      source: 'tkt',
    })
  })

  it('accepts a legacy SAC category string and records its canonical class', async () => {
    const app = await buildScopedApp()
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        organizationId: 'org-1',
        name: 'Technical Workshop',
        type: 'CONFERENCE',
        category: 'educational',
        startAt: '2026-01-01T10:00:00.000Z',
      },
    })

    expect(res.statusCode).toBe(201)
    const data = mocks.eventCreate.mock.calls[0][0].data
    expect(data.category).toBe('educational')
    expect(data.settings.taxonomy.category).toBe('CONFERENCE')
    expect(data.settings.taxonomy.domain).toBe('EDUCATION')
  })

  it('updates the domain and merges client settings without losing existing values', async () => {
    const app = await buildScopedApp()
    mocks.eventFindUnique.mockResolvedValueOnce({
      orgId: 'org-1',
      settings: { registration: { enabled: true, open: false }, taxonomy: { domain: 'OTHER' } },
      type: 'CONFERENCE',
      category: 'CONFERENCE',
    })
    const res = await app.inject({
      method: 'PATCH',
      url: '/events/evt-1',
      payload: {
        domain: 'TECHNOLOGY',
        settings: { registration: { open: true }, custom: { keep: true } },
      },
    })

    expect(res.statusCode).toBe(200)
    const data = mocks.eventUpdate.mock.calls[0][0].data
    expect(data.settings.registration).toEqual({ enabled: true, open: true })
    expect(data.settings.custom).toEqual({ keep: true })
    expect(data.settings.taxonomy.domain).toBe('TECHNOLOGY')
    expect(data).not.toHaveProperty('domain')
  })

  it('does not publish an invalid domain supplied inside settings', async () => {
    const app = await buildScopedApp()
    mocks.eventFindUnique.mockResolvedValueOnce({
      orgId: 'org-1',
      settings: { taxonomy: { domain: 'TECHNOLOGY' } },
      type: 'CONFERENCE',
      category: 'CONFERENCE',
    })
    const res = await app.inject({
      method: 'PATCH',
      url: '/events/evt-1',
      payload: { settings: { taxonomy: { domain: 'NOT_A_DOMAIN' } } },
    })

    expect(res.statusCode).toBe(200)
    const data = mocks.eventUpdate.mock.calls[0][0].data
    expect(data.settings.taxonomy.domain).toBeNull()
  })
})

describe('attendee taxonomy persistence', () => {
  it('derives attendeeType from a legacy SAC category on create', async () => {
    const app = await buildScopedApp()
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt-1/attendees',
      payload: { name: 'Jane Doe', category: 'press' },
    })

    expect(res.statusCode).toBe(201)
    expect(mocks.attendeeCreate.mock.calls[0][0].data.attendeeType).toBe('MEDIA')
  })

  it('derives attendeeType from a category on update and honors an explicit code', async () => {
    const app = await buildScopedApp()

    const derived = await app.inject({
      method: 'PATCH',
      url: '/events/evt-1/attendees/att-1',
      payload: { category: 'vip_guest' },
    })
    expect(derived.statusCode).toBe(200)
    expect(mocks.attendeeUpdate.mock.calls[0][0].data.attendeeType).toBe('VIP')

    const explicit = await app.inject({
      method: 'PATCH',
      url: '/events/evt-1/attendees/att-1',
      payload: { attendeeType: 'SPEAKER' },
    })
    expect(explicit.statusCode).toBe(200)
    expect(mocks.attendeeUpdate.mock.calls[1][0].data.attendeeType).toBe('SPEAKER')
  })

  it('does not clear attendeeType when a legacy category cannot be resolved', async () => {
    const app = await buildScopedApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/events/evt-1/attendees/att-1',
      payload: { category: 'Custom Label' },
    })

    expect(res.statusCode).toBe(200)
    expect(mocks.attendeeUpdate.mock.calls[0][0].data).not.toHaveProperty('attendeeType')
  })

  it('exports CSV with taxonomy filters without the paginated pageSize cap', async () => {
    const app = await buildScopedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/events/evt-1/attendees/export.csv?attendeeType=MEDIA',
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(mocks.attendeeFindMany.mock.calls[0][0].where).toMatchObject({ eventId: 'evt-1', attendeeType: 'MEDIA' })
    expect(res.body).toContain('Attendee type')
  })
})

describe('ticket tier persistence', () => {
  it('derives tier from a legacy ticket category on create', async () => {
    const app = await buildScopedApp()
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt-1/tickets/types',
      payload: { name: 'General Admission', category: 'General' },
    })

    expect(res.statusCode).toBe(201)
    expect(mocks.ticketTypeCreate.mock.calls[0][0].data.tier).toBe('STANDARD')
  })

  it('derives tier from a legacy ticket category on update', async () => {
    const app = await buildScopedApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/events/evt-1/tickets/types/tt-1',
      payload: { category: 'Early Bird' },
    })

    expect(res.statusCode).toBe(200)
    expect(mocks.ticketTypeUpdate.mock.calls[0][0].data.tier).toBe('EARLY_BIRD')
  })
})

describe('event role assignment', () => {
  it('rejects a platform-scoped role at event level', async () => {
    const app = await buildScopedApp()
    mocks.roleFindUnique.mockResolvedValueOnce({
      id: 'role-platform',
      orgId: null,
      scope: 'PLATFORM',
    })
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt-1/members',
      payload: { userId: 'user-1', roleId: 'role-platform' },
    })

    expect(res.statusCode).toBe(400)
    expect(mocks.eventMemberCreate).not.toHaveBeenCalled()
  })

  it('rejects an organization-scoped role at event level', async () => {
    const app = await buildScopedApp()
    mocks.roleFindUnique.mockResolvedValueOnce({
      id: 'role-org',
      orgId: 'org-1',
      scope: 'ORGANIZATION',
    })
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt-1/members',
      payload: { userId: 'user-1', roleId: 'role-org' },
    })

    expect(res.statusCode).toBe(400)
    expect(mocks.eventMemberCreate).not.toHaveBeenCalled()
  })
})
