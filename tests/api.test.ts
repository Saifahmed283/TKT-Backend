import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startTestApp, stopTestApp, app, registerUser, createOrg, createEvent, goLive, setEventStatus, createArea, createTeam, assignStaff, auth, expectStatus } from './helpers.js'
import { prisma } from '../src/lib/db.js'

const cleanupIds: string[] = []

beforeAll(async () => {
  await startTestApp()
})

afterAll(async () => {
  for (const id of cleanupIds) {
    await prisma.organization.deleteMany({ where: { id } }).catch(() => {})
  }
  // Best-effort user cleanup (may be blocked by remaining FK references)
  await prisma.user.deleteMany({ where: { email: { endsWith: '@test.tkt' } } }).catch(() => {})
  await stopTestApp()
})

describe('auth', () => {
  it('registers, logs in, and fetches /me', async () => {
    const u = await registerUser('AuthFlow')
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(u.token) })
    expectStatus(me, 200)
    expect(me.json().data.email).toBe(u.email)
  })

  it('rejects duplicate registration', async () => {
    const u = await registerUser('DupUser')
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { name: u.name, email: u.email, password: 'TestPass123!' },
    })
    expectStatus(res, 409)
  })

  it('rejects wrong password', async () => {
    const u = await registerUser('WrongPass')
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: u.email, password: 'nope' },
    })
    expectStatus(res, 401)
  })

  it('rejects requests without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/events' })
    expectStatus(res, 401)
  })
})

describe('organizations', () => {
  it('creator becomes OWNER and can list the org', async () => {
    const u = await registerUser('OrgOwner')
    const orgId = await createOrg(u.token, `Org ${Date.now()}`)
    cleanupIds.push(orgId)
    const list = await app.inject({ method: 'GET', url: '/organizations', headers: auth(u.token) })
    expectStatus(list, 200)
    expect(list.json().data.some((o: any) => o.id === orgId)).toBe(true)
  })

  it('non-member cannot view org (IDOR)', async () => {
    const owner = await registerUser('OrgOwner2')
    const outsider = await registerUser('OrgOutsider')
    const orgId = await createOrg(owner.token, `Org IDOR ${Date.now()}`)
    cleanupIds.push(orgId)
    const res = await app.inject({ method: 'GET', url: `/organizations/${orgId}`, headers: auth(outsider.token) })
    expectStatus(res, 403)
  })

  it('viewer cannot update org settings', async () => {
    const owner = await registerUser('OrgOwner3')
    const viewer = await registerUser('OrgViewer')
    const orgId = await createOrg(owner.token, `Org View ${Date.now()}`)
    cleanupIds.push(orgId)
    await app.inject({
      method: 'POST',
      url: `/organizations/${orgId}/members`,
      headers: auth(owner.token),
      payload: { email: viewer.email, role: 'VIEWER' },
    })
    const res = await app.inject({
      method: 'PATCH',
      url: `/organizations/${orgId}`,
      headers: auth(viewer.token),
      payload: { name: 'Hijacked' },
    })
    expectStatus(res, 403)
  })
})

