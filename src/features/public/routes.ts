import type { FastifyInstance } from 'fastify'
import { eventRoutes } from './events.js'
import { holdRoutes } from './holds.js'
import { reservationRoutes } from './reservations.js'
import { accessCodeRoutes } from './access-codes.js'
import { reservationStatusRoutes } from './status.js'
import { statsRoutes } from './stats.js'
import { contactRoutes } from './contact.js'
import { wheelRoutes } from './wheel.js'
import { publicSiteContentRoutes } from './site-content.js'

// Route paths and response bodies are unchanged; this module only composes
// the feature files so each public subresource can be maintained separately.
export async function publicRoutes(app: FastifyInstance) {
  await eventRoutes(app)
  await holdRoutes(app)
  await reservationRoutes(app)
  await accessCodeRoutes(app)
  await reservationStatusRoutes(app)
  await statsRoutes(app)
  await contactRoutes(app)
  await wheelRoutes(app)
  await publicSiteContentRoutes(app)
}