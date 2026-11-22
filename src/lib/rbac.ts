// ─────────────────────────────────────────────────────────────
// ATOMIC PERMISSION CATALOG
// Each permission answers: WHAT can the user do?
// Scope answers: WHERE can they do it? (see scope.ts)
// ─────────────────────────────────────────────────────────────

export const PERMISSIONS = {
  // Platform
  'platform.manage': 'Full platform-level control',
  'platform.analytics': 'View platform analytics and health',
  'platform.audit': 'View platform-wide audit logs',

  // Organization
  'org.view': 'View organization',
  'org.update': 'Update organization settings',
  'org.policies': 'Manage organization policies',
  'org.members.view': 'View organization members',
  'org.members.invite': 'Invite organization members',
  'org.members.remove': 'Remove organization members',
  'org.roles.view': 'View organization roles',
  'org.roles.manage': 'Manage organization roles and permissions',
  'org.analytics': 'View organization analytics',
  'org.integrations': 'Manage integrations',

  // Events
  'event.view': 'View event',
  'event.create': 'Create events',
  'event.update': 'Update event configuration',
  'event.publish': 'Publish event',
  'event.archive': 'Archive event',
  'event.settings': 'Manage event settings',
  'event.members.view': 'View event staff',
  'event.members.assign': 'Assign staff to event',
  'event.members.remove': 'Remove staff from event',

  // Teams & staff
  'team.view': 'View teams',
  'team.create': 'Create teams',
  'team.update': 'Update teams',
  'team.delete': 'Delete teams',
  'team.assign_member': 'Assign members to teams',
  'staff.view': 'View staff',
  'staff.assign': 'Assign staff',
  'staff.remove': 'Remove staff',

  // Areas
  'area.view': 'View areas',
  'area.create': 'Create areas',
  'area.update': 'Update areas',
  'area.delete': 'Delete areas',
  'area.assign': 'Assign staff/teams to areas',

  // Attendees
  'attendee.view': 'View attendees',
  'attendee.create': 'Register attendees',
  'attendee.update': 'Update attendees',
  'attendee.export': 'Export attendee data',

  // Tickets
  'ticket.view': 'View tickets',
  'ticket.issue': 'Issue tickets',
  'ticket.cancel': 'Cancel tickets',
  'ticket.refund': 'Process refunds',

  // Credentials
  'credential.view': 'View credentials',
  'credential.issue': 'Issue credentials',
  'credential.suspend': 'Suspend credentials',
  'credential.revoke': 'Revoke credentials',
  'credential.export': 'Export credentials',

  // Access codes / VIP / guest controls
  'access_code.view': 'View access codes',
  'access_code.create': 'Create access codes',
  'access_code.update': 'Update access codes',
  'access_code.revoke': 'Revoke access codes',
  'access_code.redeem': 'Redeem access codes',

  // Access
  'access.scan': 'Scan credentials',
  'access.validate': 'Validate access decisions',
  'access.override': 'Override access decisions',
  'access.revoke': 'Revoke access',
  'access.logs.view': 'View access logs',

  // Devices / scan ops
  'device.view': 'View devices',
  'device.manage': 'Register and manage devices',
  'device.heartbeat': 'Send device heartbeat',

  // Tasks
  'task.view': 'View tasks',
  'task.create': 'Create tasks',
  'task.update': 'Update tasks',
  'task.assign': 'Assign tasks',
  'task.complete': 'Complete tasks',
  'task.delete': 'Delete tasks',

  // Incidents
  'incident.view': 'View incidents',
  'incident.create': 'Create incidents',
  'incident.update': 'Update incidents',
  'incident.assign': 'Assign incidents',
  'incident.escalate': 'Escalate incidents',
  'incident.resolve': 'Resolve incidents',

  // Communications
  'message.send': 'Send messages',
  'announcement.publish': 'Publish announcements',
  'notification.read': 'Read notifications',

  // Reporting & audit
  'report.view': 'View reports',
  'report.export': 'Export reports',
  'audit.view': 'View audit logs',
  'audit.export': 'Export audit logs',

  // Schedule
  'schedule.view': 'View schedule',
  'schedule.update': 'Manage schedule',

  // Finance
  'payment.view': 'View payments',
  'expense.create': 'Create expenses',
  'refund.process': 'Process refunds',

  // Workforce / recruitment / ID ops
  'workforce.view': 'View workforce and recruitment records',
  'workforce.manage': 'Manage workforce applications and staff profiles',
  'workforce.convert': 'Convert recruitment applicants into staff',
  'workforce.id.issue': 'Issue staff ID tokens/cards',

  // Integrations / extras
  'integration.view': 'View integrations and event extras',
  'integration.manage': 'Manage integrations and event extras',
} as const

export type Permission = keyof typeof PERMISSIONS
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[]

