// ─────────────────────────────────────────────────────────────
// ACCESS VALIDATION ENGINE — pure, testable, server-side only.
// The scanner is ONLY an interface. Every decision is made here.
//
// Validation order (spec §13):
//  1. Identify credential       6. Validate time window
//  2. Identify event            7. Validate area
//  3. Validate credential status 8. Validate operator permission
//  4. Validate ticket type       9. Single-use / re-entry policy
//  5. Validate entitlement      10. ALLOW or DENY
//                               11. Immutable access log (route)
// ─────────────────────────────────────────────────────────────

export type AccessEngineCredential = {
  id: string
  status: string
  validFrom: Date
  validUntil: Date | null
  singleUse: boolean
  allowReentry: boolean
  areaIds: unknown
  code: string
  attendeeStatus?: string
  ticketStatus?: string | null
  ticketTypeName?: string | null
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

export function validateAccess(input: {
  credential: AccessEngineCredential | null
  event: AccessEngineEvent
  area: AccessEngineArea | null
  operator: AccessEngineOperator
  now?: Date
}): AccessDecision {
  const now = input.now ?? new Date()

  // 1. Identify credential
  if (!input.credential) return deny('INVALID_CREDENTIAL')
  const c = input.credential

  // 2. Identify event — enforce LIVE (or later statuses)
  if (input.event.status !== 'LIVE' && input.event.status !== 'COMPLETED') {
    return deny('EVENT_NOT_LIVE')
  }

  // 3. Validate credential status
  if (c.status === 'REVOKED') return deny('REVOKED')
  if (c.status === 'SUSPENDED') return deny('SUSPENDED')
  if (c.status === 'CONSUMED') return deny('ALREADY_USED')
  if (c.status === 'EXPIRED') return deny('EXPIRED')

  // 4–5. Ticket & entitlement
  if (c.attendeeStatus === 'BLOCKED') return deny('ATTENDEE_BLOCKED')
  if (c.ticketStatus && c.ticketStatus !== 'ACTIVE') return deny('WRONG_TICKET_ENTITLEMENT')

  // 6. Validate time window
  const t = now.getTime()
  if (t < c.validFrom.getTime()) return deny('OUTSIDE_TIME_WINDOW')
  if (c.validUntil && t > c.validUntil.getTime()) return deny('EXPIRED')

  // 7. Validate area (policy + scope)
  if (!input.area) return deny('INVALID_CREDENTIAL')
  if (!input.area.active) return deny('AREA_INACTIVE')

  const allowedAreas = Array.isArray(c.areaIds) ? (c.areaIds as string[]) : []
  if (allowedAreas.length > 0 && !allowedAreas.includes(input.area.id)) {
    return deny('WRONG_AREA')
  }
  // Area policy gating for staff-only/restricted zones
  if (input.area.accessPolicy === 'STAFF_ONLY' || input.area.accessPolicy === 'RESTRICTED') {
    return deny('WRONG_AREA')
  }
  if (input.area.accessPolicy === 'VIP_ONLY' && !allowedAreas.includes(input.area.id)) {
    return deny('WRONG_AREA')
  }
  if (input.area.accessPolicy === 'MEDIA_ONLY' && !allowedAreas.includes(input.area.id)) {
    return deny('WRONG_AREA')
  }

  // 8. Validate operator permission — scanner may only grant in areas they control
  if (!input.operator.isSuperAdmin) {
    if (input.operator.eventScope === 'AREA' && !input.operator.areaIds.includes(input.area.id)) {
      return deny('INSUFFICIENT_PERMISSION')
    }
    if (input.operator.eventScope === 'TEAM' && !input.operator.areaIds.includes(input.area.id)) {
      return deny('INSUFFICIENT_PERMISSION')
    }
  }

  // 9. Single-use / re-entry policy (server-side consumption check happens
  //    in the route via DB state: consumed credentials arrive as CONSUMED)
  if (c.status !== 'ACTIVE') return deny('ALREADY_USED')

  // 10. ALLOW
  return { result: 'GRANTED', reason: 'NONE' }
}

function deny(reason: AccessDenyReason): AccessDecision {
  return { result: 'DENIED', reason }
}