import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import fs from 'node:fs'
import path from 'node:path'
import { ZodError } from 'zod'
import { config } from './config.js'
import { checkDatabase } from './lib/db.js'
import { AppError, errors, generateCorrelationId, createErrorResponse } from './lib/errors.js'
import { distributedRateLimit, rateLimitKeys } from './lib/distributedRateLimit.js'
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
import { uploadRoutes } from './features/uploads/routes.js'
import { paymentRoutes } from './features/payments/routes.js'
import { accessCodeRoutes } from './features/access-codes/routes.js'
import { deviceRoutes } from './features/devices/routes.js'
import { workforceRoutes } from './features/workforce/routes.js'
import { integrationRoutes } from './features/integrations/routes.js'
import { dashboardRoutes } from './features/dashboard/routes.js'
import { busRoutes } from './features/buses/routes.js'
import { metaRoutes } from './features/meta/routes.js'
import { siteContentRoutes } from './features/site-content/routes.js'
import { registerCleanupEndpoint } from './features/internal/cleanup.js'
import { assertRoleCatalogValid } from './lib/roleAliases.js'
import { syncSystemRoles } from './lib/roleSync.js'
import { purgeRejectedReservations } from './features/reservations/purge.js'
import { enterDbContext } from './lib/dbContext.js'
import { registerBackgroundTasks } from './lib/background.js'
import { prisma } from './lib/db.js'
import { verifyAccessToken } from './lib/auth.js'

const requestStartedAt = new WeakMap<FastifyReply, number>()

// These routes never need JWT verification or DB context. Health probes
// are called constantly by the status page and monitoring, static upload files
// are served directly, and SSE streams must not pin a DB connection open for
// their entire lifetime.
const NO_DB_CONTEXT_PATHS = new Set(['/health', '/health/ready', '/', '/status.js', '/realtime'])
const NO_AUTH_PATHS = new Set(['/health', '/health/ready', '/', '/status.js'])

// Status capabilities and attendee email must not land in request logs.
function safeUrlForLog(url: string): string {
  return url.replace(/([?&](?:token|email|accessToken)=)[^&]*/gi, '$1[redacted]')
}

