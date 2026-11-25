# Upload storage

Production uploads use [Vercel Blob](https://vercel.com/docs/blob). Serverless local
disk is ephemeral, so `BLOB_READ_WRITE_TOKEN` is required when `NODE_ENV=production`;
the API fails fast with `503 UPLOAD_STORE_UNAVAILABLE` if it is missing.

Development and tests keep the previous local-disk behaviour when no token is
set. Uploaded bytes are checked against magic bytes before storage, and the
declared MIME type must match the detected type.

## Migrating existing local uploads

Files already in `Backend/uploads/` are not copied automatically. Upload them
to the Blob store with the same key (`uploads/<filename>`), then update any
stored database URLs that still use a relative `/uploads/...` path to the
absolute Blob URL returned by `put()`:

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
    access: 'public',
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  console.log(name, result.url);
}
"
```

The purge job deletes Blob objects for URLs under the configured store's
`/uploads/` prefix. Old relative URLs are handled as local files.
