// In-memory activity log + realtime fan-out for the live activity feed.
// Schema-less by design: a bounded ring buffer per event, broadcast over
// the SSE `event:{eventId}:activity` channel.

import { publish, channelFor } from './realtime.js'

export type ActivityItem = {
  id: string
  kind: string
  message: string
  actor: string | null
  at: string
}

const MAX_PER_EVENT = 100
const logs = new Map<string, ActivityItem[]>()

export function logActivity(eventId: string, kind: string, message: string, actor?: string | null) {
  const item: ActivityItem = {
    id: crypto.randomUUID(),
    kind,
    message,
    actor: actor ?? null,
    at: new Date().toISOString(),
  }
  const list = logs.get(eventId) ?? []
  list.unshift(item)
  if (list.length > MAX_PER_EVENT) list.length = MAX_PER_EVENT
  logs.set(eventId, list)
  publish(channelFor.activity(eventId), kind, item)
  return item
}

export function recentActivity(eventId: string, limit = 50): ActivityItem[] {
  return (logs.get(eventId) ?? []).slice(0, Math.max(1, Math.min(limit, MAX_PER_EVENT)))
}