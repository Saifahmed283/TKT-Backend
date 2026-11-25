import { Redis } from '@upstash/redis'
import { config } from '../config.js'
import { prisma } from './db.js'

let redis: Redis | null = null

export function getRedis(): Redis | null {
  if (redis) return redis

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) {
    if (config.isProd) {
      console.warn('UPSTASH_REDIS_REST_URL/TOKEN not configured - using Postgres rate-limit fallback in production')
    }
    return null
  }

  redis = new Redis({ url, token })
  return redis
}

/**
 * Postgres fallback used in production when Upstash is not configured. It is
 * distributed across serverless instances and fails closed on database errors.
 */
async function databaseRateLimit(
  key: string,
  options: { max: number; windowMs: number },
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const now = Date.now()
  const windowStart = new Date(now)
  const threshold = new Date(now - options.windowMs)

  try {
    const rows = await prisma.$queryRaw<Array<{ count: bigint | number; windowStart: Date }>>`
      INSERT INTO "RateLimitCounter" ("key", "windowStart", "count")
      VALUES (${key}, ${windowStart}, 1)
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "RateLimitCounter"."windowStart" < ${threshold} THEN 1
          ELSE "RateLimitCounter"."count" + 1
        END,
        "windowStart" = CASE
          WHEN "RateLimitCounter"."windowStart" < ${threshold} THEN ${windowStart}
          ELSE "RateLimitCounter"."windowStart"
        END
      RETURNING "count", "windowStart"
    `
    const count = Number(rows[0]?.count ?? options.max + 1)
    const resetAt = new Date(rows[0]?.windowStart ?? windowStart).getTime() + options.windowMs
    return {
      allowed: count <= options.max,
      remaining: Math.max(0, options.max - count),
      resetAt,
    }
  } catch (err) {
    console.error('Database rate limit error:', err)
    if (config.isProd) {
      return { allowed: false, remaining: 0, resetAt: now + options.windowMs }
    }
    return { allowed: true, remaining: options.max, resetAt: now + options.windowMs }
  }
}

/**
 * Distributed rate limiter using Upstash Redis when configured, otherwise a
 * Postgres-backed counter in production. Development stays permissive.
 */
export async function distributedRateLimit(
  key: string,
  options: { max: number; windowMs: number }
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const client = getRedis()

  if (!client) {
    if (config.isProd) return databaseRateLimit(key, options)
    return { allowed: true, remaining: options.max, resetAt: Date.now() + options.windowMs }
  }

  const now = Date.now()
  const windowSec = Math.ceil(options.windowMs / 1000)
  const redisKey = `ratelimit:${key}`

  try {
    // Use a sliding window with sorted set
    const pipeline = client.pipeline()

    // Remove expired entries
    pipeline.zremrangebyscore(redisKey, 0, now - options.windowMs)

    // Count current requests
    pipeline.zcard(redisKey)

    // Add current request with timestamp as score
    pipeline.zadd(redisKey, { score: now, member: `${now}:${Math.random()}` })

    // Set expiry on the key
    pipeline.expire(redisKey, windowSec + 1)

    const results = await pipeline.exec()

    const currentCount = (results[1] as number) ?? 0
    const allowed = currentCount < options.max
    const remaining = Math.max(0, options.max - currentCount)
    const resetAt = now + options.windowMs

    return { allowed, remaining, resetAt }
  } catch (err) {
    console.error('Distributed rate limit error:', err)
    // A broken limiter must not silently disable abuse protection in prod.
    if (config.isProd) {
      return { allowed: false, remaining: 0, resetAt: Date.now() + options.windowMs }
    }
    return { allowed: true, remaining: options.max, resetAt: Date.now() + options.windowMs }
  }
}

/**
 * Creates a rate limit key from request identifiers.
 * Supports IP, user ID, and custom prefixes.
 */
export function createRateLimitKey(parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(':')
}

/**
 * Standard rate limit key generators
 */
export const rateLimitKeys = {
  byIp: (ip: string) => `ip:${ip}`,
  byUser: (userId: string) => `user:${userId}`,
  byIpAndPath: (ip: string, path: string) => `ip:${ip}:path:${path}`,
  byUserAndPath: (userId: string, path: string) => `user:${userId}:path:${path}`,
  login: (ip: string) => `auth:login:ip:${ip}`,
  register: (ip: string) => `auth:register:ip:${ip}`,
  refresh: (ip: string) => `auth:refresh:ip:${ip}`,
  passwordReset: (ip: string) => `auth:pwdreset:ip:${ip}`,
  reservation: (eventId: string, ip: string) => `reservation:${eventId}:ip:${ip}`,
  seatHold: (eventId: string, ip: string) => `seathold:${eventId}:ip:${ip}`,
  statusCheck: (eventId: string, ip: string) => `status:${eventId}:ip:${ip}`,
  webhook: (eventId: string) => `webhook:${eventId}`,
}