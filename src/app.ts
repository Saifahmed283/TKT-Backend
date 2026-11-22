import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { ZodError } from 'zod'
import { config } from './config.js'
import { AppError } from './lib/errors.js'
import { authRoutes } from './features/auth/routes.js'
import { organizationRoutes } from './features/organizations/routes.js'
import { eventRoutes } from './features/events/routes.js'
import { teamRoutes } from './features/teams/routes.js'
import { areaRoutes } from './features/areas/routes.js'
import { attendeeRoutes } from './features/attendees/routes.js'
import { ticketRoutes } from './features/tickets/routes.js'
import { credentialRoutes } from './features/credentials/routes.js'
import { accessRoutes } from './features/access/routes.js'
import { taskRoutes } from './features/tasks/routes.js'
import { incidentRoutes } from './features/incidents/routes.js'
import { communicationRoutes } from './features/communications/routes.js'
import { auditRoutes } from './features/audit/routes.js'
import { reportRoutes } from './features/reports/routes.js'
import { searchRoutes } from './features/search/routes.js'
import { realtimeRoutes } from './features/realtime/routes.js'
import { publicRoutes } from './features/public/routes.js'
import { reservationRoutes } from './features/reservations/routes.js'
import { presenceRoutes } from './features/presence/routes.js'
import { dashboardRoutes } from './features/dashboard/routes.js'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isProd
      ? { level: 'warn' }
      : { level: 'warn', transport: undefined },
    trustProxy: true,
  })

  await app.register(cors, {
    origin: config.corsOrigin.split(','),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  await app.register(cookie)

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'wss:', 'ws:'],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  })

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      error: { code: 'RATE_LIMITED', message: 'Too many requests — please slow down' },
    }),
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      })
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request payload',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      })
    }
    req.log.error(err)
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    })
  })

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` },
    })
  })

  app.get('/', async (_req, reply) => {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TKT API</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#0b0b0c;color:#faf8f4;display:grid;place-items:center;min-height:100vh;margin:0}
    main{padding:2rem;text-align:center;border:1px solid #2a2620;border-radius:16px;background:#141311}
    .dot{width:10px;height:10px;border-radius:50%;background:#22c55e;display:inline-block;margin-right:.5rem;box-shadow:0 0 0 4px rgba(34,197,94,.15);vertical-align:middle}
    h1{font-size:1.25rem;margin:0 0 .5rem}
    p{margin:.35rem 0;color:#cfc7b8}
    a{color:#e8d08b}
    code{color:#faf8f4}
  </style>
</head>
<body>
  <main>
    <h1><span class="dot" aria-hidden="true"></span>TKT API is running</h1>
    <p>Status: <strong>OK</strong></p>
    <p>Health: <a href="/health"><code>/health</code></a></p>
  </main>
</body>
</html>`
    return reply.type('text/html; charset=utf-8').send(html)
  })

  app.get('/health', async () => ({ status: 'ok', service: 'tkt-api', time: new Date().toISOString() }))

  await app.register(
    async (auth) => {
      await auth.register(rateLimit, {
        global: false,
        max: 20,
        timeWindow: '1 minute',
        errorResponseBuilder: () => ({
          error: { code: 'RATE_LIMITED', message: 'Too many attempts — try again in a minute' },
        }),
      })
      await auth.register(authRoutes)
    },
    { prefix: '/auth' },
  )
  await app.register(organizationRoutes, { prefix: '/organizations' })
  await app.register(eventRoutes, { prefix: '/events' })
  await app.register(teamRoutes, { prefix: '/events/:eventId/teams' })
  await app.register(areaRoutes, { prefix: '/events/:eventId/areas' })
  await app.register(attendeeRoutes, { prefix: '/events/:eventId/attendees' })
  await app.register(ticketRoutes, { prefix: '/events/:eventId/tickets' })
  await app.register(credentialRoutes, { prefix: '/events/:eventId/credentials' })
  await app.register(accessRoutes, { prefix: '/events/:eventId/access' })
  await app.register(taskRoutes, { prefix: '/events/:eventId/tasks' })
  await app.register(incidentRoutes, { prefix: '/events/:eventId/incidents' })
  await app.register(communicationRoutes, { prefix: '/events/:eventId/communications' })
  await app.register(auditRoutes, { prefix: '/events/:eventId/audit-logs' })
  await app.register(reportRoutes, { prefix: '/events/:eventId/reports' })
  await app.register(reservationRoutes, { prefix: '/events/:eventId/reservations' })
  await app.register(presenceRoutes, { prefix: '/events/:eventId' })
  await app.register(searchRoutes, { prefix: '/search' })
  await app.register(dashboardRoutes, { prefix: '/dashboard' })
  await app.register(realtimeRoutes, { prefix: '/realtime' })
  await app.register(publicRoutes, { prefix: '/public' })

  return app
}