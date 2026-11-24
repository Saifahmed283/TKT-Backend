import { errors } from '../../lib/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { saveUpload } from '../../lib/uploadStore.js';
export async function uploadRoutes(app) {
    app.post('/', { preHandler: authenticate }, async (req) => {
        const file = await req.file();
        if (!file)
            throw errors.badRequest('No file uploaded');
        return { data: await saveUpload(file) };
    });
    app.post('/proof', async (req) => {
        const file = await req.file();
        if (!file)
            throw errors.badRequest('No file uploaded');
        return { data: await saveUpload(file) };
    });
}
//# sourceMappingURL=routes.js.map