import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/db.js'
import { ABOUT_SITE_CONTENT_KEY, DEFAULT_ABOUT_CONTENT, siteContentSchema } from '../site-content/schema.js'

export async function publicSiteContentRoutes(app: FastifyInstance) {
  app.get('/site-content/about', async (_req, reply) => {
    const row = await prisma.siteContent.findUnique({ where: { key: ABOUT_SITE_CONTENT_KEY } })
    const content = row ? siteContentSchema.parse(row.data) : DEFAULT_ABOUT_CONTENT

    // Copy changes are infrequent; a short public cache keeps the About page
    // fast while still letting an editor's change appear within a minute.
    reply.header('Cache-Control', 'public, max-age=60')
    return {
      data: {
        ...content,
        updatedAt: row ? row.updatedAt.toISOString() : null,
      },
    }
  })
}
