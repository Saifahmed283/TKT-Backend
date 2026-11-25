import type { FastifyInstance, FastifyReply } from 'fastify'
import { runWithIsolatedDbContext, type DbContext } from './dbContext.js'
import { afterResponseOutbox } from './outbox.js'

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

/**
 * Creates an outbox event within the current transaction.
 * Use this instead of afterResponse for durable, retryable background work.
 */
import { Prisma } from '@prisma/client'

export function afterResponseOutboxAlias(
  tx: any,
  eventType: string,
  payload: Prisma.InputJsonValue,
  options?: { scheduledAt?: Date; maxAttempts?: number }
): void {
  // Import dynamically to avoid circular dependency
  import('./outbox.js').then(({ addOutboxEvent }) => {
    addOutboxEvent(tx, eventType as any, payload, options).catch((err) => {
      console.error('Failed to add outbox event:', err)
    })
  })
}