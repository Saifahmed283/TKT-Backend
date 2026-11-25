// Ticketak Load Test - Reservation Flow
// Run: k6 run --vus 50 --duration 2m reservations.js
// Env: BASE_URL=https://api.ticketak.com EVENT_ID=event-123

import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Rate, Trend, Counter } from 'k6/metrics'

// Custom metrics
const reservationSuccessRate = new Rate('reservation_success_rate')
const reservationDuration = Trend('reservation_duration')
const seatHoldDuration = Trend('seat_hold_duration')
const statusCheckDuration = Trend('status_check_duration')
const errors = Counter('errors')

export const options = {
  scenarios: {
    reservation_flow: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 25 },   // Warm up
        { duration: '1m', target: 50 },    // Sustained load
        { duration: '30s', target: 100 },  // Peak load
        { duration: '1m', target: 50 },    // Cool down
        { duration: '30s', target: 0 },    // Ramp down
      ],
      gracefulRampDown: '30s',
    },
    // Stress test scenario (run separately)
    stress_test: {
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
  },
  thresholds: {
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    http_req_failed: ['rate<0.02'],
    reservation_success_rate: ['rate>0.95'],
    reservation_duration: ['p(95)<1500'],
    seat_hold_duration: ['p(95)<800'],
    status_check_duration: ['p(95)<500'],
  },
  // Export summary to JSON for CI
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
}

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000'
const EVENT_ID = __ENV.EVENT_ID || 'test-event-id'
const TICKET_TYPE_ID = __ENV.TICKET_TYPE_ID || 'standard-ticket'

// Test data pools
const users = Array.from({ length: 1000 }, (_, i) => ({
  name: `LoadTest User ${i}`,
  email: `loadtest${i}@k6.local`,
  phone: `+1555${String(i).padStart(7, '0')}`,
}))

let userIndex = 0

function getNextUser() {
  const user = users[userIndex % users.length]
  userIndex++
  return user
}

// Helper: Create reservation
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

  const params = {
    headers: { 'Content-Type': 'application/json' },
  }

  const start = new Date()
  const res = http.post(
    `${BASE_URL}/public/events/${EVENT_ID}/reservations`,
    payload,
    params
  )
  const duration = new Date() - start

  const success = check(res, {
    'status 201 (created) or 409 (conflict)': (r) => r.status === 201 || r.status === 409,
    'response has data': (r) => r.json('data') !== undefined,
  })

  reservationSuccessRate.add(success)
  reservationDuration.add(duration)

  if (!success) {
    errors.add(1)
    console.error(`Reservation failed: ${res.status} ${res.body}`)
  }

  return res
}

// Helper: Create seat hold
function createSeatHold(user, seatIds = ['seat-1']) {
  const sessionId = `k6-${__VU}-${__ITER}`
  const payload = JSON.stringify({
    seatIds,
    sessionId,
    holdMinutes: 10,
  })

  const params = {
    headers: { 'Content-Type': 'application/json' },
  }

  const start = new Date()
  const res = http.post(
    `${BASE_URL}/public/events/${EVENT_ID}/buses/bus-1/hold`,
    payload,
    params
  )
  const duration = new Date() - start

  const success = check(res, {
    'status 200 or 409': (r) => r.status === 200 || r.status === 409,
  })

  seatHoldDuration.add(duration)
  return res
}

// Helper: Check reservation status
function checkStatus(reservationCode, accessToken) {
  const params = { headers: { Accept: 'application/json' } }
  const start = new Date()
  const query = new URLSearchParams({ code: reservationCode })
  if (accessToken) query.set('token', accessToken)
  const res = http.get(
    `${BASE_URL}/public/events/${EVENT_ID}/reservations/status?${query.toString()}`,
    params
  )
  const duration = new Date() - start

  check(res, {
    'status 200': (r) => r.status === 200,
  })

  statusCheckDuration.add(duration)
  return res
}

// Main VU function - Reservation Flow
export default function () {
  const user = getNextUser()

  group('Reservation Flow', () => {
    // 1. Create reservation
    const res = createReservation(user)

    if (res.status === 201) {
      const data = res.json()
      const reservationCode = data.data?.reservationCode
      const accessToken = data.data?.accessToken

      // 2. Poll status (with token if available)
      let attempts = 0
      const maxAttempts = 12 // 60 seconds max
      let status = 'PENDING'

      while (attempts < maxAttempts && status === 'PENDING') {
        sleep(5)
        const statusRes = checkStatus(reservationCode, accessToken)
        const statusData = statusRes.json()
        status = statusData.data?.approval || 'PENDING'
        attempts++
      }
    }
    // 409 (conflict) is also acceptable - user already has reservation
  })
}

// Stress test executor - higher concurrency
export function stressTest() {
  const user = getNextUser()
  createReservation(user)
  sleep(Math.random() * 2)
}

// Setup: Verify test event exists
export function setup() {
  const res = http.get(`${BASE_URL}/public/events/${EVENT_ID}`)
  if (res.status !== 200) {
    throw new Error(`Test event ${EVENT_ID} not accessible: ${res.status}`)
  }
  console.log('Load test setup complete')
  return { eventId: EVENT_ID }
}

// Teardown
export function teardown(data) {
  console.log('Load test completed')
}