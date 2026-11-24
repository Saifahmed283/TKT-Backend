// ─────────────────────────────────────────────────────────────
// LEGACY ROLE COMPATIBILITY (aliases + validation only)
//
// SAC used short operational role names and worker specializations. TKT uses
// permission bundles from BASE_ROLES. This module translates legacy values to
// existing TKT role codes. It never creates permissions and never promotes an
// unknown or legacy role to super_admin.
// ─────────────────────────────────────────────────────────────

import { BASE_ROLES, PERMISSIONS } from './rbac.js'

export const ROLE_ALIASES: Record<string, string> = {
  // SAC user roles -> TKT base roles
  admin: 'org_admin',
  general_manager: 'org_admin',
  superadmin: 'org_admin',
  // SAC's super_admin is organization-scoped, so it must not become TKT's
  // platform-wide super_admin.
  super_admin: 'org_admin',
  operation: 'operations_staff',
  operations: 'operations_staff',
  operations_manager: 'operations_staff',
  recruiter: 'operations_staff',
  team_leader: 'team_lead',
  team_lead: 'team_lead',
  teamlead: 'team_lead',
  team_member: 'support_staff',
  'team member': 'support_staff',
  worker: 'support_staff',
  staff: 'support_staff',

  // SAC worker specializations -> TKT base roles
  scanner: 'access_scanner',
  usher: 'usher',
  follow_up: 'support_staff',
  followup: 'support_staff',
  'follow-up': 'support_staff',
  'follow up': 'support_staff',
  supporter: 'support_staff',
  supporters: 'support_staff',
}

const CANONICAL_ROLE_CODES = new Set(BASE_ROLES.map((role) => role.code))
const VALID_SCOPES = new Set(['PLATFORM', 'ORGANIZATION', 'EVENT', 'TEAM', 'AREA'])

function normalizeRoleKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, '_')
    .replace(/_+/g, '_')
}

/** True only for an exact TKT base-role code. Used by catalog validation. */
export function isCanonicalRoleCode(value: unknown): boolean {
  return CANONICAL_ROLE_CODES.has(normalizeRoleKey(value))
}

/**
 * Resolve a legacy role string to an existing TKT role code. Null means
 * "unknown". Canonical TKT codes pass through, except `super_admin`, which is
 * deliberately downgraded to `org_admin` because SAC used that name for an
 * organization-scoped administrator.
 */
export function resolveLegacyRoleCode(value: unknown): string | null {
  const key = normalizeRoleKey(value)
  if (!key) return null

  if (CANONICAL_ROLE_CODES.has(key) && key !== 'super_admin') return key

  const aliased = ROLE_ALIASES[key] ?? ROLE_ALIASES[key.replace(/_/g, ' ')]
  if (!aliased) return null
  return CANONICAL_ROLE_CODES.has(aliased) ? aliased : null
}

/** Convenience wrapper for callers that need an empty string instead of null. */
export function normalizeLegacyRoleCode(value: unknown): string {
  return resolveLegacyRoleCode(value) ?? ''
}

/** Fails loudly on a broken static catalog, before it can seed bad permissions. */
export function assertRoleCatalogValid(): void {
  const seenCodes = new Set<string>()

  for (const role of BASE_ROLES) {
    if (seenCodes.has(role.code)) throw new Error(`Duplicate base role code: ${role.code}`)
    seenCodes.add(role.code)
    if (!VALID_SCOPES.has(role.scope)) throw new Error(`Invalid scope for role ${role.code}: ${role.scope}`)

    for (const permission of role.permissions) {
      if (!(permission in PERMISSIONS)) {
        throw new Error(`Role ${role.code} references unknown permission: ${permission}`)
      }
    }
  }

  for (const [alias, target] of Object.entries(ROLE_ALIASES)) {
    if (!CANONICAL_ROLE_CODES.has(target)) {
      throw new Error(`Legacy role alias "${alias}" targets unknown role: ${target}`)
    }
  }

  if (Object.values(ROLE_ALIASES).includes('super_admin')) {
    throw new Error('No legacy role alias may grant TKT super_admin')
  }
}
