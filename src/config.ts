import 'dotenv/config'

function required(name: string): string {
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
    accessTtl: optional('JWT_ACCESS_TTL', '1h'),
    refreshTtl: optional('JWT_REFRESH_TTL', '7d'),
  },
  credentialKeys: {
    privateKeyB64: optional('CREDENTIAL_PRIVATE_KEY_B64', ''),
    publicKeyB64: optional('CREDENTIAL_PUBLIC_KEY_B64', ''),
  },
  mailer: {
    enabled: optional('SMTP_ENABLED', 'false') === 'true',
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
  },
  publicUrl: optional('PUBLIC_URL', 'http://localhost:5173'),
  isProd: optional('NODE_ENV', 'development') === 'production',
}