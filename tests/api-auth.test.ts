import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/lib/db.js'
import { runWithDbContext } from '../src/lib/dbContext.js'

let app: FastifyInstance
let adminToken: string
let ownerAToken: string
let ownerBToken: string
let eventManagerToken: string
let scannerToken: string

// resources
let orgId = ''
let eventId = ''
let otherOrgId = ''
let otherEventId = ''
let mainGateId = ''
let vipGateId = ''
let gateBId = ''
let attendeeId = ''
let credentialCode = ''
let staffUserId = ''

const rnd = Date.now().toString(36)

beforeAll(async () => {
  app = await buildApp()
  await app.ready()

  // Users: platform super admin (from seed) + two org owners
  const regA = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { name: `OwnerA-${rnd}`, email: `ownera-${rnd}@test.local`, password: 'TestPass123!' },
  })
  expect(regA.statusCode).toBe(201)
  const userA = regA.json().data.user

  const regB = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { name: `OwnerB-${rnd}`, email: `ownerb-${rnd}@test.local`, password: 'TestPass123!' },
  })
  expect(regB.statusCode).toBe(201)
  const userB = regB.json().data.user

  // Admin token: create an isolated platform super admin instead of relying on seed data.
  const adminReg = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { name: `PlatformAdmin-${rnd}`, email: `admin-${rnd}@test.local`, password: 'TestPass123!' },
  })
  expect(adminReg.statusCode).toBe(201)
  await runWithDbContext({ isInternal: true }, async () => {
    await prisma.user.update({
      where: { id: adminReg.json().data.user.id },
      data: { platformRole: 'super_admin' },
    })
  })
  const adminLogin = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: `admin-${rnd}@test.local`, password: 'TestPass123!' },
  })
  expect(adminLogin.statusCode).toBe(200)
  adminToken = adminLogin.json().data.token

  // Org A + event A
  const orgA = await app.inject({
    method: 'POST', url: '/organizations',
    headers: { authorization: `Bearer ${regA.json().data.token}` },
    payload: { name: `OrgA-${rnd}` },
  })
  orgId = orgA.json().data.id

  const evA = await app.inject({
    method: 'POST', url: '/events',
    headers: { authorization: `Bearer ${regA.json().data.token}` },
    payload: { organizationId: orgId, name: `EventA-${rnd}`, startAt: new Date().toISOString() },
  })
  eventId = evA.json().data.id

  // Org B + event B
  const orgB = await app.inject({
    method: 'POST', url: '/organizations',
    headers: { authorization: `Bearer ${regB.json().data.token}` },
    payload: { name: `OrgB-${rnd}` },
  })
  otherOrgId = orgB.json().data.id

  const evB = await app.inject({
    method: 'POST', url: '/events',
    headers: { authorization: `Bearer ${regB.json().data.token}` },
    payload: { organizationId: otherOrgId, name: `EventB-${rnd}`, startAt: new Date().toISOString() },
  })
  otherEventId = evB.json().data.id

  // Areas on event A
  const gate = await app.inject({
    method: 'POST', url: `/events/${eventId}/areas`,
    headers: { authorization: `Bearer ${regA.json().data.token}` },
    payload: { name: `MainGate-${rnd}`, type: 'GATE', accessPolicy: 'TICKETED' },
  })
  mainGateId = gate.json().data.id
  const vip = await app.inject({
    method: 'POST', url: `/events/${eventId}/areas`,
    headers: { authorization: `Bearer ${regA.json().data.token}` },
    payload: { name: `VipGate-${rnd}`, type: 'GATE', accessPolicy: 'VIP_ONLY' },
  })
  vipGateId = vip.json().data.id
  // Area on event B (for cross-event credential test)
  const gateB = await app.inject({
    method: 'POST', url: `/events/${otherEventId}/areas`,
    headers: { authorization: `Bearer ${regB.json().data.token}` },
    payload: { name: `GateB-${rnd}`, type: 'GATE', accessPolicy: 'TICKETED' },
  })
  gateBId = gateB.json().data.id

  // Walk event A through the full lifecycle to LIVE
  for (const status of ['PLANNING', 'READY', 'PUBLISHED', 'LIVE']) {
    const r = await app.inject({
      method: 'POST', url: `/events/${eventId}/status`,
      headers: { authorization: `Bearer ${regA.json().data.token}` },
      payload: { status },
    })
    expect(r.statusCode).toBe(200)
  }

  // Event A LIVE + staff assignment
  await app.inject({
    method: 'POST', url: `/events/${eventId}/status`,
    headers: { authorization: `Bearer ${regA.json().data.token}` },
    payload: { status: 'LIVE' },
  })

  const scannerRole = await prisma.role.findUnique({ where: { code: 'access_scanner' } })
  const scannerReg = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { name: `Scanner-${rnd}`, email: `scanner-${rnd}@test.local`, password: 'TestPass123!' },
  })
  staffUserId = scannerReg.json().data.user.id
  const assign = await app.inject({
    method: 'POST', url: `/events/${eventId}/members`,
    headers: { authorization: `Bearer ${regA.json().data.token}` },
    payload: { userId: staffUserId, roleId: scannerRole!.id, areaIds: [mainGateId] },
  })
  expect(assign.statusCode).toBe(201)

  // Attendee + ticket + credential on event A
  const att = await app.inject({
    method: 'POST', url: `/events/${eventId}/attendees`,
    headers: { authorization: `Bearer ${regA.json().data.token}` },
    payload: { name: `Guest-${rnd}`, email: `guest-${rnd}@test.local`, category: 'VIP' },
  })
  attendeeId = att.json().data.id

  const cred = await app.inject({
    method: 'POST', url: `/events/${eventId}/credentials`,
    headers: { authorization: `Bearer ${regA.json().data.token}` },
    payload: { attendeeId, areaIds: [mainGateId, vipGateId], validFrom: new Date(Date.now() - 3600_000).toISOString() },
  })
  credentialCode = cred.json().data.code

  eventManagerToken = regA.json().data.token
  scannerToken = scannerReg.json().data.token
  ownerAToken = regA.json().data.token
  ownerBToken = regB.json().data.token
})

