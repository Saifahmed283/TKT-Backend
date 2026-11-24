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

async function createTicketType(token: string, eventId: string, name: string, price = 0, transportIncluded = false) {
  const res = await app.inject({
    method: 'POST',
    url: `/events/${eventId}/tickets/types`,
    headers: auth(token),
    payload: { name, price, transportIncluded },
  })
  expectStatus(res, 201)
  return res.json().data.id as string
}

async function createBus(token: string, eventId: string, seatPrice = 0) {
  const res = await app.inject({
    method: 'POST',
    url: `/events/${eventId}/buses`,
    headers: auth(token),
    payload: {
      name: 'Shuttle One',
      layout: { template: 'grid', rows: 2, cols: 2 },
      seatPrice,
      currency: 'EGP',
    },
  })
  expectStatus(res, 201)
  const bus = res.json().data
  return { id: bus.id as string, seatIds: bus.seats.map((s: any) => s.id as string) }
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
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Free Decision', 0)

    const reserve = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: { name: 'Free Guest', email: `free-decision-${Date.now()}@test.tkt`, ticketTypeId },
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

  it('requires a phone and enforces transport seat selection', async () => {
    const admin = await registerUser('ResTransport')
    const orgId = await createOrg(admin.token, `Org ResTransport ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event ResTransport ${Date.now()}`)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Conference', 0)
    const transportTypeId = await createTicketType(admin.token, eventId, 'Conference + Bus', 100, true)
    const bus = await createBus(admin.token, eventId, 50)
    const email = `transport-${Date.now()}@test.tkt`

    const noPhone = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: { name: 'Transit Guest', email, ticketTypeId },
    })
    expectStatus(noPhone, 400)
    expect(noPhone.json().error.code).toBe('VALIDATION_ERROR')

    const noSeat = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: { name: 'Transit Guest', email, phone: '+20 100 123 4567', ticketTypeId: transportTypeId },
    })
    expectStatus(noSeat, 400)
    expect(noSeat.json().error.message).toContain('select exactly one seat')

    const twoSeats = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: {
        name: 'Transit Guest',
        email,
        phone: '+20 100 123 4567',
        ticketTypeId: transportTypeId,
        busId: bus.id,
        seatIds: bus.seatIds.slice(0, 2),
      },
    })
    expectStatus(twoSeats, 400)
    expect(twoSeats.json().error.message).toContain('select exactly one seat')

    const reserved = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: {
        name: 'Transit Guest',
        email,
        phone: '+20 100 123 4567',
        ticketTypeId: transportTypeId,
        busId: bus.id,
        seatIds: [bus.seatIds[0]],
        seatPassengers: [{ seatId: bus.seatIds[0], name: 'Transit Guest' }],
      },
    })
    expectStatus(reserved, 201)
    expect(reserved.json().data.price).toBe('150')
    expect(reserved.json().data.seats).toHaveLength(1)
  })

  it('blocks manual approval until payment proof is confirmed', async () => {
    const admin = await registerUser('ResPaymentGuard')
    const orgId = await createOrg(admin.token, `Org ResPaymentGuard ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event ResPaymentGuard ${Date.now()}`)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Paid Guard', 50)

    const reserve = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: {
        name: 'Payment Guest',
        email: `payment-guard-${Date.now()}@test.tkt`,
        phone: '+20 100 123 4567',
        ticketTypeId,
      },
    })
    expectStatus(reserve, 201)
    const ticketId = reserve.json().data.ticketId as string
    expect(reserve.json().data.paymentStatus).toBe('PENDING')

    const blocked = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/reservations/${ticketId}/decision`,
      headers: auth(admin.token),
      payload: { approved: true },
    })
    expectStatus(blocked, 409)
    expect(blocked.json().error.code).toBe('CONFLICT')
    expect(blocked.json().error.message).toContain('Confirm payment proof')

    const review = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/payments/reservations/${ticketId}/review`,
      headers: auth(admin.token),
      payload: { action: 'CONFIRM' },
    })
    expectStatus(review, 200)
    expect(review.json().data.approval).toBe('APPROVED')
    expect(review.json().data.paymentStatus).toBe('CONFIRMED')

    const alreadyDecided = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/reservations/${ticketId}/decision`,
      headers: auth(admin.token),
      payload: { approved: true },
    })
    expectStatus(alreadyDecided, 200)
    expect(alreadyDecided.json().data.alreadyDecided).toBe(true)
  })

  it('hides pending attendees until approval', async () => {
    const admin = await registerUser('ResAttendeeVisibility')
    const orgId = await createOrg(admin.token, `Org ResAttendeeVisibility ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event ResAttendeeVisibility ${Date.now()}`)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Free Visible', 0)
    const email = `attendee-visible-${Date.now()}@test.tkt`

    const reserve = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: { name: 'Visible Guest', email, phone: '+20 100 123 4567', ticketTypeId },
    })
    expectStatus(reserve, 201)

    const defaultList = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/attendees`,
      headers: auth(admin.token),
    })
    expectStatus(defaultList, 200)
    expect(defaultList.json().data.rows.some((a: any) => a.email === email)).toBe(false)

    const pendingList = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/attendees?scope=pending`,
      headers: auth(admin.token),
    })
    expectStatus(pendingList, 200)
    expect(pendingList.json().data.rows.some((a: any) => a.email === email)).toBe(true)

    const approve = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/reservations/${reserve.json().data.ticketId}/decision`,
      headers: auth(admin.token),
      payload: { approved: true },
    })
    expectStatus(approve, 200)

    const approvedList = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/attendees`,
      headers: auth(admin.token),
    })
    expectStatus(approvedList, 200)
    expect(approvedList.json().data.rows.some((a: any) => a.email === email)).toBe(true)
  })
})