// ─────────────────────────────────────────────────────────────
// BASE ROLE CATALOG
// Roles are NOT hardcoded authorization — they are permission
// bundles. Custom roles can be created per-organization.
// ─────────────────────────────────────────────────────────────

export type BaseRoleDefinition = {
  code: string
  name: string
  description: string
  scope: 'PLATFORM' | 'ORGANIZATION' | 'EVENT' | 'TEAM' | 'AREA'
  permissions: Permission[]
}

const eventReadBase: Permission[] = ['event.view', 'event.members.view', 'staff.view']
const opsReadBase: Permission[] = ['task.view', 'area.view', 'team.view', 'schedule.view']
const incidentBase: Permission[] = ['incident.view', 'incident.create', 'incident.update']
const commsBase: Permission[] = ['notification.read']

export const BASE_ROLES: BaseRoleDefinition[] = [
  {
    code: 'super_admin',
    name: 'Super Admin',
    description: 'Full platform-level control across all organizations.',
    scope: 'PLATFORM',
    permissions: ALL_PERMISSIONS,
  },
  {
    code: 'org_admin',
    name: 'Organization Admin',
    description: 'Controls one organization and all of its events.',
    scope: 'ORGANIZATION',
    permissions: ALL_PERMISSIONS,
  },
  {
    code: 'org_viewer',
    name: 'Organization Viewer',
    description: 'Read-only organization access.',
    scope: 'ORGANIZATION',
    permissions: [
      'org.view',
      'org.members.view',
      'org.roles.view',
      'org.analytics',
      'event.view',
      'event.members.view',
      'staff.view',
      'team.view',
      'area.view',
      'attendee.view',
      'ticket.view',
      'credential.view',
      'access.logs.view',
      'task.view',
      'incident.view',
      'report.view',
      'audit.view',
      'schedule.view',
    ],
  },
  {
    code: 'event_manager',
    name: 'Event Manager',
    description: 'Full operational control of an assigned event.',
    scope: 'EVENT',
    permissions: ALL_PERMISSIONS,
  },
  {
    code: 'team_lead',
    name: 'Team Lead',
    description: 'Controls an assigned team: assigns tasks, monitors activity, escalates incidents.',
    scope: 'TEAM',
    permissions: [
      ...eventReadBase,
      ...opsReadBase,
      'staff.view',
      'team.view',
      'task.create',
      'task.update',
      'task.assign',
      'task.complete',
      'incident.create',
      'incident.update',
      'incident.assign',
      'incident.escalate',
      'incident.resolve',
      'attendee.view',
      'workforce.view',
      'workforce.manage',
      'workforce.id.issue',
      'integration.view',
      'integration.manage',
      'message.send',
      'announcement.publish',
      'report.view',
      'notification.read',
      'area.view',
      'device.view',
      'schedule.view',
    ],
  },
  {
    code: 'registration_staff',
    name: 'Registration Staff',
    description: 'Attendee registration, search, updates and badge operations.',
    scope: 'EVENT',
    permissions: [
      ...eventReadBase,
      'attendee.view',
      'attendee.create',
      'attendee.update',
      'ticket.view',
      'ticket.issue',
      'credential.view',
      'credential.issue',
      'credential.suspend',
      'access_code.view',
      'access_code.create',
      'access_code.update',
      'access_code.redeem',
      'incident.create',
      'incident.update',
      'message.send',
      'notification.read',
      'schedule.view',
    ],
  },
  {
    code: 'access_scanner',
    name: 'Access / Scanner Staff',
    description: 'Scans credentials and validates access in assigned areas.',
    scope: 'AREA',
    permissions: [
      ...eventReadBase,
      'access.scan',
      'access.logs.view',
      'credential.view',
      'attendee.view',
      'area.view',
      'device.view',
      'device.heartbeat',
      'incident.create',
      'notification.read',
      'schedule.view',
    ],
  },
  {
    code: 'usher',
    name: 'Usher / Guest Services',
    description: 'Guest guidance, seating and attendee assistance.',
    scope: 'AREA',
    permissions: [
      ...eventReadBase,
      'attendee.view',
      'area.view',
      'incident.create',
      'incident.update',
      'message.send',
      'notification.read',
      'schedule.view',
    ],
  },
  {
    code: 'support_staff',
    name: 'Support Staff',
    description: 'Help desk, attendee problems, support incidents.',
    scope: 'EVENT',
    permissions: [
      ...eventReadBase,
      'attendee.view',
      'attendee.update',
      'incident.create',
      'incident.update',
      'incident.resolve',
      'message.send',
      'notification.read',
      'schedule.view',
    ],
  },
  {
    code: 'security_staff',
    name: 'Security Staff',
    description: 'Access control, restricted zones and security incidents.',
    scope: 'AREA',
    permissions: [
      ...eventReadBase,
      'access.scan',
      'access.logs.view',
      'area.view',
      'incident.create',
      'incident.update',
      'incident.escalate',
      'message.send',
      'notification.read',
      'schedule.view',
    ],
  },
  {
    code: 'operations_staff',
    name: 'Operations Staff',
    description: 'Venue operations, logistics, setup and teardown.',
    scope: 'EVENT',
    permissions: [
      ...eventReadBase,
      ...opsReadBase,
      'task.create',
      'task.update',
      'task.complete',
      'incident.create',
      'incident.update',
      'message.send',
      'notification.read',
      'schedule.view',
    ],
  },
  {
    code: 'technical_staff',
    name: 'Technical Staff',
    description: 'AV, IT, lighting, sound and production.',
    scope: 'EVENT',
    permissions: [
      ...eventReadBase,
      ...opsReadBase,
      'task.create',
      'task.update',
      'task.complete',
      'incident.create',
      'incident.update',
      'incident.resolve',
      'message.send',
      'notification.read',
      'schedule.view',
    ],
  },
  {
    code: 'medical_staff',
    name: 'Medical Staff',
    description: 'First aid, emergency response and medical incidents.',
    scope: 'EVENT',
    permissions: [
      ...eventReadBase,
      'incident.create',
      'incident.update',
      'incident.assign',
      'incident.escalate',
      'incident.resolve',
      'task.update',
      'task.complete',
      'message.send',
      'notification.read',
      'schedule.view',
    ],
  },
  {
    code: 'media_staff',
    name: 'Media Staff',
    description: 'Photography, video, press and media credentials.',
    scope: 'AREA',
    permissions: [
      ...eventReadBase,
      'credential.view',
      'attendee.view',
      'area.view',
      'incident.create',
      'message.send',
      'notification.read',
      'schedule.view',
    ],
  },
  {
    code: 'finance_staff',
    name: 'Finance Staff',
    description: 'Payments, expenses, refunds and financial reports.',
    scope: 'EVENT',
    permissions: [
      ...eventReadBase,
      'payment.view',
      'expense.create',
      'refund.process',
      'ticket.view',
      'report.view',
      'report.export',
      'notification.read',
    ],
  },
  {
    code: 'speaker_vip_coordinator',
    name: 'Speaker / VIP Coordinator',
    description: 'Speakers, VIP guests and VIP logistics.',
    scope: 'EVENT',
    permissions: [
      ...eventReadBase,
      'attendee.view',
      'attendee.update',
      'credential.view',
      'credential.issue',
      'access_code.view',
      'access_code.create',
      'access_code.update',
      'access_code.revoke',
      'access_code.redeem',
      'area.view',
      'schedule.view',
      'schedule.update',
      'incident.create',
      'incident.update',
      'message.send',
      'notification.read',
    ],
  },
]

