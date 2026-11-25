import type { AccessClaims } from '../lib/auth.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Verified once by the global onRequest hook and reused by authenticate(). */
    authClaims?: AccessClaims
    /** Loaded once by authenticate() and reused by authorization helpers. */
    platformRole?: string | null
  }
}

export {}