afterAll(async () => {
  try {
    await runWithDbContext({ isInternal: true }, async () => {
      await prisma.event.deleteMany({ where: { id: { in: [eventId, otherEventId] } } })
      await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } })
      await prisma.user.deleteMany({ where: { email: { contains: rnd } } })
    })
  } finally {
    await app.close()
    await prisma.$disconnect()
  }
})

describe('API authorization — spec §42 security matrix', () => {
  it('user with no relation to the event → forbidden', async () => {
    const res = await app.inject({
      method: 'GET', url: `/events/${eventId}/members`,
      headers: { authorization: `Bearer ${ownerBToken}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('cross-organization access → forbidden (IDOR on org resource)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/organizations/${otherOrgId}/members`,
      headers: { authorization: `Bearer ${eventManagerToken}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('cross-organization event access → forbidden', async () => {
    const res = await app.inject({
      method: 'GET', url: `/events/${otherEventId}`,
      headers: { authorization: `Bearer ${eventManagerToken}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('cross-event attendee access → forbidden', async () => {
    const res = await app.inject({
      method: 'GET', url: `/events/${otherEventId}/attendees`,
      headers: { authorization: `Bearer ${eventManagerToken}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('scanner cannot view audit logs (no permission)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/events/${eventId}/audit-logs`,
      headers: { authorization: `Bearer ${scannerToken}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('scanner cannot assign staff (no permission)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/events/${eventId}/members`,
      headers: { authorization: `Bearer ${scannerToken}` },
      payload: { userId: staffUserId, roleId: 'whatever' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('scanner CAN scan in assigned area', async () => {
    const res = await app.inject({
      method: 'POST', url: `/events/${eventId}/access/validate`,
      headers: { authorization: `Bearer ${scannerToken}` },
      payload: { code: credentialCode, areaId: mainGateId },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.result).toBe('GRANTED')
  })

  it('scanner CANNOT scan in unassigned area (scope enforcement)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/events/${eventId}/access/validate`,
      headers: { authorization: `Bearer ${scannerToken}` },
      payload: { code: credentialCode, areaId: vipGateId },
    })
    expect(res.statusCode).toBe(403)
  })

  it('forged credential code → denied, not crash', async () => {
    const res = await app.inject({
      method: 'POST', url: `/events/${eventId}/access/validate`,
      headers: { authorization: `Bearer ${eventManagerToken}` },
      payload: { code: 'TKT1.forged.sig', areaId: mainGateId },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.result).toBe('DENIED')
    expect(res.json().data.reason).toBe('INVALID_CREDENTIAL')
  })

  it('credential from another event → denied (WRONG_EVENT path)', async () => {
    // Issue a credential on event A then try scanning it against event B
    const res = await app.inject({
      method: 'POST', url: `/events/${otherEventId}/access/validate`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { code: credentialCode, areaId: gateBId },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.result).toBe('DENIED')
  })

  it('unauthenticated request → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/organizations' })
    expect(res.statusCode).toBe(401)
  })

  it('super admin can access any organization', async () => {
    const res = await app.inject({
      method: 'GET', url: `/organizations/${orgId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('no password hashes leaked in API responses', async () => {
    const res = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${eventManagerToken}` },
    })
    expect(JSON.stringify(res.json().data)).not.toContain('passwordHash')
    expect(JSON.stringify(res.json().data)).not.toContain('$2b$')
  })
})