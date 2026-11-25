import type { FastifyInstance } from 'fastify'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { isSafeUploadPath, readPrivateUpload, saveUpload, verifyProofToken } from '../../lib/uploadStore.js'

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

  // Private Blob objects are streamed through this capability-URL proxy so
  // <img> and admin proof links work without exposing store credentials.
  app.get('/blob/*', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const pathname = (req.params as { '*': string })['*']
    const { token, exp } = req.query as { token?: string; exp?: string }
    const expiresAt = exp ? Number(exp) : undefined
    if (!isSafeUploadPath(pathname) || !verifyProofToken(pathname, token, expiresAt)) {
      throw errors.forbidden('Invalid or expired proof link')
    }
    const file = await readPrivateUpload(pathname)
    if (!file) throw errors.notFound('Proof not found')
    reply.header('Content-Type', file.contentType)
    reply.header('Content-Length', file.size)
    reply.header('Cache-Control', 'private, no-cache')
    reply.header('X-Content-Type-Options', 'nosniff')
    // Proofs may be SVG/PDF; disable active content if opened directly.
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
    return reply.send(file.stream)
  })
}
