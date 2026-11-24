import { prisma } from '../../lib/db.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/authorize.js';
export async function reportRoutes(app) {
    app.addHook('preHandler', authenticate);
    // Attendance report
    app.get('/attendance', async (req) => {
        const { eventId } = req.params;
        await requirePermission(req, 'report.view', { eventId });
        const [byStatus, byCategory, byDay, total] = await Promise.all([
            prisma.attendee.groupBy({ by: ['status'], where: { eventId }, _count: true }),
            prisma.attendee.groupBy({ by: ['category'], where: { eventId }, _count: true, orderBy: { _count: { category: 'desc' } } }),
            prisma.accessLog.groupBy({
                by: ['timestamp'],
                where: { eventId, result: 'GRANTED' },
                _count: true,
            }),
            prisma.attendee.count({ where: { eventId } }),
        ]);
        const dayMap = new Map();
        for (const row of byDay) {
            const day = row.timestamp.toISOString().slice(0, 10);
            dayMap.set(day, (dayMap.get(day) ?? 0) + row._count);
        }
        return {
            data: {
                total,
                byStatus: byStatus.map((r) => ({ status: r.status, count: r._count })),
                byCategory: byCategory.map((r) => ({ category: r.category ?? 'unspecified', count: r._count })),
                dailyCheckIns: [...dayMap.entries()].map(([date, count]) => ({ date, count })),
            },
        };
    });
    // Access report
    app.get('/access', async (req) => {
        const { eventId } = req.params;
        await requirePermission(req, 'report.view', { eventId });
        const [byResult, byReason, byArea, byHour] = await Promise.all([
            prisma.accessLog.groupBy({ by: ['result'], where: { eventId }, _count: true }),
            prisma.accessLog.groupBy({ by: ['reason'], where: { eventId }, _count: true, orderBy: { _count: { reason: 'desc' } } }),
            prisma.accessLog.groupBy({ by: ['areaId'], where: { eventId }, _count: true, orderBy: { _count: { areaId: 'desc' } } }),
            prisma.accessLog.findMany({ where: { eventId }, select: { timestamp: true } }),
        ]);
        const hourMap = new Map();
        for (const row of byHour) {
            const h = row.timestamp.getHours();
            hourMap.set(h, (hourMap.get(h) ?? 0) + 1);
        }
        const areaIds = byArea.map((r) => r.areaId).filter((id) => Boolean(id));
        const areas = areaIds.length
            ? await prisma.area.findMany({ where: { id: { in: areaIds } }, select: { id: true, name: true } })
            : [];
        return {
            data: {
                byResult: byResult.map((r) => ({ result: r.result, count: r._count })),
                byReason: byReason.map((r) => ({ reason: r.reason, count: r._count })),
                byArea: byArea.map((r) => ({ areaId: r.areaId, areaName: areas.find((a) => a.id === r.areaId)?.name ?? 'unknown', count: r._count })),
                byHour: [...hourMap.entries()].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count })),
            },
        };
    });
    // Incidents report
    app.get('/incidents', async (req) => {
        const { eventId } = req.params;
        await requirePermission(req, 'report.view', { eventId });
        const [byType, byPriority, byStatus, open, avgResolutionHours] = await Promise.all([
            prisma.incident.groupBy({ by: ['type'], where: { eventId }, _count: true }),
            prisma.incident.groupBy({ by: ['priority'], where: { eventId }, _count: true }),
            prisma.incident.groupBy({ by: ['status'], where: { eventId }, _count: true }),
            prisma.incident.count({ where: { eventId, status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED'] } } }),
            prisma.incident.findMany({ where: { eventId, resolvedAt: { not: null } }, select: { createdAt: true, resolvedAt: true } }),
        ]);
        const avgMs = avgResolutionHours.length
            ? avgResolutionHours.reduce((acc, i) => acc + ((i.resolvedAt?.getTime() ?? i.createdAt.getTime()) - i.createdAt.getTime()), 0) / avgResolutionHours.length
            : 0;
        return {
            data: {
                byType: byType.map((r) => ({ type: r.type, count: r._count })),
                byPriority: byPriority.map((r) => ({ priority: r.priority, count: r._count })),
                byStatus: byStatus.map((r) => ({ status: r.status, count: r._count })),
                open,
                avgResolutionMinutes: Math.round(avgMs / 60000),
            },
        };
    });
    // Tasks report
    app.get('/tasks', async (req) => {
        const { eventId } = req.params;
        await requirePermission(req, 'report.view', { eventId });
        const [byStatus, byPriority, byTeam, total, done] = await Promise.all([
            prisma.task.groupBy({ by: ['status'], where: { eventId }, _count: true }),
            prisma.task.groupBy({ by: ['priority'], where: { eventId }, _count: true }),
            prisma.task.groupBy({ by: ['teamId'], where: { eventId }, _count: true }),
            prisma.task.count({ where: { eventId } }),
            prisma.task.count({ where: { eventId, status: 'DONE' } }),
        ]);
        const teamIds = byTeam.map((r) => r.teamId).filter((id) => Boolean(id));
        const teams = teamIds.length
            ? await prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } })
            : [];
        return {
            data: {
                total,
                done,
                completionRate: total ? Math.round((done / total) * 100) : 0,
                byStatus: byStatus.map((r) => ({ status: r.status, count: r._count })),
                byPriority: byPriority.map((r) => ({ priority: r.priority, count: r._count })),
                byTeam: byTeam.map((r) => ({ teamId: r.teamId, teamName: teams.find((t) => t.id === r.teamId)?.name ?? 'unassigned', count: r._count })),
            },
        };
    });
    // Finance report
    app.get('/finance', async (req) => {
        const { eventId } = req.params;
        await requirePermission(req, 'report.view', { eventId });
        const [tickets, byType] = await Promise.all([
            prisma.ticket.findMany({
                where: { eventId, status: { in: ['ACTIVE', 'CONSUMED', 'ISSUED'] } },
                select: { price: true },
            }),
            prisma.ticket.groupBy({ by: ['ticketTypeId'], where: { eventId, status: { in: ['ACTIVE', 'CONSUMED', 'ISSUED'] } }, _count: true }),
        ]);
        const revenue = tickets.reduce((acc, t) => acc + (Number(t.price) || 0), 0);
        const typeIds = byType.map((r) => r.ticketTypeId);
        const types = typeIds.length
            ? await prisma.ticketType.findMany({ where: { id: { in: typeIds } }, select: { id: true, name: true, price: true } })
            : [];
        return {
            data: {
                revenue,
                ticketsSold: tickets.length,
                byType: byType.map((r) => ({
                    ticketTypeId: r.ticketTypeId,
                    name: types.find((t) => t.id === r.ticketTypeId)?.name ?? 'unknown',
                    price: Number(types.find((t) => t.id === r.ticketTypeId)?.price ?? 0),
                    sold: r._count,
                    subtotal: r._count * Number(types.find((t) => t.id === r.ticketTypeId)?.price ?? 0),
                })),
            },
        };
    });
    // Combined operations report (dashboard-grade overview for the UI)
    app.get('/', async (req) => {
        const { eventId } = req.params;
        await requirePermission(req, 'report.view', { eventId });
        const [attendanceRows, accessRows, incidentRows, taskRows, tickets,] = await Promise.all([
            prisma.attendee.groupBy({ by: ['status'], where: { eventId }, _count: true }),
            prisma.accessLog.groupBy({ by: ['result', 'reason'], where: { eventId }, _count: true }),
            prisma.incident.groupBy({ by: ['status', 'priority'], where: { eventId }, _count: true }),
            prisma.task.groupBy({ by: ['status', 'priority'], where: { eventId }, _count: true }),
            prisma.ticket.findMany({ where: { eventId, status: { in: ['ACTIVE', 'CONSUMED', 'ISSUED'] } }, select: { price: true } }),
        ]);
        const attendees = await prisma.attendee.count({ where: { eventId } });
        const checkedIn = await prisma.attendee.count({ where: { eventId, status: 'CHECKED_IN' } });
        const granted = accessRows.filter((r) => r.result === 'GRANTED').reduce((a, r) => a + r._count, 0);
        const denied = accessRows.filter((r) => r.result === 'DENIED').reduce((a, r) => a + r._count, 0);
        const totalAccess = granted + denied;
        const open = incidentRows.filter((r) => ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED'].includes(r.status)).reduce((a, r) => a + r._count, 0);
        const resolved = incidentRows.filter((r) => r.status === 'RESOLVED').reduce((a, r) => a + r._count, 0);
        const incidentTotal = incidentRows.reduce((a, r) => a + r._count, 0);
        const done = taskRows.filter((r) => r.status === 'DONE').reduce((a, r) => a + r._count, 0);
        const taskTotal = taskRows.reduce((a, r) => a + r._count, 0);
        const revenue = tickets.reduce((acc, t) => acc + (Number(t.price) || 0), 0);
        const byReasonMap = new Map();
        for (const r of accessRows) {
            if (r.result !== 'DENIED')
                continue;
            const key = r.reason || 'DENIED';
            byReasonMap.set(key, (byReasonMap.get(key) ?? 0) + r._count);
        }
        return {
            data: {
                attendance: {
                    totalAttendees: attendees,
                    checkedIn,
                    rate: attendees ? Math.round((checkedIn / attendees) * 100) : 0,
                    byStatus: attendanceRows.map((r) => ({ status: r.status, _count: r._count })),
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
                        .filter((r) => r.priority !== null)
                        .reduce((acc, r) => {
                        const existing = acc.find((x) => x.severity === r.priority);
                        if (existing)
                            existing._count += r._count;
                        else
                            acc.push({ severity: r.priority, _count: r._count });
                        return acc;
                    }, []),
                },
                tasks: {
                    total: taskTotal,
                    done,
                    byPriority: taskRows
                        .filter((r) => r.priority !== null)
                        .reduce((acc, r) => {
                        const existing = acc.find((x) => x.priority === r.priority);
                        if (existing)
                            existing._count += r._count;
                        else
                            acc.push({ priority: r.priority, _count: r._count });
                        return acc;
                    }, []),
                },
                finance: {
                    totalRevenue: revenue,
                    ticketsSold: tickets.length,
                    avgPrice: tickets.length ? Math.round(revenue / tickets.length) : 0,
                },
            },
        };
    });
    // Combined operational summary
    app.get('/summary', async (req) => {
        const { eventId } = req.params;
        await requirePermission(req, 'report.view', { eventId });
        const [attendees, access, incidents, tasks, tickets] = await Promise.all([
            prisma.attendee.count({ where: { eventId } }),
            prisma.accessLog.count({ where: { eventId } }),
            prisma.incident.count({ where: { eventId } }),
            prisma.task.count({ where: { eventId } }),
            prisma.ticket.count({ where: { eventId } }),
        ]);
        return { data: { attendees, accessLogs: access, incidents, tasks, tickets } };
    });
}
//# sourceMappingURL=routes.js.map