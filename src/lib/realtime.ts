// In-memory realtime hub. Backed by SSE streams; publish() fans out
// to all subscribed clients for a channel.
// Channels: `event:{eventId}:access`, `event:{eventId}:incident`,
// `event:{eventId}:task`, `event:{eventId}:announcement`, `event:{eventId}:activity`

import type { FastifyReply } from 'fastify'

type Listener = (msg: { event: string; data: string }) => void

const channels = new Map<string, Set<Listener>>()

export function subscribe(channel: string, listener: Listener): () => void {
  let set = channels.get(channel)
  if (!set) {
    set = new Set()
    channels.set(channel, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) channels.delete(channel)
  }
}

export function publish(channel: string, event: string, payload: unknown) {
  const set = channels.get(channel)
  if (!set || set.size === 0) return
  const data = JSON.stringify(payload)
  for (const listener of set) {
    try {
      listener({ event, data })
    } catch (err) {
      console.error('[hub] listener error', err)
    }
  }
}

export function attachSse(reply: FastifyReply, channel: string) {
  const res = reply.raw
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(`retry: 3000\n\n`)
  res.write(`event: connected\ndata: {"channel":"${channel}"}\n\n`)

  const unsubscribe = subscribe(channel, (msg: { event: string; data: string }) => {
    res.write(`event: ${msg.event}\ndata: ${msg.data}\n\n`)
  })

  const heartbeat = setInterval(() => {
    res.write(`: hb\n\n`)
  }, 15000)

  res.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })

  return () => {
    clearInterval(heartbeat)
    unsubscribe()
  }
}

export const channelFor = {
  access: (eventId: string) => `event:${eventId}:access`,
  incident: (eventId: string) => `event:${eventId}:incident`,
  task: (eventId: string) => `event:${eventId}:task`,
  announcement: (eventId: string) => `event:${eventId}:announcement`,
  activity: (eventId: string) => `event:${eventId}:activity`,
  reservation: (eventId: string) => `event:${eventId}:reservation`,
}