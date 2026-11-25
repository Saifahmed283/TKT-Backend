import { buildApp } from './app.js'
import { config } from './config.js'
import { releaseExpiredSeatHolds } from './features/internal/cleanup.js'

async function main() {
  const app = await buildApp()

  // Only run setInterval in non-serverless mode (local development)
  const isServerless = Boolean(process.env.VERCEL)
  const runHoldCleanup = async () => {
    try {
      const count = await releaseExpiredSeatHolds()
      if (count > 0) app.log.info({ count }, 'Expired seat holds released')
    } catch (err) {
      app.log.error({ err }, 'Expired seat hold cleanup failed')
    }
  }

  if (!isServerless) {
    const holdTimer = setInterval(() => { void runHoldCleanup() }, 60_000)
    app.addHook('onClose', async () => { clearInterval(holdTimer) })
  }

  try {
    await app.listen({ port: config.port, host: config.host })
    void runHoldCleanup()
    console.log(`\n  TKT API listening on http://localhost:${config.port}`)
    console.log(`  Health:  http://localhost:${config.port}/health\n`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

void main()
