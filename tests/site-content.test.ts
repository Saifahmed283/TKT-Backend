import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { app, auth, registerUser, startTestApp, stopTestApp, type TestUser } from './helpers.js'
import { prisma } from '../src/lib/db.js'
import { runWithDbContext } from '../src/lib/dbContext.js'
import { ABOUT_SITE_CONTENT_KEY, DEFAULT_ABOUT_CONTENT, siteContentSchema } from '../src/features/site-content/schema.js'
import type { SiteContentData } from '../src/features/site-content/schema.js'

let admin: TestUser
let outsider: TestUser
let original: SiteContentData

beforeAll(async () => {
  await startTestApp()
  admin = await registerUser('SiteAdmin')
  outsider = await registerUser('SiteOutsider')

  await runWithDbContext({ isInternal: true }, async () => {
    await prisma.user.update({
      where: { id: admin.userId },
      data: { platformRole: 'super_admin' },
    })
    const row = await prisma.siteContent.findUnique({ where: { key: ABOUT_SITE_CONTENT_KEY } })
    original = row ? siteContentSchema.parse(row.data) : DEFAULT_ABOUT_CONTENT
  })

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: admin.email, password: admin.password },
  })
  expect(login.statusCode).toBe(200)
  admin.token = login.json().data.token
})

afterAll(async () => {
  await runWithDbContext({ isInternal: true }, async () => {
    await prisma.siteContent.upsert({
      where: { key: ABOUT_SITE_CONTENT_KEY },
      update: { data: original, updatedBy: null },
      create: { key: ABOUT_SITE_CONTENT_KEY, data: original },
    })
    await prisma.user.deleteMany({ where: { id: { in: [admin.userId, outsider.userId] } } }).catch(() => {})
  })
  await stopTestApp()
})

describe('public site content', () => {
  it('serves the About page copy without authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/public/site-content/about' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('max-age=60')
    expect(res.json().data.copy.team.eyebrow.en).toBe('The Team')
    expect(Array.isArray(res.json().data.members)).toBe(true)
  })

  it('rejects unauthenticated edits', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/site-content/about',
      payload: original,
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects non-platform users', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/site-content/about',
      headers: auth(outsider.token),
      payload: original,
    })
    expect(res.statusCode).toBe(403)
  })

  it('lets a super admin publish changes to the public endpoint', async () => {
    const edited: SiteContentData = {
      ...original,
      members: original.members.map((member, index) =>
        index === 0 ? { ...member, name: { en: 'Test Founder', ar: 'مؤسس اختبار' } } : member,
      ),
    }

    const save = await app.inject({
      method: 'PUT',
      url: '/site-content/about',
      headers: auth(admin.token),
      payload: edited,
    })
    expect(save.statusCode).toBe(200)
    expect(save.json().data.members[0].name.en).toBe('Test Founder')

    const published = await app.inject({ method: 'GET', url: '/public/site-content/about' })
    expect(published.statusCode).toBe(200)
    expect(published.json().data.members[0].name.en).toBe('Test Founder')
  })

  it('validates required localized text', async () => {
    const invalid = {
      ...original,
      members: original.members.map((member, index) =>
        index === 0 ? { ...member, name: { ...member.name, en: '' } } : member,
      ),
    }
    const res = await app.inject({
      method: 'PUT',
      url: '/site-content/about',
      headers: auth(admin.token),
      payload: invalid,
    })
    expect(res.statusCode).toBe(400)
  })
})
