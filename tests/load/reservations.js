// TKT staged reservation load tests
//
// Normal traffic:  k6 run tests/load/reservations.js
// Reservation stress: STRESS_TEST=true k6 run tests/load/reservations.js
// Seat contention: SEAT_HOLD_TEST=true BUS_ID=... SEAT_IDS=seat-1 k6 run tests/load/reservations.js
//
// Required env: BASE_URL, EVENT_ID, TICKET_TYPE_ID
// Never run the stress or seat-contention modes against production.

import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Rate, Trend, Counter } from 'k6/metrics'

const reservationSuccessRate = new Rate('reservation_success_rate')
const apiErrorRate = new Rate('api_error_rate')
const reservationDuration = new Trend('reservation_duration')
const seatHoldDuration = new Trend('seat_hold_duration')
const statusCheckDuration = new Trend('status_check_duration')
const reservationConflicts = new Counter('reservation_conflicts')
const seatHoldConflicts = new Counter('seat_hold_conflicts')

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000'
const EVENT_ID = __ENV.EVENT_ID || 'test-event-id'
const TICKET_TYPE_ID = __ENV.TICKET_TYPE_ID || 'standard-ticket'
const BUS_ID = __ENV.BUS_ID || ''
const SEAT_IDS = (__ENV.SEAT_IDS || 'seat-1').split(',').map((id) => id.trim()).filter(Boolean)
const seatHoldMode = __ENV.SEAT_HOLD_TEST === 'true'
const stressMode = __ENV.STRESS_TEST === 'true'

// A 409 is an expected business conflict (e.g. a competing seat hold), not
// an infrastructure/transport failure. Reservation success is tracked
// separately and only a 201 counts as a created reservation.
http.setResponseCallback(http.expectedStatuses(200, 201, 202, 204, 409))

const scenarios = seatHoldMode
  ? {
      seat_hold_contention: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: '30s', target: 25 },
          { duration: '1m', target: 50 },
          { duration: '1m', target: 100 },
          { duration: '30s', target: 0 },
        ],
        exec: 'seatHoldContention',
        gracefulRampDown: '30s',
      },
    }
  : stressMode
    ? {
        reservation_stress: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '1m', target: 100 },
            { duration: '2m', target: 200 },
            { duration: '1m', target: 300 },
            { duration: '30s', target: 0 },
          ],
          exec: 'stressTest',
          gracefulRampDown: '30s',
        },
      }
    : {
        reservation_flow: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '30s', target: 25 },
            { duration: '1m', target: 50 },
            { duration: '30s', target: 100 },
            { duration: '1m', target: 50 },
            { duration: '30s', target: 0 },
          ],
          gracefulRampDown: '30s',
        },
      }

