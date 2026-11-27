// ─────────────────────────────────────────────────────────────
// ACCESS VALIDATION ENGINE — pure, testable, server-side only.
// The scanner is ONLY an interface. Every decision is made here.
//
// Validation order:
//  1. Credential exists, is intact, and belongs to this event
//  2. Event is live
//  3. Credential status is explicitly usable
//  4. Attendee and ticket are on the valid entry list
//  5. Approval and payment are settled
//  6. Time window
//  7. Area policy
//  8. Operator scope
//  9. ALLOW or DENY
//
// A denial is always fail-closed. Unknown or unexpected states are denied
// rather than treated as valid.
// ─────────────────────────────────────────────────────────────

export type AccessEngineCredential = {
  id: string
  eventId: string
  status: string
  validFrom: Date
  validUntil: Date | null
  singleUse: boolean
  allowReentry: boolean
  areaIds: unknown
  code: string
  tampered?: boolean
  attendeeStatus?: string | null
  ticketStatus?: string | null
  ticketTypeName?: string | null
  reservationApprovalStatus?: string | null
  reservationPaymentStatus?: string | null
}

export type AccessEngineEvent = {
  id: string
  status: string
}

export type AccessEngineArea = {
  id: string
  active: boolean
  accessPolicy: string
}

export type AccessEngineOperator = {
  areaIds: string[]
  eventScope: string // ORGANIZATION | EVENT | TEAM | AREA
  isSuperAdmin: boolean
}

export type AccessDecision =
  | { result: 'GRANTED'; reason: 'NONE' }
  | { result: 'DENIED'; reason: AccessDenyReason }

export type AccessDenyReason =
  | 'INVALID_CREDENTIAL'
  | 'WRONG_EVENT'
  | 'WRONG_AREA'
  | 'EXPIRED'
  | 'REVOKED'
  | 'SUSPENDED'
  | 'ALREADY_USED'
  | 'OUTSIDE_TIME_WINDOW'
  | 'WRONG_TICKET_ENTITLEMENT'
  | 'INSUFFICIENT_PERMISSION'
  | 'EVENT_NOT_LIVE'
  | 'ATTENDEE_BLOCKED'
  | 'AREA_INACTIVE'

const ADMISSIBLE_ATTENDEE_STATUSES = new Set(['REGISTERED', 'CONFIRMED', 'CHECKED_IN'])
const ADMISSIBLE_TICKET_STATUSES = new Set(['ACTIVE'])
const ADMISSIBLE_APPROVAL_STATUSES = new Set(['APPROVED', 'NONE'])
const ADMISSIBLE_PAYMENT_STATUSES = new Set(['CONFIRMED', 'NOT_REQUIRED'])

export function validateAccess(input: {
  credential: AccessEngineCredential | null
  event: AccessEngineEvent
  area: AccessEngineArea | null
  operator: AccessEngineOperator
  now?: Date
}): AccessDecision {
  const now = input.now ?? new Date()

  // 1. Credential must exist, be intact, and belong to this event.
  if (input.credential?.tampered) return deny('INVALID_CREDENTIAL')
  if (!input.credential) return deny('INVALID_CREDENTIAL')
  const c = input.credential
  if (c.eventId !== input.event.id) return deny('WRONG_EVENT')

  // 2. Event must be accepting scans.
  if (input.event.status !== 'LIVE' && input.event.status !== 'COMPLETED') {
    return deny('EVENT_NOT_LIVE')
  }

  // 3. Credential status is an explicit allowlist. Anything unexpected is denied.
  switch (String(c.status ?? '').toUpperCase()) {
    case 'ACTIVE':
      break
    case 'CONSUMED':
      return deny('ALREADY_USED')
    case 'REVOKED':
      return deny('REVOKED')
    case 'SUSPENDED':
      return deny('SUSPENDED')
    case 'EXPIRED':
      return deny('EXPIRED')
    default:
      return deny('INVALID_CREDENTIAL')
  }

  // 4. Attendee and ticket must be on the valid entry list.
  const attendeeStatus = String(c.attendeeStatus ?? '').toUpperCase()
  if (!attendeeStatus) return deny('INVALID_CREDENTIAL')
  if (attendeeStatus === 'BLOCKED') return deny('ATTENDEE_BLOCKED')
  if (!ADMISSIBLE_ATTENDEE_STATUSES.has(attendeeStatus)) {
    return deny('WRONG_TICKET_ENTITLEMENT')
  }

  const ticketStatus = String(c.ticketStatus ?? '').toUpperCase()
  if (!ADMISSIBLE_TICKET_STATUSES.has(ticketStatus)) {
    return deny('WRONG_TICKET_ENTITLEMENT')
  }

  // 5. Reservation must be settled. Normalized values are supplied by the
  //    route so legacy metadata is handled in one place.
  const approvalStatus = String(c.reservationApprovalStatus ?? '').toUpperCase()
  if (!ADMISSIBLE_APPROVAL_STATUSES.has(approvalStatus)) {
    return deny('WRONG_TICKET_ENTITLEMENT')
  }
  const paymentStatus = String(c.reservationPaymentStatus ?? '').toUpperCase()
  if (!ADMISSIBLE_PAYMENT_STATUSES.has(paymentStatus)) {
    return deny('WRONG_TICKET_ENTITLEMENT')
  }

  // 6. Validate time window.
  const t = now.getTime()
  if (t < c.validFrom.getTime()) return deny('OUTSIDE_TIME_WINDOW')
  if (c.validUntil && t > c.validUntil.getTime()) return deny('EXPIRED')

  // 7. Validate area policy.
  if (!input.area) return deny('INVALID_CREDENTIAL')
  if (!input.area.active) return deny('AREA_INACTIVE')

  const allowedAreas = Array.isArray(c.areaIds) ? (c.areaIds as string[]) : []
  if (allowedAreas.length > 0 && !allowedAreas.includes(input.area.id)) {
    return deny('WRONG_AREA')
  }
  if (['STAFF_ONLY', 'RESTRICTED', 'VIP_ONLY', 'MEDIA_ONLY'].includes(input.area.accessPolicy)) {
    if (!allowedAreas.includes(input.area.id)) return deny('WRONG_AREA')
  }

  // 8. Validate operator scope.
  if (!input.operator.isSuperAdmin) {
    if (['AREA', 'TEAM'].includes(input.operator.eventScope) && !input.operator.areaIds.includes(input.area.id)) {
      return deny('INSUFFICIENT_PERMISSION')
    }
  }

  // 9. ALLOW. Single-use consumption is performed atomically by the route.
  return { result: 'GRANTED', reason: 'NONE' }
}

function deny(reason: AccessDenyReason): AccessDecision {
  return { result: 'DENIED', reason }
}
