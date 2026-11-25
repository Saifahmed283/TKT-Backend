import { buildApp } from './app.js'
import { config } from './config.js'
import { prisma } from './lib/db.js'
import { runWithDbContext } from './lib/dbContext.js'

async function releaseExpiredSeatHolds() {
  return runWithDbContext({ isInternal: true }, async () => {
    const now = new Date()
    const expired = await prisma.busSeat.updateMany({
      where: { state: 'HELD', holdExpiresAt: { lt: now } },
      data: { state: 'AVAILABLE', holderName: null, passengerName: null, passengerEmail: null, passengerPhone: null, groupId: null, ticketId: null, holdToken: null, holdExpiresAt: null, reservedAt: null },
    }).catch(() => ({ count: 0 }))
    return expired.count
  })
}

// Internal endpoint for scheduled cleanup (Vercel Cron / external scheduler)
// Protected by CRON_SECRET environment variable
async function registerCleanupEndpoint(app: any) {
  app.post('/internal/cleanup/expired-holds', async (req, reply) => {
    const secret = req.headers['x-cron-secret'] || req.headers['authorization']?.replace('Bearer ', '')
    if (secret !== config.cronSecret) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid cron secret' } })
    }
    const count = await releaseExpiredSeatHolds()
    return { data: { cleaned: count } }
  })
}

async function main() {
  const app = await buildApp()
  
  // Register internal cleanup endpoint
  await registerCleanupEndpoint(app)
  
  // Only run setInterval in non-serverless mode (local development)
  const isServerless = Boolean(process.env.VERCEL)
  if (!isServerless) {
    const holdTimer = setInterval(() => { void releaseExpiredSeatHolds() }, 60_000)
    app.addHook('onClose', async () => { clearInterval(holdTimer) })
  }
  
  try {
    await app.listen({ port: config.port, host: config.host })
    void releaseExpiredSeatHolds()
    console.log(`\n  TKT API listening on http://localhost:${config.port}`)
    console.log(`  Health:  http://localhost:${config.port}/health\n`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

main()