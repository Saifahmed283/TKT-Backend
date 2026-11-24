import { buildApp } from '../dist/app.js'

let appPromise

async function getApp() {
  if (!appPromise) {
    appPromise = buildApp()
      .then(async (app) => {
        await app.ready()
        return app
      })
      .catch((err) => {
        appPromise = undefined
        throw err
      })
  }
  return appPromise
}

export default async function handler(req, res) {
  const app = await getApp()
  app.server.emit('request', req, res)
}
