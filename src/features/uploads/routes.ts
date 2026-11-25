import type { FastifyInstance } from 'fastify'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { saveUpload } from '../../lib/uploadStore.js'

export async function uploadRoutes(app: FastifyInstance) {
  app.post('/', { preHandler: authenticate }, async (req) => {
    const file = await req.file()
    if (!file) throw errors.badRequest('No file uploaded')
    return { data: await saveUpload(file) }
  })

  // Public, unauthenticated endpoint: cap writes tightly so a launch-day
  // abuse attempt cannot fill the blob store before an admin can react.
  app.post('/proof', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
    const file = await req.file()
    if (!file) throw errors.badRequest('No file uploaded')
    return { data: await saveUpload(file) }
  })
}