export const options = {
  scenarios,
  thresholds: {
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    http_req_failed: ['rate<0.02'],
    api_error_rate: ['rate<0.02'],
    ...(seatHoldMode
      ? { seat_hold_duration: ['p(95)<800'] }
      : {
          reservation_success_rate: ['rate>0.95'],
          reservation_duration: ['p(95)<1500'],
          status_check_duration: ['p(95)<500'],
        }),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
}

function nextUser() {
  // k6 gives each VU its own JS runtime. Include both VU and iteration so
  // users are globally unique across concurrent virtual users.
  const suffix = `${__VU}-${__ITER}`
  return {
    name: `LoadTest User ${suffix}`,
    email: `loadtest+${suffix}@k6.local`,
    phone: `+1555${String(__VU).padStart(5, '0')}${String(__ITER).padStart(4, '0')}`,
  }
}

function createReservation(user, ticketTypeId = TICKET_TYPE_ID) {
  const payload = JSON.stringify({
    name: user.name,
    email: user.email,
    phone: user.phone,
    ticketTypeId,
    paymentProviderId: null,
    paymentReference: null,
    paymentProofUrl: null,
    paymentAmount: null,
    busId: null,
    seatIds: [],
    seatPassengers: [],
    holdToken: null,
  })

  const startedAt = Date.now()
  const res = http.post(
    `${BASE_URL}/public/events/${EVENT_ID}/reservations`,
    payload,
    { headers: { 'Content-Type': 'application/json' } },
  )
  reservationDuration.add(Date.now() - startedAt)

  const created = res.status === 201
  const expectedBusinessResponse = created || res.status === 409
  reservationSuccessRate.add(created)
  apiErrorRate.add(res.status === 0 || res.status >= 500)
  if (res.status === 409) reservationConflicts.add(1)

  check(res, {
    'reservation returns created or an expected business conflict': () => expectedBusinessResponse,
    'created reservation contains a data envelope': (response) => !created || response.json('data') !== undefined,
  })

  if (!expectedBusinessResponse) {
    console.error(`Unexpected reservation response: ${res.status} ${res.body}`)
  }

  return res
}

function createSeatHold(seatIds = SEAT_IDS) {
  const sessionId = `k6-${__VU}-${__ITER}-${Date.now()}`
  const payload = JSON.stringify({ seatIds, sessionId, holdMinutes: 10 })
  const startedAt = Date.now()
  const res = http.post(
    `${BASE_URL}/public/events/${EVENT_ID}/buses/${BUS_ID}/hold`,
    payload,
    { headers: { 'Content-Type': 'application/json' } },
  )
  seatHoldDuration.add(Date.now() - startedAt)

  const expectedBusinessResponse = res.status === 200 || res.status === 409
  apiErrorRate.add(res.status === 0 || res.status >= 500)
  if (res.status === 409) seatHoldConflicts.add(1)

  check(res, {
    'seat hold returns success or an expected contention conflict': () => expectedBusinessResponse,
  })

  if (!expectedBusinessResponse) {
    console.error(`Unexpected seat hold response: ${res.status} ${res.body}`)
  }
  return res
}

function checkStatus(reservationCode, accessToken) {
  const params = { headers: { Accept: 'application/json' } }
  const startedAt = Date.now()
  const query = new URLSearchParams({ code: reservationCode })
  if (accessToken) query.set('token', accessToken)
  const res = http.get(
    `${BASE_URL}/public/events/${EVENT_ID}/reservations/status?${query.toString()}`,
    params,
  )
  statusCheckDuration.add(Date.now() - startedAt)
  apiErrorRate.add(res.status === 0 || res.status >= 500)
  check(res, { 'reservation status responds with 200': (response) => response.status === 200 })
  return res
}

export default function () {
  const user = nextUser()

  group('Reservation Flow', () => {
    const res = createReservation(user)
    if (res.status !== 201) return

    const data = res.json()
    const reservationCode = data.data?.reservationCode
    const accessToken = data.data?.accessToken
    if (!reservationCode) {
      apiErrorRate.add(1)
      console.error('Created reservation did not return a reservation code')
      return
    }

    let attempts = 0
    let status = 'PENDING'
    const maxAttempts = 12
    while (attempts < maxAttempts && status === 'PENDING') {
      sleep(5)
      const statusRes = checkStatus(reservationCode, accessToken)
      const statusData = statusRes.json()
      status = statusData.data?.approval || 'PENDING'
      attempts++
    }
  })
}

export function stressTest() {
  createReservation(nextUser())
  sleep(Math.random() * 2)
}

export function seatHoldContention() {
  createSeatHold(SEAT_IDS)
  sleep(Math.random())
}

export function setup() {
  if (seatHoldMode && !BUS_ID) {
    throw new Error('BUS_ID is required when SEAT_HOLD_TEST=true')
  }
  if (seatHoldMode && SEAT_IDS.length === 0) {
    throw new Error('SEAT_IDS must contain at least one seat when SEAT_HOLD_TEST=true')
  }

  const res = http.get(`${BASE_URL}/public/events/${EVENT_ID}`)
  if (res.status !== 200) {
    throw new Error(`Test event ${EVENT_ID} is not accessible: ${res.status}`)
  }

  console.log(`Load test setup complete (mode: ${seatHoldMode ? 'seat-hold' : stressMode ? 'stress' : 'reservation'})`)
  return { eventId: EVENT_ID }
}

export function teardown(data) {
  console.log(`Load test completed for event ${data.eventId}`)
}
