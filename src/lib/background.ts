import type { FastifyInstance } from 'fastify'
import { waitUntil } from '@vercel/functions'
import { runWithIsolatedDbContext, type DbContext } from './dbContext.js'

type BackgroundTask = {
  label: string
  context: DbContext
  work: () => Promise<unknown>
}

const queues = new WeakMap<object, BackgroundTask[]>()

/**
 * Post-response work queue for Fastify routes.
 *
 * DEPRECATED: Use outbox pattern (afterResponseOutbox) for new code.
 * This queue is kept for backward compatibility with existing code.
 * It runs in `onResponse`, after the transaction has committed.
 * Each task owns its own error boundary.
 */
export function registerBackgroundTasks(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    queues.set(req, [])
  })

  app.addHook('onResponse', async (req) => {
    const tasks = queues.get(req) ?? []
    queues.delete(req)
    for (const task of tasks) {
      // Vercel suspends a function after its response unless post-response
      // work is registered with the runtime. Keep each durable outbox drain
      // alive without making the attendee wait for SMTP delivery.
      const work = runWithIsolatedDbContext({ isInternal: true, ...task.context }, task.work)
        .catch((err) => req.log.error({ err }, `background.${task.label} failed`))
      waitUntil(work)
    }
  })
}

/**
 * @deprecated Use afterResponseOutbox from outbox.ts instead.
 * Queues work to run after the HTTP response is sent.
 */
export function afterResponse(
  req: object,
  label: string,
  context: DbContext,
  work: () => Promise<unknown>,
): void {
  const queue = queues.get(req) ?? []
  queue.push({ label, context, work })
  queues.set(req, queue)
}
