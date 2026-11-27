import type { FastifyInstance } from 'fastify'
import { waitUntil } from '@vercel/functions'
import { runWithIsolatedDbContext, type DbContext } from './dbContext.js'

/**
 * Kept for API compatibility. Delivery work is awaited by the route handler so
 * it cannot be cut off when a serverless runtime freezes after the response.
 */
export function registerBackgroundTasks(_app: FastifyInstance): void {
  // No queue: callers await afterResponse() before sending their response.
}

/**
 * Runs post-transaction work with an isolated internal DB context. Callers
 * await this promise so outbox delivery completes durably before the function
 * is suspended. Failures are logged here; outbox handlers own retry/backoff.
 */
export function afterResponse(
  req: object,
  label: string,
  context: DbContext,
  work: () => Promise<unknown>,
): Promise<void> {
  const task = runWithIsolatedDbContext({ isInternal: true, ...context }, work)
    .then(() => undefined)
    .catch((err) => {
      const logger = (req as { log?: { error?: (obj: unknown, msg: string) => void } }).log
      logger?.error?.({ err }, `background.${label} failed`)
    })

  // Also register with the runtime for callers that intentionally do not await
  // (for example webhook test pings). Awaited delivery paths do not rely on it.
  try {
    waitUntil(task)
  } catch {
    // Outside a Vercel Function there is no waitUntil scope to extend.
  }
  return task
}
