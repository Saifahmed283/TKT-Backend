import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

async function waitForCredential(ticketId: string) {
  await vi.waitFor(async () => {
    const credential = await runWithDbContext({ isInternal: true }, () =>
      prisma.credential.findUnique({ where: { ticketId }, select: { id: true } }),
    )
    expect(credential).toBeTruthy()
  }, { timeout: 15_000 })
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

async function createPaymentProvider(token: string, eventId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/events/${eventId}/payments/providers`,
    headers: auth(token),
    payload: {
      name: 'Instapay test provider',
      paymentLink: 'https://payments.example.test/instapay',
      instructions: 'Transfer the exact amount and attach the receipt.',
    },
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

afterEach(() => {
  vi.restoreAllMocks()
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
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567',
      ticketTypeId,
    }

    const first = await app.inject({ method: 'POST', url: `/public/events/${eventId}/reservations`, payload })
    expectStatus(first, 201)
    const firstBody = first.json().data

    const second = await app.inject({ method: 'POST', url: `/public/events/${eventId}/reservations`, payload })
    expectStatus(second, 409)
    const body = second.json()
    expect(body.error.code).toBe('RESERVATION_EXISTS')
    // Anonymous duplicates must not disclose the existing code or credential.
    expect(body.data).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(firstBody.reservationCode)

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
        payload: { name: 'Fast Guest', email, phone: '+20 100 123 4567',
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567', ticketTypeId },
      })
      expectStatus(reserve, 201)
      expect(reserve.json().data.qr).toBeNull()

      const { reservationCode, ticketId, attendeeId, accessToken } = reserve.json().data
      expect(accessToken).toBeTruthy()

      // A display code alone is not a status capability. The emailed ticket
      // can still be recovered by supplying the matching reservation email.
      const codeOnly = await app.inject({
        method: 'GET',
        url: `/public/events/${eventId}/reservations/status?code=${reservationCode}`,
      })
      expectStatus(codeOnly, 404)
      const emailStatus = await app.inject({
        method: 'GET',
        url: `/public/events/${eventId}/reservations/status?code=${reservationCode}&email=${encodeURIComponent(email)}`,
      })
      expectStatus(emailStatus, 200)
      expect(emailStatus.json().data.ticketId).toBe(ticketId)

      const statusUrl = `/public/events/${eventId}/reservations/status?code=${reservationCode}&token=${encodeURIComponent(accessToken)}`
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

  it('serves the standalone PWA ticket only for the matching reservation code and email', async () => {
    const admin = await registerUser('ResPwaTicket')
    const orgId = await createOrg(admin.token, `Org ResPwaTicket ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event ResPwaTicket ${Date.now()}`)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'PWA Guest', 0)
    const email = `pwa-${Date.now()}@test.tkt`
    const reserve = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: { name: 'PWA Guest', email, phone: '+20 100 123 4567',
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567', ticketTypeId },
    })
    expectStatus(reserve, 201)
    const reservationCode = reserve.json().data.reservationCode as string
    await waitForCredential(reserve.json().data.ticketId)

    const wrongEmail = await app.inject({
      method: 'POST',
      url: '/public/reservations/status',
      payload: { code: reservationCode, email: `wrong-${Date.now()}@test.tkt` },
    })
    expectStatus(wrongEmail, 404)
    expect(wrongEmail.json().data).toBeUndefined()

    const missingEmail = await app.inject({
      method: 'POST',
      url: '/public/reservations/status',
      payload: { code: reservationCode },
    })
    expectStatus(missingEmail, 400)

    const lookup = await app.inject({
      method: 'POST',
      url: '/public/reservations/status',
      payload: { code: reservationCode, email },
    })
    expectStatus(lookup, 200)
    const data = lookup.json().data
    expect(data.reservationCode).toBe(reservationCode)
    expect(data.eventName).toContain('Event ResPwaTicket')
    expect(data.attendeeName).toBe('PWA Guest')
    expect(data.approval).toBe('APPROVED')
    expect(data.credentialStatus).toBe('ACTIVE')
    expect(data.currency).toBe('EGP')
    expect(data.qr).toBeTruthy()
    expect(data).not.toHaveProperty('reservationEmail')
    expect(data).not.toHaveProperty('accessToken')
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
      payload: { name: 'Resend Guest', email, phone: '+20 100 123 4567',
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567', ticketTypeId },
    })
    expectStatus(reserve, 201)
    const reservationCode = reserve.json().data.reservationCode as string
    await waitForCredential(reserve.json().data.ticketId)

    const wrongEmail = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations/resend`,
      payload: { reservationCode, email: `someone-else-${Date.now()}@test.tkt` },
    })
    expectStatus(wrongEmail, 200)
    expect(wrongEmail.json().data).toEqual({ ok: true, deliveryStatus: null })

    const wrongCode = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations/resend`,
      payload: { reservationCode: 'TKT-NOT-REAL', email },
    })
    expectStatus(wrongCode, 200)
    expect(wrongCode.json().data).toEqual({ ok: true, deliveryStatus: null })

    const emailOnly = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations/resend`,
      payload: { email },
    })
    expectStatus(emailOnly, 200)
    expect(emailOnly.json().data).toHaveProperty('deliveryStatus')

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
      payload: { name: 'Free Guest', email: `free-decision-${Date.now()}@test.tkt`, phone: '+20 100 123 4567',
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567',
        ticketTypeId,
      },
    })
    expectStatus(reserve, 201)
    const ticketId = reserve.json().data.ticketId as string
    await waitForCredential(ticketId)

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
    const paymentProviderId = await createPaymentProvider(admin.token, eventId)
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
      payload: { name: 'Transit Guest', email, phone: '+20 100 123 4567',
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567', ticketTypeId: transportTypeId },
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
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567',
        ticketTypeId: transportTypeId,
        busId: bus.id,
        seatIds: bus.seatIds.slice(0, 2),
      },
    })
    expectStatus(twoSeats, 400)
    expect(twoSeats.json().error.message).toContain('select exactly one seat')

    const wrongAmount = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: {
        name: 'Transit Guest',
        email,
        phone: '+20 100 123 4567',
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567',
        ticketTypeId: transportTypeId,
        busId: bus.id,
        seatIds: [bus.seatIds[0]],
        paymentAmount: 149,
      },
    })
    expectStatus(wrongAmount, 400)
    const availableAfterRejectedPayment = await runWithDbContext({ isInternal: true }, () =>
      prisma.busSeat.findUnique({ where: { id: bus.seatIds[0] }, select: { state: true, ticketId: true } }),
    )
    expect(availableAfterRejectedPayment).toMatchObject({ state: 'AVAILABLE', ticketId: null })

    const reserved = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: {
        name: 'Transit Guest',
        email,
        phone: '+20 100 123 4567',
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567',
        ticketTypeId: transportTypeId,
        busId: bus.id,
        seatIds: [bus.seatIds[0]],
        paymentProviderId,
        paymentReference: `instapay-${Date.now()}`,
        paymentProofUrl: '/api/uploads/blob/uploads/test-receipt.png?token=preview',
        paymentAmount: 100,
        ticketDesign: {
          templateId: 'editorial-wide',
          paletteId: 'rose-noir',
          panelColor: '#350D24',
          accentColor: '#F22586',
          backgroundColor: '#FFF2F7',
          textColor: '#2A1020',
        },
        seatPassengers: [{ seatId: bus.seatIds[0], name: 'Transit Guest' }],
      },
    })
    expectStatus(reserved, 201)
    expect(reserved.json().data.price).toBe('100')
    expect(reserved.json().data.seats).toHaveLength(1)

    const ticketId = reserved.json().data.ticketId as string
    const savedTicket = await runWithDbContext({ isInternal: true }, () =>
      prisma.ticket.findUnique({ where: { id: ticketId }, select: { metadata: true } }),
    )
    expect((savedTicket?.metadata as any)?.ticketDesign).toMatchObject({
      templateId: 'editorial-wide',
      paletteId: 'rose-noir',
      panelColor: '#350D24',
      accentColor: '#F22586',
    })
    const linkedSeat = await runWithDbContext({ isInternal: true }, () =>
      prisma.busSeat.findUnique({ where: { id: bus.seatIds[0] }, select: { state: true, ticketId: true, passengerName: true } }),
    )
    expect(linkedSeat).toMatchObject({ state: 'RESERVED', ticketId, passengerName: 'Transit Guest' })

    const duplicateSeatAttempt = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: {
        name: 'Second Transit Guest',
        email: `transport-second-${Date.now()}@test.tkt`,
        phone: '+20 100 123 4568',
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567',
        ticketTypeId: transportTypeId,
        busId: bus.id,
        seatIds: [bus.seatIds[0]],
        paymentProviderId,
        paymentReference: `duplicate-instapay-${Date.now()}`,
        paymentProofUrl: '/api/uploads/blob/uploads/duplicate-receipt.png?token=preview',
        paymentAmount: 100,
      },
    })
    expectStatus(duplicateSeatAttempt, 409)
    const linkedSeatCount = await runWithDbContext({ isInternal: true }, () =>
      prisma.busSeat.count({ where: { id: bus.seatIds[0], ticketId } }),
    )
    expect(linkedSeatCount).toBe(1)
  })

  it('rejects paid reservations unless provider, reference, and proof are all present', async () => {
    const admin = await registerUser('ResIncompletePayment')
    const orgId = await createOrg(admin.token, `Org ResIncompletePayment ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event ResIncompletePayment ${Date.now()}`)
    const manager = await registerUser('ResIncompletePaymentMgr')
    await addOrgMember(admin.token, orgId, manager.email)
    await assignStaff(admin.token, eventId, manager.userId, 'event_manager')
    const managerToken = await login(manager.email, manager.password)
    const ticketTypeId = await createTicketType(admin.token, eventId, 'Paid Complete', 75)
    const paymentProviderId = await createPaymentProvider(admin.token, eventId)
    const email = `incomplete-proof-${Date.now()}@test.tkt`

    const missingReceipt = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: {
        name: 'Incomplete Payment Guest',
        email,
        phone: '+20 100 123 4567',
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567',
        ticketTypeId,
        paymentProviderId,
        paymentReference: 'TRANSFER-123',
      },
    })
    expectStatus(missingReceipt, 400)
    expect(missingReceipt.json().error.message).toContain('uploaded payment proof')

    const missingReference = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: {
        name: 'Incomplete Payment Guest',
        email: `missing-reference-${Date.now()}@test.tkt`,
        phone: '+20 100 123 4567',
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567',
        ticketTypeId,
        paymentProviderId,
        paymentProofUrl: '/api/uploads/blob/uploads/receipt.png?token=preview',
      },
    })
    expectStatus(missingReference, 400)
    expect(missingReference.json().error.message).toContain('transaction reference')
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
    const paymentProviderId = await createPaymentProvider(admin.token, eventId)
    const emailSpy = vi.spyOn(getDeliveryAdapter('EMAIL'), 'send').mockResolvedValue({
      ok: true,
      provider: 'test',
      providerMessageId: 'payment-review-test',
      error: null,
    })

    const reserve = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: {
        name: 'Payment Guest',
        email: `payment-guard-${Date.now()}@test.tkt`,
        phone: '+20 100 123 4567',
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567',
        ticketTypeId,
        paymentProviderId,
        paymentReference: `proof-guard-${Date.now()}`,
        paymentProofUrl: '/api/uploads/blob/uploads/proof-guard.png?token=expired&exp=1',
      },
    })
    expectStatus(reserve, 201)
    const ticketId = reserve.json().data.ticketId as string
    expect(reserve.json().data.paymentStatus).toBe('PENDING')
    const listed = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/reservations?status=PENDING`,
      headers: auth(managerToken),
    })
    expectStatus(listed, 200)
    const adminRow = listed.json().data.rows.find((row: any) => row.id === ticketId)
    expect(adminRow.attendee).toMatchObject({
      gender: 'prefer_not_to_say',
      nationality: 'EG',
      identityType: 'NATIONAL_ID',
      identityNumber: '29901011234567',
    })

    const pendingWithProof = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/payments/pending`,
      headers: auth(managerToken),
    })
    expectStatus(pendingWithProof, 200)
    const reviewRow = pendingWithProof.json().data.find((p: any) => p.id === ticketId)
    expect(reviewRow?.paymentProofUrl).toContain('/api/uploads/blob/uploads/proof-guard.png?')
    expect(reviewRow?.paymentProofUrl).not.toContain('token=expired')

    const blocked = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/reservations/${ticketId}/decision`,
      headers: auth(managerToken),
      payload: { approved: true },
    })
    expectStatus(blocked, 409)
    expect(blocked.json().error.code).toBe('CONFLICT')
    expect(blocked.json().error.message).toContain('Confirm payment proof')

    const idempotencyKey = `payment-review-${Date.now()}`
    const review = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/payments/reservations/${ticketId}/review`,
      headers: { ...auth(managerToken), 'Idempotency-Key': idempotencyKey },
      payload: { action: 'CONFIRM' },
    })
    expectStatus(review, 200)
    expect(review.json().data.approval).toBe('APPROVED')
    expect(review.json().data.paymentStatus).toBe('CONFIRMED')
    expect(review.json().data.credentialId).toBeTruthy()

    const replay = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/payments/reservations/${ticketId}/review`,
      headers: { ...auth(managerToken), 'Idempotency-Key': idempotencyKey },
      payload: { action: 'CONFIRM' },
    })
    expectStatus(replay, 200)
    expect(replay.json().data.ticket.id).toBe(review.json().data.ticket.id)

    const alreadyDecided = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/reservations/${ticketId}/decision`,
      headers: auth(managerToken),
      payload: { approved: true },
    })
    expectStatus(alreadyDecided, 200)
    expect(alreadyDecided.json().data.alreadyDecided).toBe(true)

    // The QR is returned by the review call; email is queued and delivered
    // only after the response, without blocking the admin's confirmation.
    await vi.waitFor(async () => {
      const delivery = await runWithDbContext({ isInternal: true }, () =>
        prisma.credentialDeliveryAttempt.findFirst({
          where: { ticketId, channel: 'EMAIL' },
          select: { status: true },
        }),
      )
      expect(delivery?.status).toBe('SENT')
    }, { timeout: 15_000 })
    expect(emailSpy).toHaveBeenCalled()
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
    const paymentProviderId = await createPaymentProvider(admin.token, eventId)
    const email = `attendee-visible-${Date.now()}@test.tkt`

    const reserve = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: { name: 'Visible Guest', email, phone: '+20 100 123 4567',
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567',
        ticketTypeId,
        paymentProviderId,
        paymentReference: `visible-ref-${Date.now()}`,
        paymentProofUrl: '/api/uploads/blob/uploads/visible-receipt.png?token=preview',
      },
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
    const paymentProviderId = await createPaymentProvider(admin.token, eventId)
    const email = `purge-${Date.now()}@test.tkt`

    const reserve = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/reservations`,
      payload: {
        name: 'Purge Guest',
        email,
        phone: '+20 100 123 4567',
        gender: 'prefer_not_to_say',
        nationality: 'EG',
        identityNumber: '29901011234567',
        ticketTypeId,
        paymentProviderId,
        paymentReference: `purge-ref-${Date.now()}`,
        paymentProofUrl: '/api/uploads/blob/uploads/purge-receipt.png?token=preview',
      },
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

  it('serializes concurrent public holds so only one visitor can hold a seat', async () => {
    const admin = await registerUser('HoldRace')
    const orgId = await createOrg(admin.token, `Org HoldRace ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event HoldRace ${Date.now()}`)
    const manager = await registerUser('HoldRaceMgr')
    await addOrgMember(admin.token, orgId, manager.email)
    await assignStaff(admin.token, eventId, manager.userId, 'event_manager')
    const managerToken = await login(manager.email, manager.password)
    const bus = await createBus(managerToken, eventId)
    const seatId = bus.seatIds[0]
    const sessionA = `hold-race-a-${Date.now()}`
    const sessionB = `hold-race-b-${Date.now()}`

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/public/events/${eventId}/buses/${bus.id}/hold`,
        payload: { seatIds: [seatId], sessionId: sessionA, holdMinutes: 10 },
      }),
      app.inject({
        method: 'POST',
        url: `/public/events/${eventId}/buses/${bus.id}/hold`,
        payload: { seatIds: [seatId], sessionId: sessionB, holdMinutes: 10 },
      }),
    ])

    const results = [a, b]
    const winners = results.filter((result) => result.statusCode === 200)
    const conflicts = results.filter((result) => result.statusCode === 409)
    expect(winners).toHaveLength(1)
    expect(conflicts).toHaveLength(1)

    const winnerToken = winners[0].json().data.holdToken as string
    expect([sessionA, sessionB]).toContain(winnerToken)

    const stored = await runWithDbContext({ isInternal: true }, () =>
      prisma.busSeat.findUnique({ where: { id: seatId }, select: { state: true, holdToken: true } }),
    )
    expect(stored).toMatchObject({ state: 'HELD', holdToken: winnerToken })

    const released = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/buses/${bus.id}/release-hold`,
      payload: { seatIds: [seatId], sessionId: winnerToken },
    })
    expectStatus(released, 200)
    expect(released.json().data.released).toBe(1)
  })

  it('reclaims an expired hold inside the next hold transaction', async () => {
    const admin = await registerUser('HoldExpiry')
    const orgId = await createOrg(admin.token, `Org HoldExpiry ${Date.now()}`)
    cleanupOrgIds.push(orgId)
    const eventId = await createPublishedEvent(admin.token, orgId, `Event HoldExpiry ${Date.now()}`)
    const manager = await registerUser('HoldExpiryMgr')
    await addOrgMember(admin.token, orgId, manager.email)
    await assignStaff(admin.token, eventId, manager.userId, 'event_manager')
    const managerToken = await login(manager.email, manager.password)
    const bus = await createBus(managerToken, eventId)
    const seatId = bus.seatIds[0]
    const expiredSession = `hold-expired-${Date.now()}`

    const first = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/buses/${bus.id}/hold`,
      payload: { seatIds: [seatId], sessionId: expiredSession, holdMinutes: 10 },
    })
    expectStatus(first, 200)

    await runWithDbContext({ isInternal: true }, () =>
      prisma.busSeat.update({
        where: { id: seatId },
        data: { holdExpiresAt: new Date(Date.now() - 1_000) },
      }),
    )

    const nextSession = `hold-next-${Date.now()}`
    const second = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/buses/${bus.id}/hold`,
      payload: { seatIds: [seatId], sessionId: nextSession, holdMinutes: 10 },
    })
    expectStatus(second, 200)
    expect(second.json().data.holdToken).toBe(nextSession)

    const stored = await runWithDbContext({ isInternal: true }, () =>
      prisma.busSeat.findUnique({ where: { id: seatId }, select: { state: true, holdToken: true, holdExpiresAt: true } }),
    )
    expect(stored?.state).toBe('HELD')
    expect(stored?.holdToken).toBe(nextSession)
    expect(stored?.holdExpiresAt?.getTime()).toBeGreaterThan(Date.now())

    const released = await app.inject({
      method: 'POST',
      url: `/public/events/${eventId}/buses/${bus.id}/release-hold`,
      payload: { seatIds: [seatId], sessionId: nextSession },
    })
    expectStatus(released, 200)
    expect(released.json().data.released).toBe(1)
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
