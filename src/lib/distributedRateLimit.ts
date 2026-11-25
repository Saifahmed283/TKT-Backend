import { Redis } from '@upstash/redis'
import { config } from '../config.js'

let redis: Redis | null = null

export function getRedis(): Redis | null {
  if (redis) return redis

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) {
    if (config.isProd) {
      console.error('UPSTASH_REDIS_REST_URL/TOKEN not configured - sensitive endpoints will fail closed in production')
    }
    return null
  }

  redis = new Redis({ url, token })
  return redis
}

/**
 * Distributed rate limiter using Upstash Redis.
 * Falls back to no-op in development if Redis is not configured.
 */
export async function distributedRateLimit(
  key: string,
  options: { max: number; windowMs: number }
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const client = getRedis()

  if (!client) {
    // Never silently disable abuse protection in production. Configuration
    // must be present before sensitive endpoints can be served.
    if (config.isProd) {
      return { allowed: false, remaining: 0, resetAt: Date.now() + options.windowMs }
    }
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