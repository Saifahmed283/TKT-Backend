import { prisma } from './db.js'

export type AuditInput = {
  organizationId?: string | null
  eventId?: string | null
  actorUserId?: string | null
  action: string
  resourceType: string
  resourceId?: string | null
  previousValue?: unknown
  newValue?: unknown
  sourceDevice?: string | null
  sourceIp?: string | null
  result?: string
  metadata?: unknown
}

/** Audit records are immutable by design — no update/delete API exists. */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: input.organizationId ?? null,
        eventId: input.eventId ?? null,
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        previousValue: input.previousValue as any ?? undefined,
        newValue: input.newValue as any ?? undefined,
        sourceDevice: input.sourceDevice ?? null,
        sourceIp: input.sourceIp ?? null,
        result: input.result ?? 'SUCCESS',
        metadata: input.metadata as any ?? undefined,
      },
    })
  } catch (err) {
    console.error('[audit] failed to write audit record', err)
  }
}