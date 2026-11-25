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
 * The app keeps one Prisma transaction open per request for RLS context. Work
 * queued here runs in `onResponse`, after that transaction has committed, and
 * with an isolated DB context so it cannot accidentally join the closed
 * request transaction. Each task owns its own error boundary: a failed email
 * must never turn a committed reservation into an HTTP 500.
 *
 * TODO: replace this with a durable queue (BullMQ / a Vercel-compatible job
 * runner) once the project has one. Fire-and-forget is deliberate here, not
 * an excuse to skip retries forever.
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
