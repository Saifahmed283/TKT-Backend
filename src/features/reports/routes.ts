import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/db.js'
import { errors } from '../../lib/errors.js'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { egyptDateKey } from '../../lib/time.js'

export async function reportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // Attendance report
  app.get('/attendance', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'report.view', { eventId })

    const [byStatus, byCategory, byDay, total] = await Promise.all([
      prisma.attendee.groupBy({ by: ['status'], where: { eventId }, _count: true }),
      prisma.attendee.groupBy({ by: ['category'], where: { eventId }, _count: true, orderBy: { _count: { category: 'desc' } } }),
      prisma.accessLog.groupBy({
        by: ['timestamp'],
        where: { eventId, result: 'GRANTED' },
        _count: true,
      }),
      prisma.attendee.count({ where: { eventId } }),
    ])

    const dayMap = new Map<string, number>()
    for (const row of byDay) {
      const day = egyptDateKey(row.timestamp)
      dayMap.set(day, (dayMap.get(day) ?? 0) + row._count)
    }

    type AttendanceStatusRow = (typeof byStatus)[number]
    type AttendanceCategoryRow = (typeof byCategory)[number]
    return {
      data: {
        total,
        byStatus: byStatus.map((r: AttendanceStatusRow) => ({ status: r.status, count: r._count })),
        byCategory: byCategory.map((r: AttendanceCategoryRow) => ({ category: r.category ?? 'unspecified', count: r._count })),
        dailyCheckIns: [...dayMap.entries()].map(([date, count]) => ({ date, count })),
      },
    }
  })

  // Access report
  app.get('/access', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'report.view', { eventId })

    const [byResult, byReason, byArea, byHour] = await Promise.all([
      prisma.accessLog.groupBy({ by: ['result'], where: { eventId }, _count: true }),
      prisma.accessLog.groupBy({ by: ['reason'], where: { eventId }, _count: true, orderBy: { _count: { reason: 'desc' } } }),
      prisma.accessLog.groupBy({ by: ['areaId'], where: { eventId }, _count: true, orderBy: { _count: { areaId: 'desc' } } }),
      prisma.accessLog.findMany({ where: { eventId }, select: { timestamp: true } }),
    ])

    type HourRow = (typeof byHour)[number]
    type AreaGroup = (typeof byArea)[number]
    type ResultRow = (typeof byResult)[number]
    type ReasonRow = (typeof byReason)[number]
    type AreaInfo = { id: string; name: string }
    const hourMap = new Map<number, number>()
    for (const row of byHour as HourRow[]) {
      const h = row.timestamp.getHours()
      hourMap.set(h, (hourMap.get(h) ?? 0) + 1)
    }

    const areaIds = byArea.map((r: AreaGroup) => r.areaId).filter((id: string | null): id is string => Boolean(id))
    const areas: AreaInfo[] = areaIds.length
      ? await prisma.area.findMany({ where: { id: { in: areaIds } }, select: { id: true, name: true } })
      : []

    return {
      data: {
        byResult: byResult.map((r: ResultRow) => ({ result: r.result, count: r._count })),
        byReason: byReason.map((r: ReasonRow) => ({ reason: r.reason, count: r._count })),
        byArea: byArea.map((r: AreaGroup) => ({ areaId: r.areaId, areaName: areas.find((a: AreaInfo) => a.id === r.areaId)?.name ?? 'unknown', count: r._count })),
        byHour: [...hourMap.entries()].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count })),
      },
    }
  })

  // Incidents report
  app.get('/incidents', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'report.view', { eventId })

    const [byType, byPriority, byStatus, open, avgResolutionHours] = await Promise.all([
      prisma.incident.groupBy({ by: ['type'], where: { eventId }, _count: true }),
      prisma.incident.groupBy({ by: ['priority'], where: { eventId }, _count: true }),
      prisma.incident.groupBy({ by: ['status'], where: { eventId }, _count: true }),
      prisma.incident.count({ where: { eventId, status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED'] } } }),
      prisma.incident.findMany({ where: { eventId, resolvedAt: { not: null } }, select: { createdAt: true, resolvedAt: true } }),
    ])

    type IncidentResolution = (typeof avgResolutionHours)[number]
    type IncidentTypeRow = (typeof byType)[number]
    type IncidentPriorityRow = (typeof byPriority)[number]
    type IncidentStatusRow = (typeof byStatus)[number]
    const avgMs = avgResolutionHours.length
      ? avgResolutionHours.reduce((acc: number, i: IncidentResolution) => acc + ((i.resolvedAt?.getTime() ?? i.createdAt.getTime()) - i.createdAt.getTime()), 0) / avgResolutionHours.length
      : 0

    return {
      data: {
        byType: byType.map((r: IncidentTypeRow) => ({ type: r.type, count: r._count })),
        byPriority: byPriority.map((r: IncidentPriorityRow) => ({ priority: r.priority, count: r._count })),
        byStatus: byStatus.map((r: IncidentStatusRow) => ({ status: r.status, count: r._count })),
        open,
        avgResolutionMinutes: Math.round(avgMs / 60000),
      },
    }
  })

  // Tasks report
  app.get('/tasks', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'report.view', { eventId })

    const [byStatus, byPriority, byTeam, total, done] = await Promise.all([
      prisma.task.groupBy({ by: ['status'], where: { eventId }, _count: true }),
      prisma.task.groupBy({ by: ['priority'], where: { eventId }, _count: true }),
      prisma.task.groupBy({ by: ['teamId'], where: { eventId }, _count: true }),
      prisma.task.count({ where: { eventId } }),
      prisma.task.count({ where: { eventId, status: 'DONE' } }),
    ])

    type StatusRow = (typeof byStatus)[number]
    type PriorityRow = (typeof byPriority)[number]
    type TeamRow = (typeof byTeam)[number]
    type TeamName = { id: string; name: string }
    const teamIds = byTeam.map((r: TeamRow) => r.teamId).filter((id: string | null): id is string => Boolean(id))
    const teams: TeamName[] = teamIds.length
      ? await prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } })
      : []

    return {
      data: {
        total,
        done,
        completionRate: total ? Math.round((done / total) * 100) : 0,
        byStatus: byStatus.map((r: StatusRow) => ({ status: r.status, count: r._count })),
        byPriority: byPriority.map((r: PriorityRow) => ({ priority: r.priority, count: r._count })),
        byTeam: byTeam.map((r: TeamRow) => ({ teamId: r.teamId, teamName: teams.find((t: TeamName) => t.id === r.teamId)?.name ?? 'unassigned', count: r._count })),
      },
    }
  })

  // Finance report
  app.get('/finance', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'report.view', { eventId })

    const [tickets, byType] = await Promise.all([
      prisma.ticket.findMany({
        where: { eventId, status: { in: ['ACTIVE', 'CONSUMED', 'ISSUED'] } },
        select: { price: true },
      }),
      prisma.ticket.groupBy({ by: ['ticketTypeId'], where: { eventId, status: { in: ['ACTIVE', 'CONSUMED', 'ISSUED'] } }, _count: true }),
    ])

    type FinanceTicket = (typeof tickets)[number]
    type FinanceByType = (typeof byType)[number]
    type TicketTypeInfo = { id: string; name: string; price: unknown }
    const revenue = tickets.reduce((acc: number, t: FinanceTicket) => acc + (Number(t.price) || 0), 0)
    const typeIds = byType.map((r: FinanceByType) => r.ticketTypeId)
    const types: TicketTypeInfo[] = typeIds.length
      ? await prisma.ticketType.findMany({ where: { id: { in: typeIds } }, select: { id: true, name: true, price: true } })
      : []

    return {
      data: {
        revenue,
        ticketsSold: tickets.length,
        byType: byType.map((r: FinanceByType) => ({
          ticketTypeId: r.ticketTypeId,
          name: types.find((t: TicketTypeInfo) => t.id === r.ticketTypeId)?.name ?? 'unknown',
          price: Number(types.find((t: TicketTypeInfo) => t.id === r.ticketTypeId)?.price ?? 0),
          sold: r._count,
          subtotal: r._count * Number(types.find((t: TicketTypeInfo) => t.id === r.ticketTypeId)?.price ?? 0),
        })),
      },
    }
  })

  // Combined operations report (dashboard-grade overview for the UI)
  app.get('/', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'report.view', { eventId })

    const [
      attendanceRows, accessRows, incidentRows, taskRows, tickets,
    ] = await Promise.all([
      prisma.attendee.groupBy({ by: ['status'], where: { eventId }, _count: true }),
      prisma.accessLog.groupBy({ by: ['result', 'reason'], where: { eventId }, _count: true }),
      prisma.incident.groupBy({ by: ['status', 'priority'], where: { eventId }, _count: true }),
      prisma.task.groupBy({ by: ['status', 'priority'], where: { eventId }, _count: true }),
      prisma.ticket.findMany({ where: { eventId, status: { in: ['ACTIVE', 'CONSUMED', 'ISSUED'] } }, select: { price: true } }),
    ])

    const attendees = await prisma.attendee.count({ where: { eventId } })
    const checkedIn = await prisma.attendee.count({ where: { eventId, status: 'CHECKED_IN' } })
    type AccessRow = (typeof accessRows)[number]
    type IncidentRow = (typeof incidentRows)[number]
    type TaskRow = (typeof taskRows)[number]
    type TicketRow = (typeof tickets)[number]
    const granted = accessRows.filter((r: AccessRow) => r.result === 'GRANTED').reduce((a: number, r: AccessRow) => a + r._count, 0)
    const denied = accessRows.filter((r: AccessRow) => r.result === 'DENIED').reduce((a: number, r: AccessRow) => a + r._count, 0)
    const totalAccess = granted + denied
    const open = incidentRows.filter((r: IncidentRow) => ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED'].includes(r.status)).reduce((a: number, r: IncidentRow) => a + r._count, 0)
    const resolved = incidentRows.filter((r: IncidentRow) => r.status === 'RESOLVED').reduce((a: number, r: IncidentRow) => a + r._count, 0)
    const incidentTotal = incidentRows.reduce((a: number, r: IncidentRow) => a + r._count, 0)
    const done = taskRows.filter((r: TaskRow) => r.status === 'DONE').reduce((a: number, r: TaskRow) => a + r._count, 0)
    const taskTotal = taskRows.reduce((a: number, r: TaskRow) => a + r._count, 0)
    const revenue = tickets.reduce((acc: number, t: TicketRow) => acc + (Number(t.price) || 0), 0)
    const byReasonMap = new Map<string, number>()
    for (const r of accessRows) {
      if (r.result !== 'DENIED') continue
      const key = r.reason || 'DENIED'
      byReasonMap.set(key, (byReasonMap.get(key) ?? 0) + r._count)
    }

    type SeverityCount = { severity: string; _count: number }
    type PriorityCount = { priority: string; _count: number }

    return {
      data: {
        attendance: {
          totalAttendees: attendees,
          checkedIn,
          rate: attendees ? Math.round((checkedIn / attendees) * 100) : 0,
          byStatus: attendanceRows.map((r: (typeof attendanceRows)[number]) => ({ status: r.status, _count: r._count })),
        },
        access: {
          total: totalAccess,
          granted,
          denied,
          successRate: totalAccess ? Math.round((granted / totalAccess) * 100) : 100,
          byReason: [...byReasonMap.entries()].map(([reason, count]) => ({ reason, count })),
        },
        incidents: {
          total: incidentTotal,
          open,
          resolved,
          bySeverity: incidentRows
            .filter((r: IncidentRow): r is IncidentRow & { priority: string } => r.priority !== null)
            .reduce((acc: SeverityCount[], r: IncidentRow & { priority: string }) => {
              const existing = acc.find((x) => x.severity === r.priority)
              if (existing) existing._count += r._count
              else acc.push({ severity: r.priority, _count: r._count })
              return acc
            }, [] as SeverityCount[]),
        },
        tasks: {
          total: taskTotal,
          done,
          byPriority: taskRows
            .filter((r: TaskRow): r is TaskRow & { priority: string } => r.priority !== null)
            .reduce((acc: PriorityCount[], r: TaskRow & { priority: string }) => {
              const existing = acc.find((x) => x.priority === r.priority)
              if (existing) existing._count += r._count
              else acc.push({ priority: r.priority, _count: r._count })
              return acc
            }, [] as PriorityCount[]),
        },
        finance: {
          totalRevenue: revenue,
          ticketsSold: tickets.length,
          avgPrice: tickets.length ? Math.round(revenue / tickets.length) : 0,
        },
      },
    }
  })

  // Combined operational summary
  app.get('/summary', async (req) => {
    const { eventId } = req.params as { eventId: string }
    await requirePermission(req, 'report.view', { eventId })

    const [attendees, access, incidents, tasks, tickets] = await Promise.all([
      prisma.attendee.count({ where: { eventId } }),
      prisma.accessLog.count({ where: { eventId } }),
      prisma.incident.count({ where: { eventId } }),
      prisma.task.count({ where: { eventId } }),
      prisma.ticket.count({ where: { eventId } }),
    ])
    return { data: { attendees, accessLogs: access, incidents, tasks, tickets } }
  })
}