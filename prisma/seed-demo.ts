// Demo dataset: one organization, one LIVE event with teams, areas,
// attendees, tickets, credentials, tasks, incidents, access logs.
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { hashPassword } from '../src/lib/auth.js'
import { credentialCode, type CredentialPayload } from '../src/lib/credentials.js'

const prisma = new PrismaClient()

async function main() {
  // ── Users ────────────────────────────────────────────────
  const pw = await hashPassword('Staff12345!')
  const staff = [
    ['Ahmed Hassan', 'ahmed@tkt.local', 'event_manager'],
    ['Sara Ali', 'sara@tkt.local', 'team_lead'],
    ['Mohamed Omar', 'mohamed@tkt.local', 'access_scanner'],
    ['Laila Nour', 'laila@tkt.local', 'registration_staff'],
    ['Youssef Karim', 'youssef@tkt.local', 'security_staff'],
    ['Nadia Fathy', 'nadia@tkt.local', 'technical_staff'],
    ['Omar Salah', 'omar@tkt.local', 'operations_staff'],
    ['Hana Mostafa', 'hana@tkt.local', 'medical_staff'],
  ] as const

  const userRecords: Record<string, string> = {}
  for (const [name, email, role] of staff) {
    let user = await prisma.user.findUnique({ where: { email } })
    if (!user) {
      user = await prisma.user.create({
        data: { name, email, passwordHash: pw },
      })
    }
    userRecords[role] = user.id
  }

  // ── Organization ─────────────────────────────────────────
  let org = await prisma.organization.findUnique({ where: { slug: 'nova-events' } })
  if (!org) {
    org = await prisma.organization.create({
      data: { name: 'Nova Events', slug: 'nova-events', description: 'Full-service event production' },
    })
  }
  const orgId = org.id

  for (const id of Object.values(userRecords)) {
    const exists = await prisma.organizationMember.findUnique({
      where: { orgId_userId: { orgId, userId: id } },
    })
    if (!exists) {
      await prisma.organizationMember.create({ data: { orgId, userId: id, role: 'ADMIN' } })
    }
  }

  // ── Event ────────────────────────────────────────────────
  const start = new Date()
  start.setHours(start.getHours() - 2)
  const end = new Date(start.getTime() + 10 * 3600 * 1000)

  let event = await prisma.event.findFirst({ where: { name: 'Tech Frontier 2026' } })
  if (!event) {
    event = await prisma.event.create({
      data: {
        orgId,
        name: 'Tech Frontier 2026',
        description: 'Annual technology conference — live operations demo',
        type: 'CONFERENCE',
        status: 'LIVE',
        startAt: start,
        endAt: end,
        timezone: 'Africa/Cairo',
        venueName: 'Cairo International Convention Center',
        venueAddress: 'Nasr City, Cairo',
        settings: { registration: { enabled: true, open: true } },
      },
    })
  }
  const eventId = event.id

  // ── Roles ────────────────────────────────────────────────
  const roleByCode = async (code: string) => prisma.role.findUniqueOrThrow({ where: { code } })

  // ── Teams ────────────────────────────────────────────────
  const teams: Record<string, string> = {}
  const teamDefs = [
    ['Registration Team', 'Handles check-in and registration'],
    ['Guest Services', 'Guides and assists attendees'],
    ['Security Team', 'Access control and crowd safety'],
    ['Operations Team', 'Venue operations and logistics'],
    ['Technical Team', 'AV, lighting and production'],
    ['Medical Team', 'First aid and emergency response'],
  ]
  for (const [name, desc] of teamDefs) {
    let team = await prisma.team.findFirst({ where: { eventId, name } })
    if (!team) {
      team = await prisma.team.create({ data: { eventId, name, description: desc } })
    }
    teams[name] = team.id
  }

  // ── Areas ────────────────────────────────────────────────
  const areas: Record<string, string> = {}
  const areaDefs: [string, string, any, any][] = [
    ['Main Gate', 'Primary entrance', 'GATE', 'TICKETED'],
    ['VIP Gate', 'VIP and speaker entrance', 'GATE', 'VIP_ONLY'],
    ['Conference Hall', 'Main stage sessions', 'HALL', 'TICKETED'],
    ['Backstage', 'Production and speaker prep', 'STAGE', 'STAFF_ONLY'],
    ['Media Area', 'Press and media zone', 'OFFICE', 'MEDIA_ONLY'],
    ['Staff Area', 'Staff-only rest zone', 'OFFICE', 'STAFF_ONLY'],
    ['Medical Point', 'First aid station', 'MEDICAL', 'OPEN'],
    ['Registration Desk', 'Attendee check-in', 'SERVICE', 'STAFF_ONLY'],
    ['Speaker Lounge', 'VIP lounge for speakers', 'LOUNGE', 'VIP_ONLY'],
    ['Parking', 'Event parking', 'PARKING', 'OPEN'],
  ]
  for (const [name, desc, type, policy] of areaDefs) {
    let area = await prisma.area.findFirst({ where: { eventId, name } })
    if (!area) {
      area = await prisma.area.create({
        data: { eventId, name, description: desc, type, accessPolicy: policy },
      })
    }
    areas[name] = area.id
  }

  // ── Event members ────────────────────────────────────────
  const memberDefs: [string, string, string?, string[]?][] = [
    ['event_manager', 'Ahmed Hassan', undefined, []],
    ['team_lead', 'Sara Ali', 'Registration Team', ['Registration Desk', 'Main Gate']],
    ['access_scanner', 'Mohamed Omar', 'Security Team', ['Main Gate']],
    ['registration_staff', 'Laila Nour', 'Registration Team', ['Registration Desk']],
    ['security_staff', 'Youssef Karim', 'Security Team', ['Main Gate', 'Backstage', 'VIP Gate']],
    ['technical_staff', 'Nadia Fathy', 'Technical Team', ['Conference Hall', 'Backstage']],
    ['operations_staff', 'Omar Salah', 'Operations Team', ['Parking', 'Staff Area']],
    ['medical_staff', 'Hana Mostafa', 'Medical Team', ['Medical Point']],
  ]
  for (const [roleCode, staffName, teamName, areaNames] of memberDefs) {
    const role = await roleByCode(roleCode)
    const user = await prisma.user.findFirst({ where: { name: staffName } })
    if (!user) continue
    const exists = await prisma.eventMember.findUnique({
      where: { eventId_userId: { eventId, userId: user.id } },
    })
    if (!exists) {
      await prisma.eventMember.create({
        data: {
          eventId,
          userId: user.id,
          roleId: role.id,
          teamId: teamName ? teams[teamName] : undefined,
          areas: areaNames?.length
            ? { create: areaNames.map((n) => ({ areaId: areas[n] })) }
            : undefined,
        },
      })
    }
  }

  // ── Ticket types ─────────────────────────────────────────
  const ticketTypes: Record<string, string> = {}
  const typeDefs: [string, number][] = [
    ['General Admission', 50],
    ['VIP', 250],
    ['Speaker Pass', 0],
    ['Press Pass', 0],
  ]
  for (const [name, price] of typeDefs) {
    let tt = await prisma.ticketType.findFirst({ where: { eventId, name } })
    if (!tt) {
      tt = await prisma.ticketType.create({
        data: { eventId, name, price, quota: 1000 },
      })
    }
    ticketTypes[name] = tt.id
  }

  // ── Attendees + tickets + credentials ────────────────────
  const attendees = [
    ['Mona Ibrahim', 'mona@example.com', 'VIP', 'VIP'],
    ['Khaled Said', 'khaled@example.com', null, 'General Admission'],
    ['Dina Adel', 'dina@example.com', 'SPEAKER', 'Speaker Pass'],
    ['Tarek Fouad', 'tarek@example.com', 'PRESS', 'Press Pass'],
    ['Amira Samir', 'amira@example.com', null, 'General Admission'],
    ['Hossam El-Deen', 'hossam@example.com', 'VIP', 'VIP'],
    ['Farah Kamal', 'farah@example.com', null, 'General Admission'],
    ['Mostafa Atef', 'mostafa@example.com', null, 'General Admission'],
    ['Reem Galal', 'reem@example.com', 'VIP', 'VIP'],
    ['Karim Wael', 'karim@example.com', null, 'General Admission'],
  ] as const

  const managerId = userRecords['event_manager']

  for (const [name, email, category, ticketName] of attendees) {
    let attendee = await prisma.attendee.findFirst({ where: { eventId, email } })
    if (!attendee) {
      attendee = await prisma.attendee.create({
        data: {
          eventId,
          name,
          email,
          category,
          registeredById: managerId,
          status: 'REGISTERED',
        },
      })
    }
    const hasTicket = await prisma.ticket.findFirst({ where: { eventId, attendeeId: attendee.id } })
    if (!hasTicket) {
      const ticket = await prisma.ticket.create({
        data: {
          eventId,
          attendeeId: attendee.id,
          ticketTypeId: ticketTypes[ticketName],
          status: 'ACTIVE',
          issuedById: managerId,
          price: (await prisma.ticketType.findUnique({ where: { id: ticketTypes[ticketName] } }))?.price,
        },
      })
      const tt = await prisma.ticketType.findUnique({ where: { id: ticketTypes[ticketName] } })
      const credential = await prisma.credential.create({
        data: {
          eventId,
          attendeeId: attendee.id,
          ticketId: ticket.id,
          type: 'QR',
          status: 'ACTIVE',
          validFrom: start,
          validUntil: end,
          singleUse: true,
          allowReentry: false,
          areaIds: ticketName === 'VIP' || ticketName === 'Speaker Pass'
            ? [areas['Main Gate'], areas['VIP Gate'], areas['Conference Hall'], areas['Speaker Lounge']]
            : ticketName === 'Press Pass'
              ? [areas['Main Gate'], areas['Conference Hall'], areas['Media Area']]
              : [areas['Main Gate'], areas['Conference Hall']],
          issuedById: managerId,
          code: `PENDING-${crypto.randomUUID()}`,
        },
      })
      const payload: CredentialPayload = {
        v: 1,
        credId: credential.id,
        attendeeId: attendee.id,
        eventId,
        ticketType: tt!.name,
        attendeeName: attendee.name,
        validFrom: start.getTime(),
        validUntil: end.getTime(),
        singleUse: true,
        allowReentry: false,
      }
      await prisma.credential.update({ where: { id: credential.id }, data: { code: credentialCode.encode(payload) } })
    }
  }

  // ── Tasks ────────────────────────────────────────────────
  const tasks: [string, string, any, string?, string?][] = [
    ['Verify registration desks', 'Confirm 6 desks powered and stocked', 'DONE', 'Registration Team', 'Registration Desk'],
    ['Soundcheck main stage', 'Full audio pass before doors', 'DONE', 'Technical Team', 'Conference Hall'],
    ['Test emergency equipment', 'Fire alarms and exits verified', 'DONE', 'Security Team', 'Conference Hall'],
    ['Open Main Gate', 'Doors open for GA attendees', 'IN_PROGRESS', 'Security Team', 'Main Gate'],
    ['Set up media area', 'Press check-in and photo lines', 'IN_PROGRESS', 'Operations Team', 'Media Area'],
    ['Stock medical point', 'First aid kits and water', 'DONE', 'Medical Team', 'Medical Point'],
    ['Prepare VIP lounge', 'Refreshments and seating', 'TODO', 'Guest Services', 'Speaker Lounge'],
    ['Monitor crowd at gate', 'Rotating checks every 30 minutes', 'IN_PROGRESS', 'Security Team', 'Main Gate'],
    ['Check stage lighting', 'Verify preset scenes', 'TODO', 'Technical Team', 'Backstage'],
    ['Teardown planning', 'Draft teardown schedule for 22:00', 'TODO', 'Operations Team', null],
  ]

  for (const [title, desc, status, teamName, areaName] of tasks) {
    const exists = await prisma.task.findFirst({ where: { eventId, title } })
    if (!exists) {
      await prisma.task.create({
        data: {
          eventId,
          title,
          description: desc,
          status,
          teamId: teamName ? teams[teamName] : null,
          areaId: areaName ? areas[areaName] : null,
          createdById: managerId,
          completedAt: status === 'DONE' ? new Date(Date.now() - 3600_000) : null,
          completedById: status === 'DONE' ? managerId : null,
          checklist: [
            { done: true, text: 'Location confirmed' },
            { done: status === 'DONE', text: 'Equipment verified' },
            { done: false, text: 'Photo evidence uploaded' },
          ],
        },
      })
    }
  }

  // ── Incidents ────────────────────────────────────────────
  const incidents: [string, string, string, string, string?, string?][] = [
    ['Stage mic feedback', 'Microphone 2 has persistent feedback on podium', 'TECHNICAL', 'MEDIUM', 'Conference Hall', 'Technical Team'],
    ['Attendee feeling unwell', 'Guest at Hall exit reports dizziness', 'MEDICAL', 'HIGH', 'Medical Point', 'Medical Team'],
    ['Crowd buildup at gate', 'Queue exceeding 10 minutes at Main Gate', 'CROWD', 'HIGH', 'Main Gate', 'Security Team'],
    ['VIP lounge access check', 'Verifying VIP list at Speaker Lounge', 'SECURITY', 'LOW', 'Speaker Lounge', 'Security Team'],
  ]
  for (const [title, desc, type, priority, areaName, teamName] of incidents) {
    const exists = await prisma.incident.findFirst({ where: { eventId, title } })
    if (!exists) {
      await prisma.incident.create({
        data: {
          eventId,
          code: `INC-${String((await prisma.incident.count({ where: { eventId } })) + 1).padStart(4, '0')}`,
          title,
          description: desc,
          type,
          priority,
          status: priority === 'LOW' ? 'CLOSED' : 'IN_PROGRESS',
          areaId: areaName ? areas[areaName] : null,
          assignedTeamId: teamName ? teams[teamName] : null,
          createdById: managerId,
        },
      })
    }
  }

  // ── Access logs ──────────────────────────────────────────
  const logCount = await prisma.accessLog.count({ where: { eventId } })
  if (logCount === 0) {
    const creds = await prisma.credential.findMany({ where: { eventId }, include: { attendee: true } })
    const now = Date.now()
    for (let i = 0; i < creds.length && i < 8; i++) {
      const cred = creds[i]!
      const granted = i % 4 !== 3 // every 4th denied
      await prisma.accessLog.create({
        data: {
          eventId,
          credentialId: cred.id,
          attendeeId: cred.attendeeId,
          operatorUserId: userRecords['access_scanner'],
          areaId: areas['Main Gate'],
          result: granted ? 'GRANTED' : 'DENIED',
          reason: granted ? 'NONE' : 'WRONG_AREA',
          timestamp: new Date(now - (8 - i) * 4 * 60_000),
        },
      })
    }
    const checked = await prisma.credential.findMany({ where: { eventId }, take: 5, select: { attendeeId: true } })
    await prisma.attendee.updateMany({
      where: { id: { in: checked.map((c) => c.attendeeId) } },
      data: { status: 'CHECKED_IN' },
    })
    await prisma.credential.updateMany({
      where: { id: { in: checked.map((c) => c.attendeeId) }, status: 'ACTIVE' },
      data: { status: 'CONSUMED' },
    }).catch(() => {})
  }

  // ── Announcements ────────────────────────────────────────
  const annCount = await prisma.announcement.count({ where: { eventId } })
  if (annCount === 0) {
    await prisma.announcement.createMany({
      data: [
        {
          eventId,
          authorId: managerId,
          title: 'Doors open — Main Gate active',
          body: 'GA check-in is running smoothly. Gate teams, rotate every 30 minutes.',
          priority: 'HIGH',
          targetAudience: { scope: 'TEAMS', teamIds: [teams['Security Team']] },
        },
        {
          eventId,
          authorId: managerId,
          title: 'Keynote moved to 10:30',
          body: 'The opening keynote shifts 15 minutes later. Hall teams adjust signage.',
          priority: 'MEDIUM',
          targetAudience: { scope: 'ALL_STAFF' },
        },
      ],
    })
  }

  // ── Public site: upcoming & past events ──────────────────
  const upcomingDefs = [
    {
      name: 'Egypt Tech Summit 2026',
      description: 'Three days of product, AI and engineering — the largest developer summit in the region.',
      type: 'CONFERENCE',
      daysFromNow: 30,
      venueName: 'Grand Nile Tower Ballroom',
      venueAddress: 'Cairo',
      ticketTypes: [['Early Bird', 120], ['Standard', 180], ['VIP + Workshop', 450]] as const,
    },
    {
      name: 'Cairo Sound Festival 2026',
      description: 'A weekend of live bands, electronic stages and food markets under the stars.',
      type: 'CONCERT',
      daysFromNow: 45,
      venueName: 'Al-Azhar Park Outdoor Stage',
      venueAddress: 'Cairo',
      ticketTypes: [['General Admission', 60], ['VIP Deck', 200]] as const,
    },
    {
      name: 'Nile Valley Film Nights',
      description: 'Open-air screenings and director talks by the river.',
      type: 'FESTIVAL',
      daysFromNow: 15,
      venueName: 'Zamalek Riverfront',
      venueAddress: 'Cairo',
      ticketTypes: [['Screening Pass', 25], ['Festival Pass', 80]] as const,
    },
  ]

  for (const def of upcomingDefs) {
    const startAt = new Date(Date.now() + def.daysFromNow * 24 * 3600 * 1000)
    const endAt = new Date(startAt.getTime() + 8 * 3600 * 1000)
    let ev = await prisma.event.findFirst({ where: { name: def.name } })
    if (!ev) {
      ev = await prisma.event.create({
        data: {
          orgId: org.id,
          name: def.name,
          description: def.description,
          type: def.type,
          status: 'PUBLISHED',
          startAt,
          endAt,
          venueName: def.venueName,
          venueAddress: def.venueAddress,
          settings: { registration: { enabled: true, open: true } },
        },
      })
      for (const [tName, price] of def.ticketTypes) {
        await prisma.ticketType.create({
          data: { eventId: ev.id, name: tName, price, quota: 200 },
        })
      }
      await logActivity(ev.id, 'event', def.name + ' published', 'System')
    } else {
      ev = await prisma.event.update({
        where: { id: ev.id },
        data: {
          status: 'PUBLISHED',
          startAt,
          endAt,
          settings: { registration: { enabled: true, open: true } },
        },
      })
    }
  }

  const pastDefs = [
    {
      name: 'Startup Expo 2025',
      description: 'The region\'s startup showcase — 120 exhibitors, 40 investors, one packed floor.',
      type: 'EXHIBITION',
      status: 'COMPLETED',
      daysAgo: 200,
      venueName: 'Cairo International Fair',
      venueAddress: 'Nasr City, Cairo',
      attendees: [
        ['Omar Khaled', 'ok@example.com'],
        ['Nour El-Sayed', 'nour@example.com'],
        ['Ali Hassan', 'alih@example.com'],
        ['Mariam Adel', 'mariam@example.com'],
        ['Seif Abaza', 'seif@example.com'],
        ['Heba Fouad', 'heba@example.com'],
        ['Adham Rami', 'adham@example.com'],
        ['Salma Tarek', 'salma@example.com'],
      ],
    },
    {
      name: 'Cairo Design Week 2025',
      description: 'Design talks, installations and workshops across three venues in downtown Cairo.',
      type: 'EXHIBITION',
      status: 'COMPLETED',
      daysAgo: 140,
      venueName: 'Al-Masa Hotel Galleria',
      venueAddress: 'Garden City, Cairo',
      attendees: [
        ['Lina Fawzy', 'lina@example.com'],
        ['Kareem Botros', 'kareemb@example.com'],
        ['Yasmine Lotfy', 'yasminel@example.com'],
        ['Marwan Diab', 'marwand@example.com'],
        ['Nada Shokry', 'nadas@example.com'],
      ],
    },
    {
      name: 'Alexandria Marathon 2025',
      description: '10K, 21K and full marathon along the Corniche — 2,400 runners, one morning.',
      type: 'SPORTS',
      status: 'ARCHIVED',
      daysAgo: 320,
      venueName: 'Alexandria Corniche',
      venueAddress: 'Alexandria',
      attendees: [
        ['Mostafa Gamal', 'mg@example.com'],
        ['Dina Sherif', 'dinas@example.com'],
        ['Hassan Metwally', 'hassanm@example.com'],
        ['Rana Emad', 'ranae@example.com'],
        ['Tamer Zaki', 'tamerz@example.com'],
      ],
    },
  ]

  for (const def of pastDefs) {
    const start = new Date(Date.now() - def.daysAgo * 24 * 3600 * 1000)
    start.setHours(9, 0, 0, 0)
    const end = new Date(start.getTime() + 8 * 3600 * 1000)
    let ev = await prisma.event.findFirst({ where: { name: def.name } })
    if (!ev) {
      ev = await prisma.event.create({
        data: {
          orgId,
          name: def.name,
          description: def.description,
          type: def.type as any,
          status: def.status as any,
          startAt: start,
          endAt: end,
          timezone: 'Africa/Cairo',
          venueName: def.venueName,
          venueAddress: def.venueAddress,
          settings: { registration: { enabled: false, open: false } },
        },
      })
    } else {
      await prisma.event.update({ where: { id: ev.id }, data: { status: def.status as any, startAt: start, endAt: end, settings: { registration: { enabled: false, open: false } } } })
    }
    let ga = await prisma.ticketType.findFirst({ where: { eventId: ev.id, name: 'General Admission' } })
    if (!ga) ga = await prisma.ticketType.create({ data: { eventId: ev.id, name: 'General Admission', price: 50, quota: 500 } })
    for (const [name, email] of def.attendees) {
      const exists = await prisma.attendee.findFirst({ where: { eventId: ev.id, email } })
      if (exists) continue
      const attendee = await prisma.attendee.create({ data: { eventId: ev.id, name, email, status: 'CHECKED_IN', metadata: { source: 'seed' } } })
      await prisma.ticket.create({ data: { eventId: ev.id, attendeeId: attendee.id, ticketTypeId: ga.id, status: 'CONSUMED', price: 50 } })
    }
  }

  // ── Public reviews ────────────────────────────────────────
  const reviewCount = await prisma.publicReview.count()
  if (reviewCount === 0) {
    await prisma.publicReview.createMany({
      data: [
        {
          author: 'Mona Ibrahim',
          role: 'Conference Attendant',
          content: 'Check-in took three minutes flat. The control center at the gate made everything feel effortless.',
          rating: 5,
          eventName: 'Tech Frontier 2026',
        },
        {
          author: 'Karim Wael',
          role: 'Startup Founder',
          content: 'We ran our entire product launch through TKT. Scans, credentials, incidents — all in one screen.',
          rating: 5,
          eventName: 'Startup Expo 2025',
        },
        {
          author: 'Reem Galal',
          role: 'Event Producer',
          content: 'Finally an operations tool that feels built by people who have actually run events.',
          rating: 5,
          eventName: 'Cairo Design Week 2025',
        },
        {
          author: 'Sara Ali',
          role: 'Operations Lead',
          content: 'The incident workflow saved us during a medical case. Team response time: 90 seconds.',
          rating: 5,
          eventName: 'Tech Frontier 2026',
        },
        {
          author: 'Hossam El-Deen',
          role: 'VIP Guest',
          content: 'Smooth entry, clear staff communication, zero chaos at the VIP gate. Rare in this industry.',
          rating: 4,
          eventName: 'Tech Frontier 2026',
        },
      ],
    })
  }

  console.log('\nDemo data ready:')
  console.log('  Event:      Tech Frontier 2026 (LIVE)')
  console.log('  Org:        Nova Events')
  console.log('  Staff:      ahmed@tkt.local (Event Manager), mohamed@tkt.local (Scanner, Main Gate)')
  console.log('  Password:   Staff12345!')
  console.log('  Admin:      admin@tkt.local / Admin12345! (platform super admin)')
  console.log('  Public:     3 upcoming events, 3 past works, 5 reviews\n')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())