export async function buildApp(): Promise<FastifyInstance> {
  assertRoleCatalogValid()

  // Vercel invokes buildApp() on every cold start. Role sync and the rejected
  // reservation purge are maintenance jobs, not request setup: running them in
  // a function boot adds unbounded DB work to the first request of every new
  // instance. They run in long-lived server mode and can be scheduled as jobs
  // in serverless environments.
  const isServerless = Boolean(process.env.VERCEL)
  if (!isServerless && !config.isTest) {
    await syncSystemRoles()
    await purgeRejectedReservations()
  }

  // Trust only the platform proxy hop, never arbitrary X-Forwarded-For values.
  // Direct clients cannot spoof loopback as their socket address. Deployments
  // behind another proxy can set TRUST_PROXY_IPS to its IP/CIDR.
  const configuredProxies = (process.env.TRUST_PROXY_IPS ?? '127.0.0.1,::1,::ffff:127.0.0.1')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const trustProxy = config.isProd ? configuredProxies : false

  const app = Fastify({
    logger: config.isProd
      ? { level: 'warn' }
      : { level: 'warn', transport: undefined },
    trustProxy,
  })

  // Request-scoped RLS context via AsyncLocalStorage.
  // No request-scoped transaction: business operations use explicit
  // prisma.$transaction() callbacks so commits happen before response.
  app.addHook('onRequest', (req, reply, done) => {
    requestStartedAt.set(reply, Date.now())
    void (async () => {
      const path = (req.url || '').split('?')[0] || ''
      const publicEvent = path.match(/^\/public\/events\/([^/]+)/)
      const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]

      // Health/status/static requests do not need JWT verification or DB context.
      if (req.method === 'OPTIONS' || NO_AUTH_PATHS.has(path)) {
        done()
        return
      }

      const claims = token ? await verifyAccessToken(token) : null
      if (claims) req.authClaims = claims

      // Skip DB context for paths that must not hold connections (SSE, uploads, health).
      if (NO_DB_CONTEXT_PATHS.has(path) || path.startsWith('/uploads/')) {
        done()
        return
      }

      enterDbContext({
        userId: claims?.sub,
        isAuth: path.startsWith('/auth'),
        isPublic: path.startsWith('/public'),
        publicEventId: publicEvent?.[1],
      })

      done()
    })().catch(done)
  })

  app.addHook('onResponse', async (req, reply) => {
    const started = requestStartedAt.get(reply)
    requestStartedAt.delete(reply)
    const durationMs = started == null ? null : Date.now() - started
    const fields = {
      method: req.method,
      url: safeUrlForLog(req.url),
      status: reply.statusCode,
      duration_ms: durationMs,
    }
    // Production logs are warn-level; surface slow requests there while
    // keeping normal timing available in development/test logs.
    if (durationMs != null && durationMs > 1000) req.log.warn(fields, 'request.slow')
    else req.log.info(fields, 'request.completed')
  })

  registerBackgroundTasks(app)

  if (config.isTest && !config.rateLimits.enabledInTests) {
    app.addHook('onRoute', (routeOptions) => {
      routeOptions.config = { ...(routeOptions.config ?? {}), rateLimit: false }
    })
  }

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  })

  await app.register(cookie)

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'http://localhost:*', 'https:'],
        connectSrc: ["'self'", 'wss:', 'ws:', 'http://localhost:*', 'https:'],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  })

  // Only use local filesystem for uploads in development (not on Vercel/production)
  // In production, we use Vercel Blob storage via uploadStore.ts
  const isLocalStorage = !config.isProd && !config.isVercel

  if (isLocalStorage) {
    const uploadDir = path.resolve(process.cwd(), config.uploads.dir)
    fs.mkdirSync(uploadDir, { recursive: true })
    await app.register(multipart, {
      limits: { fileSize: config.uploads.maxBytes, files: 1 },
    })
    await app.register(fastifyStatic, {
      root: uploadDir,
      prefix: '/uploads/',
      decorateReply: false,
    })
  } else {
    // In production/Vercel, we use Vercel Blob - only register multipart for upload handling
    await app.register(multipart, {
      limits: { fileSize: config.uploads.maxBytes, files: 1 },
    })
  }

  await app.register(rateLimit, {
    global: !config.isTest || config.rateLimits.enabledInTests,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: () =>
      errors.rateLimited('Too many requests — please slow down'),
  })

  // Distributed rate limiting for sensitive endpoints
  // Runs after global rate limit, uses Redis when available
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = (req.url || '').split('?')[0] || ''
    const ip = req.ip

    // The limiter fails closed in production when Redis is not configured.
    // Define sensitive endpoint patterns with their limits
    type RateLimitPattern = {
      pattern: RegExp
      keyFn: (ip: string, path: string) => string
      max: number
      windowMs: number
    }

    const sensitivePatterns: RateLimitPattern[] = [
      { pattern: /^\/auth\/login$/, keyFn: (ip: string) => rateLimitKeys.login(ip), max: 5, windowMs: 5 * 60 * 1000 },
      { pattern: /^\/auth\/register$/, keyFn: (ip: string) => rateLimitKeys.register(ip), max: 3, windowMs: 10 * 60 * 1000 },
      { pattern: /^\/auth\/refresh$/, keyFn: (ip: string) => rateLimitKeys.refresh(ip), max: 12, windowMs: 60 * 1000 },
      { pattern: /^\/auth\/logout$/, keyFn: (ip: string) => `auth:logout:ip:${ip}`, max: 20, windowMs: 60 * 1000 },
      { pattern: /^\/public\/events\/[^/]+\/reservations$/, keyFn: (ip: string, path: string) => `reservation:${path.match(/\/public\/events\/([^/]+)/)?.[1] || 'unknown'}:ip:${ip}`, max: 5, windowMs: 10 * 60 * 1000 },
      { pattern: /^\/public\/events\/[^/]+\/buses\/[^/]+\/hold$/, keyFn: (ip: string, path: string) => `seathold:${path.match(/\/public\/events\/([^/]+)/)?.[1] || 'unknown'}:ip:${ip}`, max: 10, windowMs: 60 * 1000 },
      { pattern: /^\/public\/events\/[^/]+\/reservations\/status/, keyFn: (ip: string, path: string) => `status:${path.match(/\/public\/events\/([^/]+)/)?.[1] || 'unknown'}:ip:${ip}`, max: 120, windowMs: 10 * 60 * 1000 },
      { pattern: /^\/public\/events\/[^/]+\/reservations\/resend$/, keyFn: (ip: string, path: string) => `resend:${path.match(/\/public\/events\/([^/]+)/)?.[1] || 'unknown'}:ip:${ip}`, max: 3, windowMs: 15 * 60 * 1000 },
    ]

    for (const { pattern, keyFn, max, windowMs } of sensitivePatterns) {
      if (pattern.test(path)) {
        const key = keyFn(ip, path)
        const { allowed, remaining, resetAt } = await distributedRateLimit(key, { max, windowMs })

        reply.header('X-RateLimit-Limit', String(max))
        reply.header('X-RateLimit-Remaining', String(remaining))
        reply.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)))

        if (!allowed) {
          const retryAfter = Math.ceil((resetAt - Date.now()) / 1000)
          reply.header('Retry-After', String(Math.max(1, retryAfter)))
          throw errors.rateLimited(`Too many requests — please try again in ${Math.ceil(windowMs / 60000)} minute(s)`)
        }
        break // Only apply the first matching pattern
      }
    }
  })

  app.setErrorHandler((err, req, reply) => {
    const correlationId = generateCorrelationId()

    // Add correlation ID to response headers
    reply.header('X-Correlation-ID', correlationId)

    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(createErrorResponse(err, correlationId))
    }
    if (err instanceof ZodError) {
      const validationError = new AppError(400, 'VALIDATION_ERROR', 'Invalid request payload', err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
      return reply.status(400).send(createErrorResponse(validationError, correlationId))
    }

    // Log internal errors with correlation ID
    req.log.error({ err, correlationId }, 'Internal server error')

    return reply.status(500).send(createErrorResponse(
      new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred'),
      correlationId
    ))
  })

  app.setNotFoundHandler((req, reply) => {
    const correlationId = generateCorrelationId()
    reply.header('X-Correlation-ID', correlationId)
    return reply.status(404).send(createErrorResponse(
      new AppError(404, 'NOT_FOUND', `Route ${req.method} ${safeUrlForLog(req.url)} not found`),
      correlationId
    ))
  })

  app.get('/', async (_req, reply) => {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0b0b0c">
  <title>TKT API · Status</title>
  <style>
    :root{color-scheme:dark;--bg:#0b0b0c;--panel:#141311;--line:#2a2620;--text:#faf8f4;--muted:#a9a196;--accent:#e8d08b;--ok:#4ade80;--bad:#fb7185;--warn:#fbbf24}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% -10%,#241f17 0,#0b0b0c 45%);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
    .shell{width:min(960px,calc(100% - 2rem));margin:3rem auto 4rem}
    .topbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap}
    .brand{display:flex;align-items:center;gap:.85rem}
    .mark{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:var(--accent);color:#1a160f;font-weight:800;font-size:1.1rem}
    .eyebrow{margin:0 0 .15rem;color:var(--muted);font-size:.75rem;letter-spacing:.12em;text-transform:uppercase}
    h1{margin:0;font-size:1.55rem;line-height:1.2}
    .pill{display:inline-flex;align-items:center;gap:.5rem;padding:.45rem .8rem;border:1px solid var(--line);border-radius:999px;background:#171613;font-size:.85rem;color:var(--muted)}
    .pill::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--warn);box-shadow:0 0 0 4px rgba(251,191,36,.12)}
    .pill[data-status="ok"]::before{background:var(--ok);box-shadow:0 0 0 4px rgba(74,222,128,.12)}
    .pill[data-status="error"]::before{background:var(--bad);box-shadow:0 0 0 4px rgba(251,113,133,.12)}
    .pill[data-status="ok"]{color:var(--ok)}
    .pill[data-status="error"]{color:var(--bad)}
    .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem;margin-bottom:1rem}
    .summary div{padding:.85rem 1rem;border:1px solid var(--line);border-radius:12px;background:rgba(20,19,17,.8)}
    .summary span{display:block;color:var(--muted);font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;margin-bottom:.3rem}
    .summary strong{font-size:.95rem;font-weight:600}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}
    .card{padding:1.25rem;border:1px solid var(--line);border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,0)),var(--panel)}
    .card-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1.1rem}
    .card h2{margin:0;font-size:1rem}
    .card-dot{width:10px;height:10px;border-radius:50%;background:var(--warn);box-shadow:0 0 0 5px rgba(251,191,36,.12)}
    .card[data-status="ok"] .card-dot{background:var(--ok);box-shadow:0 0 0 5px rgba(74,222,128,.12)}
    .card[data-status="error"] .card-dot{background:var(--bad);box-shadow:0 0 0 5px rgba(251,113,133,.12)}
    .card-value{display:block;font-size:1.35rem;font-weight:650;margin-bottom:.35rem}
    .card-meta{display:block;color:var(--muted);font-size:.82rem}
    .card-desc{margin:.85rem 0 0;color:var(--muted);font-size:.85rem;line-height:1.5}
    code,a{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    a{color:var(--accent);text-decoration:none;border-bottom:1px solid rgba(232,208,139,.35)}
    a:hover{border-bottom-color:var(--accent)}
    .controls{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin:1.25rem 0 0}
    button,select{font:inherit;color:var(--text);background:#171613;border:1px solid var(--line);border-radius:10px;padding:.55rem .8rem}
    button{cursor:pointer;border-color:#5a4b2e;background:#2a2317;color:var(--accent);font-weight:600}
    button:disabled{opacity:.55;cursor:wait}
    footer{margin-top:1.5rem;color:var(--muted);font-size:.8rem;line-height:1.6}
    @media (max-width:600px){.shell{margin:1.5rem auto 3rem}h1{font-size:1.3rem}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="mark" aria-hidden="true">T</span>
        <div>
          <p class="eyebrow">TKT Control Center</p>
          <h1>Backend status</h1>
        </div>
      </div>
      <span id="overall" class="pill" data-status="checking" role="status" aria-live="polite">Checking…</span>
    </header>

    <section class="summary" aria-label="Runtime details">
      <div><span>Last checked</span><strong id="last-checked">—</strong></div>
      <div><span>Uptime</span><strong id="uptime">—</strong></div>
      <div><span>Region</span><strong id="region">—</strong></div>
      <div><span>Environment</span><strong id="environment">—</strong></div>
      <div><span>Node</span><strong id="node-version">—</strong></div>
    </section>

    <section class="grid" aria-label="Service checks">
      <article id="card-process" class="card" data-status="checking">
        <div class="card-head"><h2>API process</h2><span class="card-dot" aria-hidden="true"></span></div>
        <strong class="card-value">Checking…</strong>
        <span class="card-meta">Waiting for response</span>
        <p class="card-desc">Liveness probe from <a href="/health"><code>/health</code></a>.</p>
      </article>
      <article id="card-database" class="card" data-status="checking">
        <div class="card-head"><h2>Database</h2><span class="card-dot" aria-hidden="true"></span></div>
        <strong class="card-value">Checking…</strong>
        <span class="card-meta">Waiting for response</span>
        <p class="card-desc">Connectivity probe from <a href="/health/ready"><code>/health/ready</code></a>.</p>
      </article>
    </section>

    <div class="controls">
      <button id="refresh" type="button">Run checks now</button>
      <label for="interval">Auto-refresh</label>
      <select id="interval">
        <option value="30">Every 30s</option>
        <option value="60">Every 60s</option>
        <option value="0">Off</option>
      </select>
    </div>

    <footer>
      This page is served by the API itself and calls same-origin endpoints, so it works on Vercel without CORS changes.
      Secrets and database values are never displayed.
    </footer>
  </main>
  <script src="/status.js"></script>
</body>
</html>`
    return reply
      .type('text/html; charset=utf-8')
      // The shell is static; status.js fetches live data on every load.
      .header('Cache-Control', 'public, max-age=60')
      .send(html)
  })

  app.get('/status.js', async (_req, reply) => {
    const js = `(() => {
  const refreshBtn = document.getElementById('refresh')
  const intervalSelect = document.getElementById('interval')
  const lastChecked = document.getElementById('last-checked')
  const overall = document.getElementById('overall')
  const uptime = document.getElementById('uptime')
  const region = document.getElementById('region')
  const nodeVersion = document.getElementById('node-version')
  const environment = document.getElementById('environment')
  const cards = {
    process: document.getElementById('card-process'),
    database: document.getElementById('card-database'),
  }

  let timer = null

  function setCard(card, result, detail) {
    if (!card) return
    const dot = card.querySelector('.card-dot')
    const value = card.querySelector('.card-value')
    const meta = card.querySelector('.card-meta')
    const ok = Boolean(result && result.ok)
    card.dataset.status = ok ? 'ok' : 'error'
    if (dot) dot.setAttribute('aria-hidden', 'true')
    if (value) value.textContent = ok ? (detail || 'Operational') : 'Unavailable'
    if (meta) meta.textContent = result ? (result.ms + ' ms · HTTP ' + result.status) : 'No response'
  }

  async function ping(url) {
    const start = performance.now()
    try {
      const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } })
      const data = await response.json().catch(() => null)
      return { ok: response.ok, status: response.status, ms: Math.round(performance.now() - start), data }
    } catch (error) {
      return { ok: false, status: 0, ms: Math.round(performance.now() - start), data: null }
    }
  }

  function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    if (d) return d + 'd ' + h + 'h ' + m + 'm'
    if (h) return h + 'h ' + m + 'm ' + s + 's'
    if (m) return m + 'm ' + s + 's'
    return s + 's'
  }

  async function refresh() {
    if (refreshBtn) refreshBtn.disabled = true
    if (overall) {
      overall.textContent = 'Checking…'
      overall.dataset.status = 'checking'
    }

    const [live, ready] = await Promise.all([ping('/health'), ping('/health/ready')])
    const readyData = ready.data && typeof ready.data === 'object' ? ready.data : {}
    const checks = readyData.checks || {}
    const dbOk = Boolean(ready.ok && checks.database && checks.database.status === 'ok')

    setCard(cards.process, live, 'Operational')
    setCard(
      cards.database,
      dbOk ? ready : { ok: false, status: ready.status || 503, ms: ready.ms },
      'Connected',
    )

    if (overall) {
      const ok = live.ok && ready.ok
      overall.textContent = ok ? 'All systems operational' : 'Attention required'
      overall.dataset.status = ok ? 'ok' : 'error'
    }
    if (uptime) uptime.textContent = typeof readyData.uptimeSeconds === 'number' ? formatUptime(readyData.uptimeSeconds) : '—'
    const runtime = readyData.runtime || {}
    if (region) region.textContent = runtime.region || '—'
    if (nodeVersion) nodeVersion.textContent = runtime.node || '—'
    if (environment) environment.textContent = runtime.environment || '—'
    if (lastChecked) lastChecked.textContent = new Date().toLocaleTimeString()

    if (refreshBtn) refreshBtn.disabled = false
  }

  function schedule() {
    if (timer) clearInterval(timer)
    const value = intervalSelect ? Number(intervalSelect.value) : 30
    timer = value > 0 ? setInterval(refresh, value * 1000) : null
  }

  if (refreshBtn) refreshBtn.addEventListener('click', refresh)
  if (intervalSelect) intervalSelect.addEventListener('change', schedule)
  refresh()
  schedule()
})()`
    return reply
      .type('application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300')
      .send(js)
  })

  app.get('/health', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return { status: 'ok', service: 'tkt-api', time: new Date().toISOString() }
  })

  app.get('/health/ready', async (_req, reply) => {
    const checks: { server: { status: string }; database: { status: string } } = {
      server: { status: 'ok' },
      database: { status: 'ok' },
    }

    try {
      await checkDatabase()
    } catch {
      checks.database.status = 'error'
    }

    const ready = checks.server.status === 'ok' && checks.database.status === 'ok'
    reply.header('Cache-Control', 'no-store')
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'error',
      service: 'tkt-api',
      time: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      runtime: {
        environment: config.env,
        region: process.env.VERCEL_REGION ?? 'local',
        node: process.version,
      },
      checks,
    })
  })

  await app.register(
    async (auth) => {
      await auth.register(rateLimit, {
        global: false,
        max: 20,
        timeWindow: '1 minute',
        errorResponseBuilder: () =>
          errors.rateLimited('Too many attempts — try again in a minute'),
      })
      await auth.register(authRoutes)
    },
    { prefix: '/auth' },
  )
  await app.register(metaRoutes, { prefix: '/meta' })
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
  await app.register(paymentRoutes, { prefix: '/events/:eventId/payments' })
  await app.register(accessCodeRoutes, { prefix: '/events/:eventId/access-codes' })
  await app.register(deviceRoutes, { prefix: '/events/:eventId/devices' })
  await app.register(workforceRoutes, { prefix: '/events/:eventId/workforce' })
  await app.register(integrationRoutes, { prefix: '/events/:eventId/integrations' })
  await app.register(busRoutes, { prefix: '/events/:eventId/buses' })
  await app.register(presenceRoutes, { prefix: '/events/:eventId' })
  await app.register(uploadRoutes, { prefix: '/uploads' })
  await app.register(searchRoutes, { prefix: '/search' })
  await app.register(dashboardRoutes, { prefix: '/dashboard' })
  await app.register(realtimeRoutes, { prefix: '/realtime' })
  await app.register(publicRoutes, { prefix: '/public' })
  await app.register(siteContentRoutes, { prefix: '/site-content' })

  // Vercel Cron reaches the serverless handler (dist/app.js), so the protected
  // cleanup route must be part of the app rather than only src/server.ts.
  await registerCleanupEndpoint(app)

  return app
}
