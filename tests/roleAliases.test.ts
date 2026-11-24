import { describe, expect, it } from 'vitest'
import {
  ROLE_ALIASES,
  assertRoleCatalogValid,
  isCanonicalRoleCode,
  normalizeLegacyRoleCode,
  resolveLegacyRoleCode,
} from '../src/lib/roleAliases.js'
import { BASE_ROLES, PERMISSIONS } from '../src/lib/rbac.js'

describe('legacy role aliases', () => {
  it('maps SAC roles to existing TKT role codes', () => {
    expect(resolveLegacyRoleCode('admin')).toBe('org_admin')
    expect(resolveLegacyRoleCode('general_manager')).toBe('org_admin')
    expect(resolveLegacyRoleCode('operation')).toBe('operations_staff')
    expect(resolveLegacyRoleCode('recruiter')).toBe('operations_staff')
    expect(resolveLegacyRoleCode('team_leader')).toBe('team_lead')
    expect(resolveLegacyRoleCode('worker')).toBe('support_staff')
  })

  it('maps SAC worker specializations', () => {
    expect(resolveLegacyRoleCode('scanner')).toBe('access_scanner')
    expect(resolveLegacyRoleCode('usher')).toBe('usher')
    expect(resolveLegacyRoleCode('follow_up')).toBe('support_staff')
    expect(resolveLegacyRoleCode('follow-up')).toBe('support_staff')
    expect(resolveLegacyRoleCode('supporter')).toBe('support_staff')
  })

  it('never promotes a legacy alias to super_admin', () => {
    expect(resolveLegacyRoleCode('admin')).not.toBe('super_admin')
    expect(resolveLegacyRoleCode('superadmin')).not.toBe('super_admin')
    expect(resolveLegacyRoleCode('super_admin')).toBe('org_admin')
    expect(Object.values(ROLE_ALIASES)).not.toContain('super_admin')
    // The canonical code is still recognized by catalog validation.
    expect(isCanonicalRoleCode('super_admin')).toBe(true)
  })

  it('returns null/empty for unknown roles instead of guessing', () => {
    expect(resolveLegacyRoleCode('mystery_role')).toBeNull()
    expect(resolveLegacyRoleCode('')).toBeNull()
    expect(normalizeLegacyRoleCode('mystery_role')).toBe('')
  })

  it('normalizes casing and separators', () => {
    expect(resolveLegacyRoleCode(' Team Lead ')).toBe('team_lead')
    expect(resolveLegacyRoleCode('Follow-Up')).toBe('support_staff')
  })
})

describe('static role catalog validation', () => {
  it('does not throw for the shipped catalog', () => {
    expect(() => assertRoleCatalogValid()).not.toThrow()
  })

  it('every permission used by a role exists in the catalog', () => {
    for (const role of BASE_ROLES) {
      for (const permission of role.permissions) {
        expect(permission in PERMISSIONS, `${role.code}:${permission}`).toBe(true)
      }
    }
  })

  it('every alias target is an existing base role', () => {
    const codes = new Set(BASE_ROLES.map((role) => role.code))
    for (const [alias, target] of Object.entries(ROLE_ALIASES)) {
      expect(codes.has(target), `${alias} -> ${target}`).toBe(true)
    }
  })
})
