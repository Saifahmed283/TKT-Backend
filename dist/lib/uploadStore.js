import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { errors } from './errors.js';
const ALLOWED = new Map([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
    ['image/svg+xml', 'svg'],
    ['application/pdf', 'pdf'],
]);
export async function saveUpload(file) {
    const ext = ALLOWED.get(file.mimetype);
    if (!ext)
        throw errors.badRequest('Unsupported file type. Allowed: jpg, png, webp, gif, svg, pdf');
    const buf = await file.toBuffer();
    if (!buf.length)
        throw errors.badRequest('Empty file');
    if (buf.length > config.uploads.maxBytes)
        throw errors.badRequest('File too large');
    const dir = path.resolve(process.cwd(), config.uploads.dir);
    await fs.mkdir(dir, { recursive: true });
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    await fs.writeFile(path.join(dir, name), buf);
    const base = config.publicUrl.replace(/\/$/, '');
    return {
        url: `${base}/uploads/${name}`,
        path: `/uploads/${name}`,
        name: file.filename,
        mimeType: file.mimetype,
        size: buf.length,
    };
}
//# sourceMappingURL=uploadStore.js.map