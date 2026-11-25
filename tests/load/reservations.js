import http from 'k6/http'
import { check, sleep } from 'k6'

// 409/429 are expected under contention; don't count them as HTTP failures.
http.setResponseCallback(http.expectedStatuses(200, 201, 409, 429))

const TARGET = __ENV.K6_TARGET_URL || ''
const host = TARGET.match(/^https?:\/\/([^/:]+)(?::\d+)?/i)?.[1]?.toLowerCase() ?? ''
const safeHost = host === 'localhost' || host === '127.0.0.1' || host === 'staging' || host.startsWith('staging.') || host.includes('.staging.')

// Hard guard: this scenario writes reservations and must never run against prod.
if (__ENV.K6_ALLOW_LOAD_TEST !== 'true' || !safeHost) {
  throw new Error('Set K6_ALLOW_LOAD_TEST=true and a staging/local K6_TARGET_URL before running')
}

const EVENT_ID = __ENV.K6_EVENT_ID
if (!EVENT_ID) throw new Error('K6_EVENT_ID is required (use a seeded staging event)')

export const options = {
  stages: [
    { duration: '1m', target: 100 },
    { duration: '3m', target: 500 },
    { duration: '5m', target: 500 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    'http_req_duration{endpoint:reserve}': ['p(95)<3000'],
    checks: ['rate>0.95'],
  },
}

export function setup() {
  const res = http.get(`${TARGET}/public/events/${EVENT_ID}`, {
    tags: { name: 'public-event' },
  })
  if (res.status !== 200) throw new Error(`Cannot load staging event: ${res.status}`)
  const body = JSON.parse(res.body)
  const ticketType = (body.data?.ticketTypes ?? body.ticketTypes ?? []).find(
    (t) => t.isPublic !== false && !t.soldOut && !t.transportIncluded,
  )
  if (!ticketType) throw new Error('Staging event needs an open, public, non-transport ticket type')
  return { ticketTypeId: ticketType.id }
}

export default function ({ ticketTypeId }) {
  const stamp = `${__VU}-${__ITER}-${Date.now()}`
  const payload = JSON.stringify({
    name: `Load Test ${__VU}`,
    email: `load-${stamp}@example.test`,
    phone: `1${stamp.replace(/\D/g, '').slice(-9)}`,
    ticketTypeId,
  })

  const res = http.post(`${TARGET}/public/events/${EVENT_ID}/reservations`, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: 'reserve' },
  })
  check(res, {
    'reservation accepted or duplicate-guarded': (r) => r.status === 201 || r.status === 409 || r.status === 429,
  })
  sleep(1)
}
