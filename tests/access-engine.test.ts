import { describe, expect, it } from 'vitest'
import { validateAccess } from '../src/lib/access-engine.js'
import type { AccessEngineCredential, AccessEngineEvent, AccessEngineArea, AccessEngineOperator } from '../src/lib/access-engine.js'

function makeCredential(overrides: Partial<AccessEngineCredential> = {}): AccessEngineCredential {
  return {
    id: 'cred-1',
    status: 'ACTIVE',
    validFrom: new Date('2026-01-01T08:00:00Z'),
    validUntil: new Date('2026-01-01T22:00:00Z'),
    singleUse: true,
    allowReentry: false,
    areaIds: ['area-main', 'area-hall'],
    code: 'TKT1.xxx',
    attendeeStatus: 'CONFIRMED',
    ticketStatus: 'ACTIVE',
    ticketTypeName: 'General Admission',
    ...overrides,
  }
}

const event: AccessEngineEvent = { id: 'event-1', status: 'LIVE' }
const mainGate: AccessEngineArea = { id: 'area-main', active: true, accessPolicy: 'TICKETED' }
const vipGate: AccessEngineArea = { id: 'area-vip', active: true, accessPolicy: 'VIP_ONLY' }
const staffArea: AccessEngineArea = { id: 'area-staff', active: true, accessPolicy: 'STAFF_ONLY' }
const operator: AccessEngineOperator = {
  areaIds: ['area-main'],
  eventScope: 'AREA',
  isSuperAdmin: false,
}

const scan = (cred: AccessEngineCredential | null, area: AccessEngineArea | null = mainGate, op: AccessEngineOperator = operator, now = new Date('2026-01-01T12:00:00Z')) =>
  validateAccess({ credential: cred, event, area, operator: op, now })

describe('Access validation engine — spec §41 authorization matrix', () => {
  it('valid credential + correct area + permission → ALLOWED', () => {
    const d = scan(makeCredential())
    expect(d.result).toBe('GRANTED')
  })

  it('unknown/forged credential → DENIED (INVALID_CREDENTIAL)', () => {
    const d = scan(null)
    expect(d).toEqual({ result: 'DENIED', reason: 'INVALID_CREDENTIAL' })
  })

  it('expired credential → DENIED (EXPIRED)', () => {
    const d = scan(makeCredential({ validUntil: new Date('2025-01-01T00:00:00Z') }))
    expect(d.reason).toBe('EXPIRED')
  })

  it('not yet valid → DENIED (OUTSIDE_TIME_WINDOW)', () => {
    const d = scan(makeCredential({ validFrom: new Date('2026-02-01T00:00:00Z') }))
    expect(d.reason).toBe('OUTSIDE_TIME_WINDOW')
  })

  it('revoked credential → DENIED (REVOKED)', () => {
    const d = scan(makeCredential({ status: 'REVOKED' }))
    expect(d.reason).toBe('REVOKED')
  })

  it('suspended credential → DENIED (SUSPENDED)', () => {
    const d = scan(makeCredential({ status: 'SUSPENDED' }))
    expect(d.reason).toBe('SUSPENDED')
  })

  it('consumed credential → DENIED (ALREADY_USED)', () => {
    const d = scan(makeCredential({ status: 'CONSUMED' }))
    expect(d.reason).toBe('ALREADY_USED')
  })

  it('wrong ticket entitlement (cancelled ticket) → DENIED', () => {
    const d = scan(makeCredential({ ticketStatus: 'CANCELLED' }))
    expect(d.reason).toBe('WRONG_TICKET_ENTITLEMENT')
  })

  it('blocked attendee → DENIED (ATTENDEE_BLOCKED)', () => {
    const d = scan(makeCredential({ attendeeStatus: 'BLOCKED' }))
    expect(d.reason).toBe('ATTENDEE_BLOCKED')
  })

  it('wrong area (credential not entitled) → DENIED (WRONG_AREA)', () => {
    const d = scan(makeCredential(), vipGate)
    expect(d.reason).toBe('WRONG_AREA')
  })

  it('VIP_ONLY policy rejects non-VIP credential → DENIED (WRONG_AREA)', () => {
    const d = scan(makeCredential({ areaIds: ['area-main'] }), vipGate)
    expect(d.reason).toBe('WRONG_AREA')
  })

  it('STAFF_ONLY policy rejects attendee credential → DENIED (WRONG_AREA)', () => {
    const d = scan(makeCredential({ areaIds: ['area-main', 'area-staff'] }), staffArea)
    expect(d.reason).toBe('WRONG_AREA')
  })

  it('operator without area scope cannot scan an area they do not control → DENIED', () => {
    const stranger: AccessEngineOperator = { areaIds: ['area-other'], eventScope: 'AREA', isSuperAdmin: false }
    const d = scan(makeCredential(), mainGate, stranger)
    expect(d.reason).toBe('INSUFFICIENT_PERMISSION')
  })

  it('operator with event scope can scan any area', () => {
    const manager: AccessEngineOperator = { areaIds: [], eventScope: 'EVENT', isSuperAdmin: false }
    const vipCred = makeCredential({ areaIds: ['area-main', 'area-hall', 'area-vip'] })
    const d = scan(vipCred, vipGate, manager)
    expect(d.result).toBe('GRANTED')
  })

  it('super admin bypasses operator scope restrictions', () => {
    const admin: AccessEngineOperator = { areaIds: [], eventScope: 'AREA', isSuperAdmin: true }
    const vipCred = makeCredential({ areaIds: ['area-main', 'area-hall', 'area-vip'] })
    const d = scan(vipCred, vipGate, admin)
    expect(d.result).toBe('GRANTED')
  })

  it('event not LIVE → DENIED (EVENT_NOT_LIVE)', () => {
    const d = validateAccess({
      credential: makeCredential(),
      event: { id: 'event-1', status: 'PLANNING' },
      area: mainGate,
      operator,
      now: new Date('2026-01-01T12:00:00Z'),
    })
    expect(d.reason).toBe('EVENT_NOT_LIVE')
  })

  it('inactive area → DENIED (AREA_INACTIVE)', () => {
    const d = scan(makeCredential(), { ...mainGate, active: false })
    expect(d.reason).toBe('AREA_INACTIVE')
  })

  it('re-entry: credential with allowReentry stays usable', () => {
    const cred = makeCredential({ allowReentry: true, singleUse: false })
    const first = scan(cred)
    const second = scan({ ...cred, status: 'ACTIVE' })
    expect(first.result).toBe('GRANTED')
    expect(second.result).toBe('GRANTED')
  })
})