import { describe, expect, it } from 'vitest'
import {
  validateAccess,
  type AccessEngineArea,
  type AccessEngineCredential,
  type AccessEngineEvent,
  type AccessEngineOperator,
  type AccessDenyReason,
} from './access-engine.js'

const eventId = 'event-1'
const areaId = 'area-1'
const now = new Date('2026-06-01T12:00:00.000Z')

const event: AccessEngineEvent = { id: eventId, status: 'LIVE' }
const area: AccessEngineArea = { id: areaId, active: true, accessPolicy: 'OPEN' }
const operator: AccessEngineOperator = { areaIds: [], eventScope: 'ORGANIZATION', isSuperAdmin: false }

function credential(overrides: Partial<AccessEngineCredential> = {}): AccessEngineCredential {
  return {
    id: 'cred-1',
    eventId,
    status: 'ACTIVE',
    validFrom: new Date('2026-06-01T11:00:00.000Z'),
    validUntil: null,
    singleUse: true,
    allowReentry: false,
    areaIds: [],
    code: 'TKT-TEST',
    attendeeStatus: 'CONFIRMED',
    ticketStatus: 'ACTIVE',
    reservationApprovalStatus: 'APPROVED',
    reservationPaymentStatus: 'CONFIRMED',
    ...overrides,
  }
}

function decisionFor(overrides: Partial<AccessEngineCredential> = {}) {
  return validateAccess({ credential: credential(overrides), event, area, operator, now })
}

function expectDeny(overrides: Partial<AccessEngineCredential>, reason: AccessDenyReason) {
  expect(decisionFor(overrides)).toEqual({ result: 'DENIED', reason })
}

describe('gate access engine', () => {
  it('grants a settled single-use pass at an open gate', () => {
    expect(decisionFor()).toEqual({ result: 'GRANTED', reason: 'NONE' })
  })

  it('denies an unknown or tampered QR', () => {
    expect(validateAccess({ credential: null, event, area, operator, now }))
      .toEqual({ result: 'DENIED', reason: 'INVALID_CREDENTIAL' })
    expect(decisionFor({ tampered: true }))
      .toEqual({ result: 'DENIED', reason: 'INVALID_CREDENTIAL' })
  })

  it('denies a QR that belongs to another event', () => {
    expect(decisionFor({ eventId: 'event-2' }))
      .toEqual({ result: 'DENIED', reason: 'WRONG_EVENT' })
  })

  it('denies redeemed, revoked, suspended, expired, and unexpected credential states', () => {
    expectDeny({ status: 'CONSUMED' }, 'ALREADY_USED')
    expectDeny({ status: 'REVOKED' }, 'REVOKED')
    expectDeny({ status: 'SUSPENDED' }, 'SUSPENDED')
    expectDeny({ status: 'EXPIRED' }, 'EXPIRED')
    expectDeny({ status: 'ISSUED' }, 'INVALID_CREDENTIAL')
    expectDeny({ status: 'SOMETHING_ELSE' }, 'INVALID_CREDENTIAL')
  })

  it('denies banned and not-on-the-list attendees', () => {
    expectDeny({ attendeeStatus: 'BLOCKED' }, 'ATTENDEE_BLOCKED')
    expectDeny({ attendeeStatus: 'WAITLISTED' }, 'WRONG_TICKET_ENTITLEMENT')
    expectDeny({ attendeeStatus: 'CANCELLED' }, 'WRONG_TICKET_ENTITLEMENT')
    expectDeny({ attendeeStatus: 'INVITED' }, 'WRONG_TICKET_ENTITLEMENT')
    expectDeny({ attendeeStatus: null }, 'INVALID_CREDENTIAL')
  })

  it('denies unusable tickets and unsettled reservations', () => {
    expectDeny({ ticketStatus: 'CANCELLED' }, 'WRONG_TICKET_ENTITLEMENT')
    expectDeny({ ticketStatus: 'REFUNDED' }, 'WRONG_TICKET_ENTITLEMENT')
    expectDeny({ ticketStatus: null }, 'WRONG_TICKET_ENTITLEMENT')
    expectDeny({ reservationApprovalStatus: 'PENDING' }, 'WRONG_TICKET_ENTITLEMENT')
    expectDeny({ reservationApprovalStatus: 'REJECTED' }, 'WRONG_TICKET_ENTITLEMENT')
    expectDeny({ reservationPaymentStatus: 'PENDING' }, 'WRONG_TICKET_ENTITLEMENT')
    expectDeny({ reservationPaymentStatus: 'FAILED' }, 'WRONG_TICKET_ENTITLEMENT')
    expectDeny({ reservationPaymentStatus: 'REFUNDED' }, 'WRONG_TICKET_ENTITLEMENT')
  })

  it('denies passes outside their time window', () => {
    expectDeny({ validFrom: new Date('2026-06-01T13:00:00.000Z') }, 'OUTSIDE_TIME_WINDOW')
    expectDeny({ validUntil: new Date('2026-06-01T11:30:00.000Z') }, 'EXPIRED')
  })

  it('denies wrong, inactive, and restricted gate areas', () => {
    expect(validateAccess({
      credential: credential(),
      event,
      area: null,
      operator,
      now,
    })).toEqual({ result: 'DENIED', reason: 'INVALID_CREDENTIAL' })

    expect(validateAccess({
      credential: credential(),
      event,
      area: { ...area, active: false },
      operator,
      now,
    })).toEqual({ result: 'DENIED', reason: 'AREA_INACTIVE' })

    expectDeny({ areaIds: ['area-2'] }, 'WRONG_AREA')

    expect(validateAccess({
      credential: credential(),
      event,
      area: { ...area, accessPolicy: 'VIP_ONLY' },
      operator,
      now,
    })).toEqual({ result: 'DENIED', reason: 'WRONG_AREA' })
  })

  it('denies an operator scoped to a different area', () => {
    expect(validateAccess({
      credential: credential(),
      event,
      area,
      operator: { areaIds: ['area-2'], eventScope: 'AREA', isSuperAdmin: false },
      now,
    })).toEqual({ result: 'DENIED', reason: 'INSUFFICIENT_PERMISSION' })
  })

  it('denies scans when the event is not live', () => {
    expect(validateAccess({
      credential: credential(),
      event: { ...event, status: 'PUBLISHED' },
      area,
      operator,
      now,
    })).toEqual({ result: 'DENIED', reason: 'EVENT_NOT_LIVE' })
  })
})
