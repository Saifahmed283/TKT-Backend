import { buildApp } from './app.js'
import { config } from './config.js'

async function main() {
  const app = await buildApp()
  try {
    await app.listen({ port: config.port, host: config.host })
    console.log(`\n  TKT API listening on http://localhost:${config.port}`)
    console.log(`  Health:  http://localhost:${config.port}/health\n`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

main()