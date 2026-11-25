import type { FastifyInstance, FastifyReply } from 'fastify'
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
      void runWithIsolatedDbContext({ isInternal: true, ...task.context }, task.work)
        .catch((err) => req.log.error({ err }, `background.${task.label} failed`))
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
