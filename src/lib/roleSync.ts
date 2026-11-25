import { prisma } from './db.js'
import { runWithDbContext } from './dbContext.js'
import { BASE_ROLES } from './rbac.js'

/**
 * Reconcile the persisted system-role catalog with the canonical definitions.
 * Upsert is intentional: a freshly migrated database must not require a
 * separate seed command before normal role-based endpoints can operate.
 */
export async function syncSystemRoles(): Promise<void> {
  await runWithDbContext({ isInternal: true }, async () => {
    for (const role of BASE_ROLES) {
      await prisma.role.upsert({
      where: { code: role.code },
      create: {
        orgId: null,
        name: role.name,
        code: role.code,
        description: role.description,
        kind: 'SYSTEM',
        scope: role.scope,
        permissions: role.permissions as any,
        system: true,
      },
      update: {
        orgId: null,
        name: role.name,
        description: role.description,
        kind: 'SYSTEM',
        scope: role.scope,
        permissions: role.permissions as any,
        system: true,
      },
      })
    }
  })
}
