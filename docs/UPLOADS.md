# Upload storage

Production uploads use [Vercel Blob private storage](https://vercel.com/docs/vercel-blob/private-storage).
Serverless local disk is ephemeral, so `BLOB_READ_WRITE_TOKEN` is required when
`NODE_ENV=production`; the API fails fast with `503 UPLOAD_STORE_UNAVAILABLE` if
it is missing. `BLOB_STORE_ID` is used when deleting private blobs.

Development and tests keep the previous local-disk behaviour when no token is
set. Uploaded bytes are checked against magic bytes before storage, and the
declared MIME type must match the detected type.

## Private proof links

`put()` stores each proof with `access: 'private'`. The API returns a
capability link like `/api/uploads/blob/uploads/<file>?token=<hmac>` instead of
a public Blob URL. `GET /uploads/blob/*` verifies the HMAC and streams the blob
with `get(..., { access: 'private' })`. The blob is never publicly readable, but
anyone holding the full link can view it — treat stored proof URLs as sensitive.
`refreshProofUrl()` re-signs stored capability links when review APIs return
them, so an expired `UPLOAD_PROOF_TTL` does not break an older proof preview.

The frontend must be able to reach this endpoint. With the default
`VITE_API_BASE=/api`, either deploy the frontend and backend behind one Vercel
project rewrite for `/api/*`, or set `VITE_API_BASE` to the backend's absolute
API URL at build time. The frontend `vercel.json` SPA fallback deliberately
excludes `/api/` so it cannot shadow that rewrite.

## Migrating existing local uploads

Files already in `Backend/uploads/` are not copied automatically. Upload them
to the Blob store with the same key (`uploads/<filename>`), then replace stored
database URLs with the signed proxy link. `proofUrl()` in
`src/lib/uploadStore.ts` builds the link from the stored key.

```bash
BLOB_READ_WRITE_TOKEN=... node --input-type=module -e "
import fs from 'node:fs/promises';
import path from 'node:path';
import { put } from '@vercel/blob';
const dir = 'uploads';
for (const name of await fs.readdir(dir)) {
  const file = path.join(dir, name);
  if (!(await fs.stat(file)).isFile()) continue;
  const result = await put('uploads/' + name, await fs.readFile(file), {
    access: 'private',
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  console.log(name, result.pathname);
}
"
```

The purge job deletes private Blob objects for proxy URLs and legacy private
Blob URLs under the configured store's `/uploads/` prefix. Old relative URLs
are handled as local files.
