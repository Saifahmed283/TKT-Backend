# TKT reservation load test

This k6 scenario exercises the public reservation endpoint and reservation-status polling against an isolated staging environment.

## Safety gates

The script **fails closed** unless all of the following are explicitly provided:
- `K6_ALLOW_LOAD_TEST=true`
- `K6_TARGET_URL` — hostname must contain `staging`, or be `localhost` / `127.0.0.1`
- `K6_EVENT_ID` — a published staging event ID
- `K6_TICKET_TYPE_ID` — an active public ticket type ID

Non-local targets must use HTTPS. Production-like hosts and the public TKT production domain are explicitly rejected. Do not weaken these checks or point the script at production.

## Standard load test (up to 100 virtual users)

Seed a staging event with an active public ticket type and sufficient quota, then set:

```bash
export K6_TARGET_URL=https://tkt-api-staging.example.com
export K6_EVENT_ID=<staging-event-id>
export K6_TICKET_TYPE_ID=<staging-ticket-type-id>
export K6_ALLOW_LOAD_TEST=true
k6 run tests/load/reservations.js
```

The standard profile warms up to 25 VUs, sustains 50 VUs, peaks at 100 VUs, then ramps down. It checks for reservation success/conflict/rate-limit responses and tracks reservation, seat-hold and status-poll latency.

Thresholds: request p95 below 1 second, p99 below 2 seconds, HTTP error rate below 2%, successful/accepted flow rate above 95%, reservation p95 below 1.5 seconds, seat-hold p95 below 800 ms, and status-check p95 below 500 ms.

## Separate stress test (up to 500 virtual users)

Run only after the standard test passes and the owner has approved the staging capacity window:

```bash
export K6_STRESS_TEST=true
k6 run tests/load/reservations.js
```

This profile ramps through 50, 150, 300 and 500 VUs and uses relaxed stress thresholds (request p95 below 3 seconds, p99 below 5 seconds, HTTP error rate below 5%).

Monitor PostgreSQL/Neon connection usage, SMTP queue depth, blob storage errors, CPU, memory, 5xx/429 rates and p95 latency. Do not execute the stress profile against production, even with a small VU count.
