# Reservation load test

k6 scenario for the public reservation path. It ramps to 500 concurrent VUs
and writes real reservations.

> **Never run against production.** The script refuses to start unless
> `K6_ALLOW_LOAD_TEST=true` **and** `K6_TARGET_URL` resolves to a host containing
> `staging`, `localhost`, or `127.0.0.1`.

## Setup

1. Seed a staging event (status `PUBLISHED`) with at least one public, active,
   non-transport ticket type that has quota.
2. Set the target and event:
   ```bash
   export K6_TARGET_URL=https://tkt-api-staging.example.com
   export K6_EVENT_ID=<staging-event-id>
   export K6_ALLOW_LOAD_TEST=true
   ```
3. Run:
   ```bash
   k6 run tests/load/reservations.js
   ```

The run checks for `201`, `409` (duplicate guard) or `429` (rate limit). Watch
Neon connection usage, SMTP queue depth and Blob write errors while it runs;
those are the first likely launch constraints. A 5% error rate and p95 >3 s on
reservation requests fail the run.

Do not point this at production, even with a small VU count.