describe('event isolation & RBAC at API level', () => {
  it('org admin can create event; outsider of the org cannot', async () => {
    const u = await registerUser('EvtAdmin')
    const outsider = await registerUser('EvtOutsider')
    const orgId = await createOrg(u.token, `Org Evt ${Date.now()}`)
    cleanupIds.push(orgId)
    const eventId = await createEvent(u.token, orgId, `Event ${Date.now()}`)

    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: auth(outsider.token),
      payload: { organizationId: orgId, name: 'Hijack Event', startAt: new Date().toISOString() },
    })
    expectStatus(res, 403)
    expect(eventId).toBeTruthy()
  })

  it('staff of event A cannot read event B (cross-event access denied)', async () => {
    const u = await registerUser('CrossEvt')
    const staff = await registerUser('CrossEvtStaff')
    const orgId = await createOrg(u.token, `Org Cross ${Date.now()}`)
    cleanupIds.push(orgId)
    const evtA = await createEvent(u.token, orgId, `Event A ${Date.now()}`)
    const evtB = await createEvent(u.token, orgId, `Event B ${Date.now()}`)

    await assignStaff(u.token, evtA, staff.userId, 'registration_staff')

    const resA = await app.inject({ method: 'GET', url: `/events/${evtA}`, headers: auth(staff.token) })
    expectStatus(resA, 200)
    const resB = await app.inject({ method: 'GET', url: `/events/${evtB}`, headers: auth(staff.token) })
    expectStatus(resB, 403)
  })

  it('org members cannot access another orgs event (cross-org)', async () => {
    const u1 = await registerUser('OrgCross1')
    const u2 = await registerUser('OrgCross2')
    const org1 = await createOrg(u1.token, `Org C1 ${Date.now()}`)
    const org2 = await createOrg(u2.token, `Org C2 ${Date.now()}`)
    cleanupIds.push(org1, org2)
    const evt1 = await createEvent(u1.token, org1, `Event C1 ${Date.now()}`)
    const evt2 = await createEvent(u2.token, org2, `Event C2 ${Date.now()}`)

    // u1 (org1 admin) shouldn't see org2's event
    const list = await app.inject({ method: 'GET', url: '/events', headers: auth(u1.token) })
    expectStatus(list, 200)
    const ids = list.json().data.map((e: any) => e.id)
    expect(ids).toContain(evt1)
    expect(ids).not.toContain(evt2)

    const direct = await app.inject({ method: 'GET', url: `/events/${evt2}`, headers: auth(u1.token) })
    expectStatus(direct, 403)
  })

  it('staff cannot assign members without event.members.assign', async () => {
    const u = await registerUser('AssignTest')
    const staff = await registerUser('AssignStaff')
    const target = await registerUser('AssignTarget')
    const orgId = await createOrg(u.token, `Org Asg ${Date.now()}`)
    cleanupIds.push(orgId)
    const eventId = await createEvent(u.token, orgId, `Event Asg ${Date.now()}`)
    await setEventStatus(u.token, eventId, 'PLANNING')

    await assignStaff(u.token, eventId, staff.userId, 'support_staff')

    const res = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/members`,
      headers: auth(staff.token),
      payload: { userId: target.userId, roleId: (await app.inject({ method: 'GET', url: '/organizations/roles/catalog', headers: auth(u.token) })).json().data.find((r: any) => r.code === 'event_manager').id },
    })
    expectStatus(res, 403)
  })
})

describe('scanner scope enforcement (API level)', () => {
  it('scanner can scan in assigned area, forbidden in others', async () => {
    const u = await registerUser('ScanAdmin')
    const scanner = await registerUser('ScanStaff')
    const orgId = await createOrg(u.token, `Org Scan ${Date.now()}`)
    cleanupIds.push(orgId)
    const eventId = await createEvent(u.token, orgId, `Event Scan ${Date.now()}`, { live: true })
    await goLive(u.token, eventId)

    const areaMain = (await createArea(u.token, eventId, 'Scan Main Gate')).json().data
    const areaVip = (await createArea(u.token, eventId, 'Scan VIP Gate')).json().data

    await assignStaff(u.token, eventId, scanner.userId, 'access_scanner', undefined, [areaMain.id])

    // attendee + ticket + credential
    const attendee = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/attendees`,
      headers: auth(u.token),
      payload: { name: 'Scan Attendee', email: 'scan@test.tkt' },
    })
    const attendeeId = attendee.json().data.id
    const ticketType = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/tickets/types`,
      headers: auth(u.token),
      payload: { name: 'GA', price: 10 },
    })
    const ticket = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/tickets`,
      headers: auth(u.token),
      payload: { attendeeId, ticketTypeId: ticketType.json().data.id },
    })
    const credential = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/credentials`,
      headers: auth(u.token),
      payload: { attendeeId, ticketId: ticket.json().data.id, areaIds: [areaMain.id] },
    })
    const code = credential.json().data.code

    // scan in assigned area â†’ GRANTED
    const scanOk = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/access/validate`,
      headers: auth(scanner.token),
      payload: { code, areaId: areaMain.id },
    })
    expectStatus(scanOk, 200)
    expect(scanOk.json().data.result).toBe('GRANTED')

    // scan in unassigned area â†’ 403 (scope) even though credential allows it
    const scanVip = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/access/validate`,
      headers: auth(scanner.token),
      payload: { code, areaId: areaVip.id },
    })
    expectStatus(scanVip, 403)

    // second scan of consumed credential â†’ DENIED ALREADY_USED
    const scanAgain = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/access/validate`,
      headers: auth(scanner.token),
      payload: { code, areaId: areaMain.id },
    })
    expectStatus(scanAgain, 200)
    expect(scanAgain.json().data.result).toBe('DENIED')
    expect(scanAgain.json().data.reason).toBe('ALREADY_USED')
  })

  it('revoked credential is denied even for event manager', async () => {
    const u = await registerUser('RevokeAdmin')
    const orgId = await createOrg(u.token, `Org Rev ${Date.now()}`)
    cleanupIds.push(orgId)
    const eventId = await createEvent(u.token, orgId, `Event Rev ${Date.now()}`, { live: true })
    await goLive(u.token, eventId)

    const areaRes = await createArea(u.token, eventId, 'Rev Gate')
    expectStatus(areaRes, 201)
    const area = areaRes.json().data
    const attendee = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/attendees`,
      headers: auth(u.token),
      payload: { name: 'Rev Attendee' },
    })
    expectStatus(attendee, 201)
    const ticketType = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/tickets/types`,
      headers: auth(u.token),
      payload: { name: 'GA', price: 10 },
    })
    expectStatus(ticketType, 201)
    const ticket = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/tickets`,
      headers: auth(u.token),
      payload: { attendeeId: attendee.json().data.id, ticketTypeId: ticketType.json().data.id },
    })
    expectStatus(ticket, 201)
    const credential = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/credentials`,
      headers: auth(u.token),
      payload: { attendeeId: attendee.json().data.id, ticketId: ticket.json().data.id, areaIds: [area.id] },
    })
    expectStatus(credential, 201)
    const cred = credential.json().data

    // revoke
    const revoke = await app.inject({
      method: 'PATCH',
      url: `/events/${eventId}/credentials/${cred.id}/status`,
      headers: auth(u.token),
      payload: { status: 'REVOKED' },
    })
    expectStatus(revoke, 200)

    const scan = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/access/validate`,
      headers: auth(u.token),
      payload: { code: cred.code, areaId: area.id },
    })
    expect(scan.json().data.result).toBe('DENIED')
    expect(scan.json().data.reason).toBe('REVOKED')
  })

  it('tampered QR code is denied as INVALID_CREDENTIAL', async () => {
    const u = await registerUser('TamperAdmin')
    const orgId = await createOrg(u.token, `Org Tmp ${Date.now()}`)
    cleanupIds.push(orgId)
    const eventId = await createEvent(u.token, orgId, `Event Tmp ${Date.now()}`, { live: true })
    await goLive(u.token, eventId)
    const area = (await createArea(u.token, eventId, 'Tmp Gate')).json().data

    const scan = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/access/validate`,
      headers: auth(u.token),
      payload: { code: 'TKT1.ZmFrZS5wYXlsb2Fk.WmFrZVNpZ25hdHVyZQ', areaId: area.id },
    })
    expectStatus(scan, 200)
    expect(scan.json().data.result).toBe('DENIED')
    expect(scan.json().data.reason).toBe('INVALID_CREDENTIAL')
  })

  it('audit log is written for access decisions and staff assignment', async () => {
    const u = await registerUser('AuditAdmin')
    const staff = await registerUser('AuditStaff')
    const orgId = await createOrg(u.token, `Org Aud ${Date.now()}`)
    cleanupIds.push(orgId)
    const eventId = await createEvent(u.token, orgId, `Event Aud ${Date.now()}`)

    await assignStaff(u.token, eventId, staff.userId, 'security_staff')

    const logs = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/audit-logs`,
      headers: auth(u.token),
    })
    expectStatus(logs, 200)
    const actions = logs.json().data.rows.map((r: any) => r.action)
    expect(actions).toContain('staff.assigned')
    expect(actions).toContain('event.created')
  })

  it('team lead scope: cannot read other teams tasks', async () => {
    const u = await registerUser('TeamAdmin')
    const lead = await registerUser('TeamLeadX')
    const orgId = await createOrg(u.token, `Org TL ${Date.now()}`)
    cleanupIds.push(orgId)
    const eventId = await createEvent(u.token, orgId, `Event TL ${Date.now()}`)

    const teamA = (await createTeam(u.token, eventId, 'Team A')).json().data
    const teamB = (await createTeam(u.token, eventId, 'Team B')).json().data
    await assignStaff(u.token, eventId, lead.userId, 'team_lead', teamA.id)

    // create a task in team B as admin
    await app.inject({
      method: 'POST',
      url: `/events/${eventId}/tasks`,
      headers: auth(u.token),
      payload: { title: 'Team B secret task', teamId: teamB.id },
    })

    const tasks = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/tasks`,
      headers: auth(lead.token),
    })
    expectStatus(tasks, 200)
    expect(tasks.json().data.every((t: any) => t.teamId === teamA.id || t.teamId === null)).toBe(true)
  })
})

