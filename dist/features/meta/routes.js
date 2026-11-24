import { taxonomySnapshot } from '../../config/taxonomy.js';
import { BASE_ROLES } from '../../lib/rbac.js';
/**
 * Public, read-only metadata. UIs consume this instead of duplicating enum
 * lists and labels in multiple screens.
 */
export async function metaRoutes(app) {
    app.get('/taxonomy', async () => ({
        data: {
            ...taxonomySnapshot(),
            roles: BASE_ROLES.map((role) => ({
                code: role.code,
                name: role.name,
                description: role.description,
                scope: role.scope,
            })),
        },
    }));
}
//# sourceMappingURL=routes.js.map