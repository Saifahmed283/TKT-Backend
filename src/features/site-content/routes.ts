import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { prisma } from '../../lib/db.js'
import { ABOUT_SITE_CONTENT_KEY, DEFAULT_ABOUT_CONTENT, siteContentSchema } from './schema.js'
import { refreshSiteContentImageUrls } from './assets.js'

function normalize(row: { data: unknown; updatedAt: Date } | null) {
  const content = row ? siteContentSchema.parse(row.data) : DEFAULT_ABOUT_CONTENT
  const freshAssets = refreshSiteContentImageUrls(content)
  return {
    ...freshAssets,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  }
}

/** Super-admin editor for public-site copy. Public reads live under /public. */
export async function siteContentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/about', async (req) => {
    await requirePermission(req, 'platform.manage')
    const row = await prisma.siteContent.findUnique({ where: { key: ABOUT_SITE_CONTENT_KEY } })
    return { data: normalize(row) }
  })

  app.put('/about', async (req) => {
    // Site-wide content has no event/org scope; only platform super admins pass.
    await requirePermission(req, 'platform.manage')
    const data = siteContentSchema.parse(req.body)
    const row = await prisma.siteContent.upsert({
      where: { key: ABOUT_SITE_CONTENT_KEY },
      update: { data, updatedBy: req.user.id },
      create: { key: ABOUT_SITE_CONTENT_KEY, data, updatedBy: req.user.id },
    })
    return { data: normalize(row) }
  })
}
