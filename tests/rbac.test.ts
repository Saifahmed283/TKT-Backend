import { describe, expect, it } from 'vitest'
import {
  BASE_ROLES,
  PERMISSIONS,
  roleByCode,
  roleHasPermission,
  hasAccess,
  type ScopeContext,
} from '../src/lib/rbac.js'

function ctx(overrides: Partial<ScopeContext> = {}): ScopeContext {
  return {
    organizationId: 'org-1',
    eventId: 'event-1',
    teamId: null,
    areaIds: [],
    eventScope: 'EVENT',
    isSuperAdmin: false,
    orgRole: 'ADMIN',
    ...overrides,
  }
}

describe('Permission catalog', () => {
  it('every catalog permission has a description', () => {
    for (const [code, desc] of Object.entries(PERMISSIONS)) {
      expect(desc.length, `permission ${code}`).toBeGreaterThan(0)
    }
  })

  it('all role permissions reference valid catalog codes', () => {
    for (const role of BASE_ROLES) {
      for (const p of role.permissions) {
        expect(PERMISSIONS[p as keyof typeof PERMISSIONS], `role ${role.code} permission ${p}`).toBeDefined()
      }
    }
  })

  it('event_manager holds all event permissions', () => {
    const em = roleByCode.get('event_manager')!
    expect(em.permissions).toContain('event.update')
    expect(em.permissions).toContain('attendee.create')
    expect(em.permissions).toContain('access.scan')
    expect(em.permissions).toContain('incident.resolve')
    expect(em.permissions).toContain('audit.view')
  })
})

describe('Role → permission evaluation', () => {
  it('user with permission → allowed', () => {
    const role = roleByCode.get('registration_staff')!
    expect(roleHasPermission(role, 'attendee.create')).toBe(true)
  })

  it('user without permission → denied', () => {
    const role = roleByCode.get('registration_staff')!
    expect(roleHasPermission(role, 'access.scan')).toBe(false)
    expect(roleHasPermission(role, 'audit.export')).toBe(false)
  })

  it('scanner has scan but not refund', () => {
    const role = roleByCode.get('access_scanner')!
    expect(roleHasPermission(role, 'access.scan')).toBe(true)
    expect(roleHasPermission(role, 'ticket.refund')).toBe(false)
  })

  it('finance staff can refund, cannot scan', () => {
    const role = roleByCode.get('finance_staff')!
    expect(roleHasPermission(role, 'refund.process')).toBe(true)
    expect(roleHasPermission(role, 'access.scan')).toBe(false)
  })
})

describe('Scope engine — WHERE the user can act', () => {
  it('event-scoped user (event manager) → allowed in entire event', () => {
    const c = ctx({ eventScope: 'EVENT' })
    expect(hasAccess(c, 'task.create', { teamId: 'team-x', areaId: 'area-x' })).toBe(true)
  })

  it('organization admin → allowed across the event', () => {
    const c = ctx({ eventScope: 'ORGANIZATION' })
    expect(hasAccess(c, 'event.publish')).toBe(true)
  })

  it('team-scoped user (team lead) → allowed inside own team', () => {
    const c = ctx({ eventScope: 'TEAM', teamId: 'team-1', areaIds: ['area-1'] })
    expect(hasAccess(c, 'task.create', { teamId: 'team-1' })).toBe(true)
  })

  it('team-scoped user → denied outside own team', () => {
    const c = ctx({ eventScope: 'TEAM', teamId: 'team-1', areaIds: ['area-1'] })
    expect(hasAccess(c, 'task.update', { teamId: 'team-2' })).toBe(false)
  })

  it('area-scoped user (scanner) → allowed in assigned area', () => {
    const c = ctx({ eventScope: 'AREA', areaIds: ['area-main'] })
    expect(hasAccess(c, 'access.scan', { areaId: 'area-main' })).toBe(true)
  })

  it('area-scoped user → denied in unassigned area', () => {
    const c = ctx({ eventScope: 'AREA', areaIds: ['area-main'] })
    expect(hasAccess(c, 'access.scan', { areaId: 'area-vip' })).toBe(false)
  })

  it('narrow scopes → denied on event-wide resources with no target', () => {
    const team = ctx({ eventScope: 'TEAM', teamId: 'team-1', areaIds: ['area-1'] })
    const area = ctx({ eventScope: 'AREA', areaIds: ['area-main'] })
    expect(hasAccess(team, 'attendee.view')).toBe(false)
    expect(hasAccess(area, 'report.view')).toBe(false)
  })

  it('area-scoped user → denied team targets', () => {
    const c = ctx({ eventScope: 'AREA', areaIds: ['area-main'] })
    expect(hasAccess(c, 'task.view', { teamId: 'team-1' })).toBe(false)
  })

  it('super admin → allowed everywhere', () => {
    const c = ctx({ isSuperAdmin: true, eventScope: 'ORGANIZATION' })
    expect(hasAccess(c, 'platform.audit', { areaId: 'anything' })).toBe(true)
  })
})