import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/authorize.js';
import { attachSse } from '../../lib/realtime.js';
const querySchema = z.object({
    channel: z.string().regex(/^event:[a-z0-9]+:[a-z_]+$/),
});
export async function realtimeRoutes(app) {
    app.addHook('preHandler', authenticate);
    app.get('/', async (req, reply) => {
        const { channel } = querySchema.parse(req.query);
        const eventId = channel.split(':')[1];
        await requirePermission(req, 'event.view', { eventId });
        // The stream is written directly to the raw response and stays open.
        // Hijacking makes that lifecycle explicit and prevents Fastify from
        // trying to send a second response after the handler returns.
        reply.hijack();
        attachSse(reply, channel);
    });
}
//# sourceMappingURL=routes.js.map