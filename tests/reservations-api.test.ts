import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startTestApp, stopTestApp, app, registerUser, createOrg, auth, expectStatus, assignStaff, login } from './helpers.js'
import { getDeliveryAdapter } from '../src/lib/delivery.js'
import { prisma } from '../src/lib/db.js'
import { runWithDbContext } from '../src/lib/dbContext.js'

const cleanupOrgIds: string[] = []
const cleanupUserIds: string[] = []

async function registerIsolatedUser(name: string, email: string) {
  const password = 'TestPass123!'
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { name, email, password },
  })
  expectStatus(res, 201)
  const data = res.json().data
  cleanupUserIds.push(data.user.id as string)
  return { name, email, password, token: data.token as string, userId: data.user.id as string }
}

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

async function addOrgMember(token: string, orgId: string, email: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/organizations/${orgId}/members`,
    headers: auth(token),
    payload: { email, role: 'VIEWER' },
  })
  expect([200, 201]).toContain(res.statusCode)
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
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } }).catch(() => {})
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
      phone: '+20 100 123 4567',
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

  it('returns a code without waiting for QR generation or SMTP, then exposes both via status', async () => {
    const admin = await registerUser('ResLatency')
    const orgId = await createOrg(admin.token, `Org ResLatency ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event ResLatency ${Date.now()}`)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Free Fast', 0)
    const email = `latency-${Date.now()}@test.tkt`
    // Block SMTP indefinitely: a response that waits for email can never pass.
    let releaseSend!: (result: { ok: boolean; provider: string; providerMessageId: string | null; error: string | null }) => void
    const sendSpy = vi.spyOn(getDeliveryAdapter('EMAIL'), 'send').mockImplementation(
      () => new Promise((resolve) => { releaseSend = resolve }),
    )

    try {
      const reserve = await app.inject({
        method: 'POST',
        url: `/public/events/${eventId}/reservations`,
        payload: { name: 'Fast Guest', email, phone: '+20 100 123 4567', ticketTypeId },
      })
      expectStatus(reserve, 201)
      expect(reserve.json().data.qr).toBeNull()

      const { reservationCode, ticketId, attendeeId } = reserve.json().data
      const statusUrl = `/public/events/${eventId}/reservations/status?code=${reservationCode}`
      const status = await app.inject({ method: 'GET', url: statusUrl })
      expectStatus(status, 200)
      expect(status.json().data.ticketId).toBe(ticketId)
      expect(status.json().data.attendeeId).toBe(attendeeId)

      // Credential minting happens after the response; status is the handoff.
      await vi.waitFor(() => expect(sendSpy).toHaveBeenCalled(), { timeout: 10_000 })
      await vi.waitFor(async () => {
        const ready = await app.inject({ method: 'GET', url: statusUrl })
        expectStatus(ready, 200)
        expect(ready.json().data.qr).toBeTruthy()
      }, { timeout: 10_000 })
      releaseSend({ ok: true, provider: 'smtp', providerMessageId: null, error: null })
      await vi.waitFor(async () => {
        const attempts = await runWithDbContext({ isInternal: true }, () =>
          prisma.credentialDeliveryAttempt.count({ where: { eventId, ticketId } }),
        )
        expect(attempts).toBeGreaterThan(0)
      }, { timeout: 20_000 })
    } finally {
      sendSpy.mockRestore()
    }
  })

  it('resends a ticket publicly only for a matching reservation code and email', async () => {
    const admin = await registerUser('ResPublicResend')
    const orgId = await createOrg(admin.token, `Org ResPublicResend ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event ResPublicResend ${Date.now()}`)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Free Resend', 0)
    const email = `resend-${Date.now()}@test.tkt`

    const reserve = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: { name: 'Resend Guest', email, phone: '+20 100 123 4567', ticketTypeId },
    })
    expectStatus(reserve, 201)
    const reservationCode = reserve.json().data.reservationCode as string

    const wrongEmail = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations/resend`,
      payload: { reservationCode, email: `someone-else-${Date.now()}@test.tkt` },
    })
    expectStatus(wrongEmail, 404)

    const wrongCode = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations/resend`,
      payload: { reservationCode: 'TKT-NOT-REAL', email },
    })
    expectStatus(wrongCode, 404)

    const resend = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations/resend`,
      payload: { reservationCode, email },
    })
    expectStatus(resend, 200)
    expect(resend.json().data).toHaveProperty('deliveryStatus')
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
      payload: { name: 'Free Guest', email: `free-decision-${Date.now()}@test.tkt`, phone: '+20 100 123 4567', ticketTypeId },
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
    const manager = await registerUser('ResTransportMgr')
    await addOrgMember(admin.token, orgId, manager.email)
    await assignStaff(admin.token, eventId, manager.userId, 'event_manager')
    const managerToken = await login(manager.email, manager.password)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Conference', 0)
    const transportTypeId = await createTicketType(admin.token, eventId, 'Conference + Bus', 100, true)
    const bus = await createBus(managerToken, eventId, 50)
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

  it('serializes competing public holds and requires the winning hold token to reserve', async () => {
    const admin = await registerIsolatedUser('HoldRaceAdmin', `hold-race-admin-${Date.now()}@isolated.tkt`)
    const orgId = await createOrg(admin.token, `Org HoldRace ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event HoldRace ${Date.now()}`)
    const manager = await registerIsolatedUser('HoldRaceMgr', `hold-race-mgr-${Date.now()}@isolated.tkt`)
    await addOrgMember(admin.token, orgId, manager.email)
    await assignStaff(admin.token, eventId, manager.userId, 'event_manager')
    const managerToken = await login(manager.email, manager.password)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Conference + Bus', 0, true)
    const bus = await createBus(managerToken, eventId)
    const seatId = bus.seatIds[0]

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/public/events/${eventId}/buses/${bus.id}/hold`,
        payload: { seatIds: [seatId], sessionId: 'public-hold-session-A' },
      }),
      app.inject({
        method: 'POST',
        url: `/public/events/${eventId}/buses/${bus.id}/hold`,
        payload: { seatIds: [seatId], sessionId: 'public-hold-session-B' },
      }),
    ])
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409])
    const winningToken = first.statusCode === 200 ? 'public-hold-session-A' : 'public-hold-session-B'

    const withoutToken = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: {
        name: 'Race Guest',
        email: `hold-race-no-token-${Date.now()}@test.tkt`,
        phone: '+20 100 123 4567',
        ticketTypeId,
        busId: bus.id,
        seatIds: [seatId],
      },
    })
    expectStatus(withoutToken, 409)

    const reserved = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: {
        name: 'Race Guest',
        email: `hold-race-winner-${Date.now()}@test.tkt`,
        phone: '+20 100 123 4567',
        ticketTypeId,
        busId: bus.id,
        seatIds: [seatId],
        holdToken: winningToken,
      },
    })
    expectStatus(reserved, 201)

    const directRelease = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/buses/${bus.id}/release`,
      headers: auth(managerToken),
      payload: { seatIds: [seatId] },
    })
    expectStatus(directRelease, 409)
    await runWithDbContext({ isInternal: true }, async () => {
      const seat = await prisma.busSeat.findUnique({ where: { id: seatId }, select: { state: true, ticketId: true } })
      expect(seat?.state).toBe('RESERVED')
      expect(seat?.ticketId).toBe(reserved.json().data.ticketId)
    })
  })

  it('allows a public reservation to claim a seat after its hold expires', async () => {
    const admin = await registerIsolatedUser('HoldExpiryAdmin', `hold-expiry-admin-${Date.now()}@isolated.tkt`)
    const orgId = await createOrg(admin.token, `Org HoldExpiry ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event HoldExpiry ${Date.now()}`)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Conference + Bus', 0, true)
    const bus = await createBus(admin.token, eventId)
    const seatId = bus.seatIds[0]

    const hold = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/buses/${bus.id}/hold`,
      payload: { seatIds: [seatId], sessionId: 'expired-hold-session' },
    })
    expectStatus(hold, 200)

    await runWithDbContext({ isInternal: true }, async () => {
      await prisma.busSeat.update({ where: { id: seatId }, data: { holdExpiresAt: new Date(Date.now() - 1_000) } })
    })

    const reservation = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: {
        name: 'Expired Hold Guest',
        email: `hold-expired-${Date.now()}@test.tkt`,
        phone: '+20 100 123 4567',
        ticketTypeId,
        busId: bus.id,
        seatIds: [seatId],
      },
    })
    expectStatus(reservation, 201)
  })

  it('prevents seat edits, layout rebuilds, and bus deletion while a public hold is active', async () => {
    const admin = await registerIsolatedUser('HoldGuardAdmin', `hold-guard-admin-${Date.now()}@isolated.tkt`)
    const orgId = await createOrg(admin.token, `Org HoldGuard ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event HoldGuard ${Date.now()}`)
    const manager = await registerIsolatedUser('HoldGuardMgr', `hold-guard-mgr-${Date.now()}@isolated.tkt`)
    await addOrgMember(admin.token, orgId, manager.email)
    await assignStaff(admin.token, eventId, manager.userId, 'event_manager')
    const managerToken = await login(manager.email, manager.password)
    const bus = await createBus(managerToken, eventId)
    const seatId = bus.seatIds[0]

    const hold = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/buses/${bus.id}/hold`,
      payload: { seatIds: [seatId], sessionId: 'layout-hold-session' },
    })
    expectStatus(hold, 200)

    const changeSeat = await app.inject({
      method: 'PATCH',
      url: `/events/${eventId}/buses/${bus.id}/seats/${seatId}`,
      headers: auth(managerToken),
      payload: { state: 'UNAVAILABLE' },
    })
    expectStatus(changeSeat, 409)

    const rebuild = await app.inject({
      method: 'PATCH',
      url: `/events/${eventId}/buses/${bus.id}`,
      headers: auth(managerToken),
      payload: { layout: { template: 'grid', rows: 3, cols: 2 } },
    })
    expectStatus(rebuild, 409)

    const remove = await app.inject({
      method: 'DELETE',
      url: `/events/${eventId}/buses/${bus.id}`,
      headers: auth(managerToken),
    })
    expectStatus(remove, 409)
  })

  it('blocks manual approval until payment proof is confirmed', async () => {
    const admin = await registerUser('ResPaymentGuard')
    const orgId = await createOrg(admin.token, `Org ResPaymentGuard ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event ResPaymentGuard ${Date.now()}`)
    const manager = await registerUser('ResPaymentMgr')
    await addOrgMember(admin.token, orgId, manager.email)
    await assignStaff(admin.token, eventId, manager.userId, 'event_manager')
    const managerToken = await login(manager.email, manager.password)
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
      headers: auth(managerToken),
      payload: { approved: true },
    })
    expectStatus(blocked, 409)
    expect(blocked.json().error.code).toBe('CONFLICT')
    expect(blocked.json().error.message).toContain('Confirm payment proof')

    const review = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/payments/reservations/${ticketId}/review`,
      headers: auth(managerToken),
      payload: { action: 'CONFIRM' },
    })
    expectStatus(review, 200)
    expect(review.json().data.approval).toBe('APPROVED')
    expect(review.json().data.paymentStatus).toBe('CONFIRMED')

    const alreadyDecided = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/reservations/${ticketId}/decision`,
      headers: auth(managerToken),
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
    const manager = await registerUser('ResAttendeeMgr')
    await addOrgMember(admin.token, orgId, manager.email)
    await assignStaff(admin.token, eventId, manager.userId, 'event_manager')
    const managerToken = await login(manager.email, manager.password)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Paid Visible', 50)
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
      headers: auth(managerToken),
    })
    expectStatus(defaultList, 200)
    expect(defaultList.json().data.rows.some((a: any) => a.email === email)).toBe(false)

    const pendingList = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/attendees?scope=pending`,
      headers: auth(managerToken),
    })
    expectStatus(pendingList, 200)
    expect(pendingList.json().data.rows.some((a: any) => a.email === email)).toBe(true)

    const review = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/payments/reservations/${reserve.json().data.ticketId}/review`,
      headers: auth(managerToken),
      payload: { action: 'CONFIRM' },
    })
    expectStatus(review, 200)

    const approvedList = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/attendees`,
      headers: auth(managerToken),
    })
    expectStatus(approvedList, 200)
    expect(approvedList.json().data.rows.some((a: any) => a.email === email)).toBe(true)
  })

  it('lists explicit pending payments and permanently removes rejected reservations', async () => {
    const admin = await registerIsolatedUser('ResPurge', `res-purge-${Date.now()}@isolated.tkt`)
    const orgId = await createOrg(admin.token, `Org ResPurge ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event ResPurge ${Date.now()}`)
    const manager = await registerIsolatedUser('ResPurgeMgr', `res-purge-mgr-${Date.now()}@isolated.tkt`)
    await addOrgMember(admin.token, orgId, manager.email)
    await assignStaff(admin.token, eventId, manager.userId, 'event_manager')
    const managerToken = await login(manager.email, manager.password)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Paid Purge', 50)
    const email = `purge-${Date.now()}@test.tkt`

    const reserve = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: { name: 'Purge Guest', email, phone: '+20 100 123 4567', ticketTypeId },
    })
    expectStatus(reserve, 201)
    const ticketId = reserve.json().data.ticketId as string

    const pending = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/payments/pending`,
      headers: auth(managerToken),
    })
    expectStatus(pending, 200)
    expect(pending.json().data.some((p: any) => p.id === ticketId && p.paymentStatus === 'PENDING')).toBe(true)

    const reject = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/payments/reservations/${ticketId}/review`,
      headers: auth(managerToken),
      payload: { action: 'REJECT' },
    })
    expectStatus(reject, 200)

    await runWithDbContext({ isInternal: true }, async () => {
      expect(await prisma.ticket.findUnique({ where: { id: ticketId } })).toBeNull()
      expect(await prisma.attendee.count({ where: { eventId, email } })).toBe(0)
    })

    const after = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/payments/pending`,
      headers: auth(managerToken),
    })
    expectStatus(after, 200)
    expect(after.json().data.some((p: any) => p.id === ticketId)).toBe(false)
  })

  it('allows unauthenticated payment proof uploads', async () => {
    const boundary = 'tkt-proof-boundary'
    const png = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from('fake PNG payload for content sniffing'),
    ])
    const head = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="proof.png"',
      'Content-Type: image/png',
      '',
      '',
    ].join('\r\n'))
    const body = Buffer.concat([head, png, Buffer.from(`\r\n--${boundary}--\r\n`)])

    const upload = await app.inject({
      method: 'POST',
      url: '/uploads/proof',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })
    expectStatus(upload, 200)
    const url = upload.json().data.url as string
    expect(url).toContain('/uploads/')
    await fs.unlink(path.resolve(process.cwd(), 'uploads', path.basename(new URL(url).pathname))).catch(() => {})
  })

  it('rejects payment proofs whose bytes do not match the declared type', async () => {
    const boundary = 'tkt-proof-mismatch'
    const head = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="proof.png"',
      'Content-Type: image/png',
      '',
      '',
    ].join('\r\n'))
    const body = Buffer.concat([head, Buffer.from('not a png'), Buffer.from(`\r\n--${boundary}--\r\n`)])

    const upload = await app.inject({
      method: 'POST',
      url: '/uploads/proof',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })
    expectStatus(upload, 400)
  })
})