export const roleByCode = new Map(BASE_ROLES.map((r) => [r.code, r]))

// ─────────────────────────────────────────────────────────────
// EVALUATION
// ─────────────────────────────────────────────────────────────

export function roleHasPermission(role: { permissions: unknown; scope: string }, permission: Permission): boolean {
  const perms = Array.isArray(role.permissions) ? (role.permissions as string[]) : []
  return perms.includes(permission)
}

export type ScopeContext = {
  organizationId: string
  eventId: string
  teamId?: string | null
  areaIds: string[]
  eventScope: 'ORGANIZATION' | 'EVENT' | 'TEAM' | 'AREA'
  isSuperAdmin: boolean
  orgRole: string | null
}

export const EVENT_LEVEL_SCOPES = new Set(['EVENT', 'TEAM', 'AREA'])

/**
 * Resolves whether a context satisfies a permission + optional scope target.
 *
 * - PLATFORM roles (super admin) → always allowed
 * - ORGANIZATION scope roles → allowed for any resource under the org
 * - EVENT scope roles → allowed anywhere in the event
 * - TEAM scope roles → allowed only within their assigned team
 * - AREA scope roles → allowed only within their assigned areas
 */
export function hasAccess(
  ctx: ScopeContext,
  permission: Permission,
  target?: { teamId?: string | null; areaId?: string | null },
): boolean {
  if (ctx.isSuperAdmin) return true
  if (!ctx.eventScope) return false

  if (ctx.eventScope === 'ORGANIZATION') return true

  if (ctx.eventScope === 'EVENT') return true

  if (ctx.eventScope === 'TEAM') {
    if (!ctx.teamId) return false
    if (target?.teamId && target.teamId !== ctx.teamId) return false
    if (target?.areaId) return ctx.areaIds.includes(target.areaId)
    return true
  }

  // AREA scope
  if (target?.areaId) return ctx.areaIds.includes(target.areaId)
  if (target?.teamId) return false
  return true
}