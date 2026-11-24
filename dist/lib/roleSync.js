import { prisma } from './db.js';
import { BASE_ROLES } from './rbac.js';
export async function syncSystemRoles() {
    await prisma.$executeRaw `SELECT set_config('app.is_internal', 'true', false)`;
    for (const role of BASE_ROLES) {
        await prisma.role.updateMany({
            where: { code: role.code, system: true },
            data: {
                name: role.name,
                description: role.description,
                scope: role.scope,
                permissions: role.permissions,
            },
        });
    }
}
//# sourceMappingURL=roleSync.js.map