import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const applicationRow = {
  id: 'app-1',
  eventId: 'evt-1',
  email: 'jane@example.com',
  requestedRoleCode: null,
  requestedTeamId: null,
  requestedAreaIds: [],
}

const mocks = vi.hoisted(() => ({
  workforceApplicationFindFirst: vi.fn(async (_args?: any) => ({
    id: 'app-1',
    eventId: 'evt-1',
    email: 'jane@example.com',
    requestedRoleCode: null,
    requestedTeamId: null,
    requestedAreaIds: [],
  })),
  eventFindUnique: vi.fn(async (_args?: any) => ({ id: 'evt-1', orgId: 'org-1', name: 'Event' })),
  roleFindUnique: vi.fn(async (_args?: any) => ({ id: 'role-foreign', orgId: 'org-2' })),
  roleFindFirst: vi.fn(async (_args?: any) => ({ id: 'role-system', orgId: null })),
  userFindUnique: vi.fn(async (_args?: any) => ({ id: 'user-1', email: 'jane@example.com' })),
  organizationMemberUpsert: vi.fn(async (args: any) => ({ id: 'org-member-1', ...args })),
  eventMemberUpsert: vi.fn(async (args: any) => ({ id: 'member-1', ...args })),
  memberAreaDeleteMany: vi.fn(async () => ({ count: 0 })),
  staffProfileUpsert: vi.fn(async (args: any) => ({ id: 'profile-1', ...args })),
  workforceApplicationUpdate: vi.fn(async (args: any) => ({ id: 'app-1', ...args.data })),
  requirePermission: vi.fn(async (..._args: any[]) => undefined),
  writeAudit: vi.fn(async (..._args: any[]) => undefined),
  hashPassword: vi.fn(async () => 'hashed'),
  sendMail: vi.fn(async () => undefined),
  ticketEmailShell: vi.fn(() => '<p>Ticket</p>'),
}))

vi.mock('../src/lib/db.js', () => ({
  prisma: {
    workforceApplication: {
      findFirst: mocks.workforceApplicationFindFirst,
      update: mocks.workforceApplicationUpdate,
    },
    event: { findUnique: mocks.eventFindUnique },
    role: { findUnique: mocks.roleFindUnique, findFirst: mocks.roleFindFirst },
    user: { findUnique: mocks.userFindUnique },
    $transaction: vi.fn(async (callback: any) =>
      callback({
        organizationMember: { upsert: mocks.organizationMemberUpsert },
        eventMember: { upsert: mocks.eventMemberUpsert },
        memberArea: { deleteMany: mocks.memberAreaDeleteMany },
        staffProfile: { upsert: mocks.staffProfileUpsert },
        workforceApplication: { update: mocks.workforceApplicationUpdate },
      }),
    ),
  },
}))

vi.mock('../src/middleware/auth.js', () => ({
  authenticate: async (req: any) => {
    req.user = { id: 'test-user' }
  },
}))
vi.mock('../src/middleware/authorize.js', () => ({ requirePermission: mocks.requirePermission }))
vi.mock('../src/lib/audit.js', () => ({ writeAudit: mocks.writeAudit }))
vi.mock('../src/lib/auth.js', () => ({ hashPassword: mocks.hashPassword }))
vi.mock('../src/lib/mailer.js', () => ({
  sendMail: mocks.sendMail,
  ticketEmailShell: mocks.ticketEmailShell,
}))

import { workforceRoutes } from '../src/features/workforce/routes.js'

async function buildApp() {
  const app = Fastify()
  app.setErrorHandler((err: any, _req, reply) => {
    reply.status(err.statusCode ?? 500).send({
      error: { code: err.code ?? 'INTERNAL', message: err.message, details: err.details },
    })
  })
  await app.register(workforceRoutes, { prefix: '/events/:eventId/workforce' })
  await app.ready()
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.workforceApplicationFindFirst.mockResolvedValue({ ...applicationRow })
  mocks.roleFindUnique.mockResolvedValue({ id: 'role-foreign', orgId: 'org-2' })
  mocks.roleFindFirst.mockResolvedValue({ id: 'role-system', orgId: null })
})

describe('workforce role conversion', () => {
  it('rejects an explicit role owned by another organization', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt-1/workforce/applications/app-1/convert',
      payload: { userId: 'user-1', roleId: 'role-foreign' },
    })

    expect(res.statusCode).toBe(400)
    expect(mocks.eventMemberUpsert).not.toHaveBeenCalled()
  })

  it('maps a legacy SAC role code to the canonical TKT role before lookup', async () => {
    const app = await buildApp()
    mocks.workforceApplicationFindFirst.mockResolvedValueOnce({
      ...applicationRow,
      requestedRoleCode: 'scanner',
    })
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt-1/workforce/applications/app-1/convert',
      payload: { userId: 'user-1' },
    })

    expect(res.statusCode).toBe(200)
    expect(mocks.roleFindFirst.mock.calls[0][0].where.code).toBe('access_scanner')
    expect(mocks.eventMemberUpsert).toHaveBeenCalled()
  })

  it('downgrades legacy SAC super_admin to org_admin', async () => {
    const app = await buildApp()
    mocks.workforceApplicationFindFirst.mockResolvedValueOnce({
      ...applicationRow,
      requestedRoleCode: 'super_admin',
    })
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt-1/workforce/applications/app-1/convert',
      payload: { userId: 'user-1' },
    })

    expect(res.statusCode).toBe(200)
    expect(mocks.roleFindFirst.mock.calls[0][0].where.code).toBe('org_admin')
  })
})
