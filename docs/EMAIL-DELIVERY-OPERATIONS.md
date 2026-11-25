# TKT Email Delivery Operations

## Delivery architecture

Reservation and credential email work is persisted in the database outbox. Failed jobs are retried with exponential backoff and move to the dead-letter state after the configured attempt limit. The protected `GET /internal/process-outbox` endpoint processes up to 50 due events per call. It accepts the same `Authorization: Bearer <CRON_SECRET>` or `x-cron-secret` guard used by the cleanup endpoint.

## Vercel Hobby scheduling

The existing Vercel Cron job remains a daily maintenance/expiry sweep. A daily schedule is not sufficient for prompt delivery retries. Configure an external scheduler (or upgrade to a Vercel plan that supports the required frequency) to call:

- Method: `GET`
- Path: `/internal/process-outbox`
- Frequency: every 5 minutes
- Header: `Authorization: Bearer <CRON_SECRET>`

Store the secret in the scheduler's encrypted secret store. Never put it in a URL, repository file, or client bundle. Confirm the response reports `data.outbox.processed` and `data.outbox.failed`; inspect the delivery-attempt log and dead-letter records when failures continue.

## SMTP production verification

A Vercel environment variable being present does not establish that the SMTP account can authenticate or deliver to a recipient. After setting `SMTP_ENABLED=true`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and a verified `MAIL_FROM` in the Backend Production environment:

1. Trigger a controlled test reservation to a mailbox you own.
2. Confirm the reservation confirmation arrives.
3. Approve a paid test reservation (or create a free one) and confirm the credential email arrives.
4. Inspect the received message's MIME parts: the QR must be an inline PNG with Content-ID `tkt-ticket-qr@tkt`, referenced by `src="cid:tkt-ticket-qr@tkt"`.
5. Use the reservation resend action and verify a second delivery attempt is recorded.
6. Check the TKT delivery log, provider message ID, outbox completion state, and absence of dead-letter entries.

### Protected live smoke test\n\nAfter deploying the Backend branch, send one controlled message to a mailbox you own:\n\n- Method: `POST`\n- Path: `/internal/smtp-test`\n- Header: `Authorization: Bearer <CRON_SECRET>`\n- JSON body: `{ "to": "your-test-mailbox@example.com" }`\n\nThe endpoint first runs Nodemailer's SMTP `verify()`, then sends a test email with an inline QR PNG. A `200` response with `data.sent=true`, followed by the email actually appearing in the recipient inbox, verifies the SMTP transport and inline QR MIME path. A `503` response identifies a disabled/missing or unreachable SMTP transport; a `502` indicates the connection succeeded but delivery failed. This endpoint does not create a reservation.\n\nThe automated CI suite deliberately runs with SMTP disabled; passing CI validates QR generation and email markup, not access to the real SMTP provider. Do not mark production delivery as verified until the controlled live-message test succeeds.
