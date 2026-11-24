import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp, stopTestApp, app, registerUser, createOrg, auth, expectStatus } from './helpers.js'
import { prisma } from '../src/lib/db.js'
import { runWithDbContext } from '../src/lib/dbContext.js'

const cleanupOrgIds: string[] = []

async function createPublishedEvent(token: string, orgId: string, name: string) {
  const event = await app.inject({
    method: 'POST',
    url: '/events',
    headers: auth(token),
    payload: {
      organizationId: orgId,
      name,
      type: 'CONFERENCE',
      startAt: new Date(Date.now() + 86400_000).toISOString(),
      timezone: 'UTC',
    },
  })
  expectStatus(event, 201)
  const eventId = event.json().data.id as string
  for (const status of ['PLANNING', 'READY', 'PUBLISHED']) {
    const res = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/status`,
      headers: auth(token),
      payload: { status },
    })
    expectStatus(res, 200)
  }
  const openReg = await app.inject({
    method: 'PATCH',
    url: `/events/${eventId}`,
    headers: auth(token),
    payload: { settings: { registration: { enabled: true, open: true } } },
  })
  expectStatus(openReg, 200)
  return eventId
}

async function createTicketType(token: string, eventId: string, name: string, price = 0) {
  const res = await app.inject({
    method: 'POST',
    url: `/events/${eventId}/tickets/types`,
    headers: auth(token),
    payload: { name, price },
  })
  expectStatus(res, 201)
  return res.json().data.id as string
}

beforeAll(async () => {
  await startTestApp()
})

afterAll(async () => {
  await runWithDbContext({ isInternal: true }, async () => {
    for (const id of cleanupOrgIds) {
      await prisma.organization.deleteMany({ where: { id } }).catch(() => {})
    }
    await prisma.user.deleteMany({ where: { email: { endsWith: '@test.tkt' } } }).catch(() => {})
  })
  await stopTestApp()
})

describe('public reservation integrity', () => {
  it('returns 409 RESERVATION_EXISTS for active duplicate email', async () => {
    const admin = await registerUser('ResDup')
    const orgId = await createOrg(admin.token, `Org ResDup ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event ResDup ${Date.now()}`)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Free', 0)

    const payload = {
      name: 'Guest One',
      email: 'duplicate@test.tkt',
      ticketTypeId,
    }

    const first = await app.inject({ method: 'POST', url: `/public/events/${eventId}/reservations`, payload })
    expectStatus(first, 201)
    const firstBody = first.json().data

    const second = await app.inject({ method: 'POST', url: `/public/events/${eventId}/reservations`, payload })
    expectStatus(second, 409)
    const body = second.json()
    expect(body.error.code).toBe('RESERVATION_EXISTS')
    expect(body.data.reservationCode).toBe(firstBody.reservationCode)

    const count = await runWithDbContext({ isInternal: true }, () =>
      prisma.ticket.count({
        where: { eventId, reservationEmail: 'duplicate@test.tkt', status: { in: ['ISSUED', 'ACTIVE', 'CONSUMED'] } },
      }),
    )
    expect(count).toBe(1)
  })

  it('decision endpoint is idempotent and resend returns delivery history', async () => {
    const admin = await registerUser('ResDecision')
    const orgId = await createOrg(admin.token, `Org ResDecision ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event ResDecision ${Date.now()}`)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Paid', 50)

    const reserve = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: { name: 'Paid Guest', email: `paid-${Date.now()}@test.tkt`, ticketTypeId },
    })
    expectStatus(reserve, 201)
    const ticketId = reserve.json().data.ticketId as string

    const approve = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/reservations/${ticketId}/decision`,
      headers: auth(admin.token),
      payload: { approved: true },
    })
    expectStatus(approve, 200)
    expect(approve.json().data.approval).toBe('APPROVED')

    const approveAgain = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/reservations/${ticketId}/decision`,
      headers: auth(admin.token),
      payload: { approved: true },
    })
    expectStatus(approveAgain, 200)
    expect(approveAgain.json().data.alreadyDecided).toBe(true)

    const resend = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/reservations/${ticketId}/resend`,
      headers: auth(admin.token),
      payload: {},
    })
    expectStatus(resend, 200)

    const history = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/reservations/${ticketId}/deliveries`,
      headers: auth(admin.token),
    })
    expectStatus(history, 200)
    expect(Array.isArray(history.json().data)).toBe(true)
    expect(history.json().data.length).toBeGreaterThan(0)
  })
})