describe('incidents (assignment & catalog endpoints)', () => {
  it('creates an incident assigned to a member by eventMember id', async () => {
    const u = await registerUser('IncAdmin')
    const assignee = await registerUser('IncAssignee')
    const orgId = await createOrg(u.token, `Org Inc ${Date.now()}`)
    cleanupIds.push(orgId)
    const eventId = await createEvent(u.token, orgId, `Event Inc ${Date.now()}`)

    const member = await assignStaff(u.token, eventId, assignee.userId, 'support_staff')

    const res = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/incidents`,
      headers: auth(u.token),
      payload: { title: 'Gate line too long', priority: 'HIGH', assignedToId: member.id },
    })
    expectStatus(res, 201)
    expect(res.json().data.assignedUserId).toBe(assignee.userId)

    const list = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/incidents`,
      headers: auth(u.token),
    })
    expectStatus(list, 200)
    const inc = list.json().data.find((i: any) => i.id === res.json().data.id)
    expect(inc.assignee.name).toBe(assignee.name)
    expect(inc.comments).toBeInstanceOf(Array)
  })

  it('rejects assignment to a member of another event', async () => {
    const u = await registerUser('IncAdmin2')
    const foreign = await registerUser('IncForeign')
    const orgId = await createOrg(u.token, `Org Inc2 ${Date.now()}`)
    cleanupIds.push(orgId)
    const eventA = await createEvent(u.token, orgId, `Event IncA ${Date.now()}`)
    const eventB = await createEvent(u.token, orgId, `Event IncB ${Date.now()}`)

    const foreignMember = await assignStaff(u.token, eventA, foreign.userId, 'support_staff')

    const res = await app.inject({
      method: 'POST',
      url: `/events/${eventB}/incidents`,
      headers: auth(u.token),
      payload: { title: 'Wrong event assignee', assignedToId: foreignMember.id },
    })
    expectStatus(res, 400)
  })

  it('event roles endpoint returns assignable system + custom roles', async () => {
    const u = await registerUser('RolesAdmin')
    const orgId = await createOrg(u.token, `Org Roles ${Date.now()}`)
    cleanupIds.push(orgId)
    const eventId = await createEvent(u.token, orgId, `Event Roles ${Date.now()}`)

    const roles = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/roles`,
      headers: auth(u.token),
    })
    expectStatus(roles, 200)
    expect(roles.json().data.system.length).toBeGreaterThan(0)
    expect(roles.json().data.system.every((r: any) => typeof r.id === 'string')).toBe(true)
  })

  it('org-users endpoint flags already-assigned members', async () => {
    const u = await registerUser('OrgUsersAdmin')
    const staffUser = await registerUser('OrgUsersStaff')
    const orgId = await createOrg(u.token, `Org OU ${Date.now()}`)
    cleanupIds.push(orgId)
    const eventId = await createEvent(u.token, orgId, `Event OU ${Date.now()}`)

    await app.inject({
      method: 'POST',
      url: `/organizations/${orgId}/members`,
      headers: auth(u.token),
      payload: { email: staffUser.email, role: 'ADMIN' },
    })

    const before = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/org-users`,
      headers: auth(u.token),
    })
    expectStatus(before, 200)
    const entry = before.json().data.find((m: any) => m.id === staffUser.userId)
    expect(entry.assigned).toBe(false)

    await assignStaff(u.token, eventId, staffUser.userId, 'support_staff')

    const after = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/org-users`,
      headers: auth(u.token),
    })
    expectStatus(after, 200)
    expect(after.json().data.find((m: any) => m.id === staffUser.userId).assigned).toBe(true)
  })
})