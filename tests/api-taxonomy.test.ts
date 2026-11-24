import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { app, startTestApp, stopTestApp, expectStatus } from './helpers.js'
import { EVENT_DOMAIN_CODES } from '../src/config/taxonomy.js'

beforeAll(async () => {
  await startTestApp()
})

afterAll(async () => {
  await stopTestApp()
})

describe('public taxonomy metadata', () => {
  it('serves the canonical vocabularies for UI consumers', async () => {
    const res = await app.inject({ method: 'GET', url: '/meta/taxonomy' })
    expectStatus(res, 200)

    const data = res.json().data
    expect(data.eventFormats.map((item: { code: string }) => item.code)).toContain('CONFERENCE')
    expect(data.eventDomains.map((item: { code: string }) => item.code)).toEqual([...EVENT_DOMAIN_CODES])
    expect(data.ticketTiers.map((item: { code: string }) => item.code)).toContain('EARLY_BIRD')
    expect(data.attendeeTypes.map((item: { code: string }) => item.code)).toContain('EXHIBITOR')
    expect(data.roles.map((item: { code: string }) => item.code)).toContain('org_admin')
    expect(data).not.toHaveProperty('roleAliases')
  })
})
