import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/lib/db.js'

export let app: FastifyInstance

export const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export async function startTestApp() {
  if (!app) app = await buildApp()
  await app.ready()
  return app
}

export async function stopTestApp() {
  await prisma.$disconnect()
}

export type TestUser = {
  name: string
  email: string
  password: string
  token: string
  userId: string
}

export async function registerUser(name: string): Promise<TestUser> {
  const email = `${unique(name.toLowerCase())}@test.tkt`
  const password = 'TestPass123!'
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { name, email, password },
  })
  expectStatus(res, 201)
  const data = res.json().data
  return { name, email, password, token: data.token, userId: data.user.id }
}

export async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  })
  expectStatus(res, 200)
  return res.json().data.token
}

export async function createOrg(token: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/organizations',
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  })
  expectStatus(res, 201)
  return res.json().data.id
}

export async function createEvent(token: string, orgId: string, name: string, opts?: { live?: boolean }): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/events',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      organizationId: orgId,
      name,
      type: 'CONFERENCE',
      startAt: new Date(opts?.live ? Date.now() - 3600_000 : Date.now() + 86400_000).toISOString(),
      timezone: 'UTC',
    },
  })
  expectStatus(res, 201)
  return res.json().data.id
}

export async function setEventStatus(token: string, eventId: string, status: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/events/${eventId}/status`,
    headers: { authorization: `Bearer ${token}` },
    payload: { status },
  })
  return res
}

export async function goLive(token: string, eventId: string) {
  for (const s of ['PLANNING', 'READY', 'PUBLISHED', 'LIVE']) {
    expectStatus(await setEventStatus(token, eventId, s), 200)
  }
}

export async function createArea(token: string, eventId: string, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/events/${eventId}/areas`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name, type: 'GATE', accessPolicy: 'OPEN' },
  })
  return res
}

export async function createTeam(token: string, eventId: string, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/events/${eventId}/teams`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  })
  return res
}

export async function assignStaff(
  token: string,
  eventId: string,
  userId: string,
  roleCode: string,
  teamId?: string,
  areaIds?: string[],
) {
  const roles = await app.inject({
    method: 'GET',
    url: '/organizations/roles/catalog',
    headers: { authorization: `Bearer ${token}` },
  })
  expectStatus(roles, 200)
  const role = roles.json().data.find((r: any) => r.code === roleCode)
  if (!role) throw new Error(`Role ${roleCode} not found in catalog`)

  const res = await app.inject({
    method: 'POST',
    url: `/events/${eventId}/members`,
    headers: { authorization: `Bearer ${token}` },
    payload: { userId, roleId: role.id, teamId: teamId ?? null, areaIds: areaIds ?? [] },
  })
  expectStatus(res, 201)
  return res.json().data
}

export function expectStatus(res: { statusCode: number }, expected: number, body?: unknown) {
  if (res.statusCode !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${res.statusCode}. Body: ${JSON.stringify(body ?? res.body ?? res.json?.())}`,
    )
  }
}

export function auth(token: string) {
  return { authorization: `Bearer ${token}` }
}