import 'dotenv/config'

export function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required environment variable: ${name}`)
  return v
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '4000')),
  host: optional('HOST', '0.0.0.0'),
  corsOrigin: optional('CORS_ORIGIN', 'http://localhost:5173'),
  databaseUrl: required('DATABASE_URL'),
  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    staffSecret: required('JWT_SECRET'),
    accessTtl: optional('JWT_ACCESS_TTL', '1h'),
    refreshTtl: optional('JWT_REFRESH_TTL', '7d'),
  },
  credentialKeys: {
    privateKeyB64: optional('CREDENTIAL_PRIVATE_KEY_B64', ''),
    publicKeyB64: optional('CREDENTIAL_PUBLIC_KEY_B64', ''),
  },
  mailer: {
    // Explicit SMTP_ENABLED wins; otherwise auto-enable when host/user/pass are all set.
    enabled: process.env.SMTP_ENABLED
      ? process.env.SMTP_ENABLED === 'true'
      : Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    host: optional('SMTP_HOST', ''),
    port: Number(optional('SMTP_PORT', '587')),
    secure: optional('SMTP_SECURE', 'false') === 'true',
    user: optional('SMTP_USER', ''),
    pass: optional('SMTP_PASS', ''),
    from: optional('MAIL_FROM', 'TKT Ops <no-reply@tkt.local>'),
  },
  uploads: {
    dir: optional('UPLOAD_DIR', 'uploads'),
    maxBytes: Number(optional('UPLOAD_MAX_BYTES', String(5 * 1024 * 1024))),
    // Production uploads use Vercel Blob; local/dev keeps writing to disk.
    blobToken: optional('BLOB_READ_WRITE_TOKEN', ''),
    blobStoreId: optional('BLOB_STORE_ID', ''),
  },
  publicUrl: optional('PUBLIC_URL', 'http://localhost:5173'),
  isProd: optional('NODE_ENV', 'development') === 'production',
  isTest: optional('NODE_ENV', 'development') === 'test',
  rateLimits: {
    // Integration tests need many registrations; a dedicated test opts back in.
    enabledInTests: process.env.TKT_RATE_LIMIT_TEST === 'true',
  },
}