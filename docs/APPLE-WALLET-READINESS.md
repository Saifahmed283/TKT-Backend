# Apple Wallet Readiness

Apple Wallet issuance is not enabled in TKT yet. The current ticket credential and QR remain the source of truth; no `.pkpass` signing or Apple Wallet web-service implementation is present in this repository.

## Required production material

Before enabling pass issuance, the owner must provide:

- Apple Developer team membership and the Team ID.
- A registered Pass Type ID (for example, `pass.com.example.tkt`).
- The matching Pass Type ID certificate and its private key, exported as protected signing material.
- The certificate password and the current Apple Worldwide Developer Relations (WWDR) intermediate certificate.
- A public HTTPS web-service base URL and durable records for pass serial numbers, authentication tokens, device registrations, and update timestamps.
- An APNs-capable update service and a rotation/revocation procedure.

## Required implementation flow

1. Generate a unique pass serial per issued reservation credential.
2. Build a bilingual event-ticket pass containing the reservation/ticket identifiers and a QR barcode whose payload is the same signed TKT credential used at check-in.
3. Sign the pass package with the matching Pass Type ID certificate; never put the private key in the frontend or commit it to source control.
4. Expose authenticated Wallet web-service endpoints for device registration, pass retrieval, and unregister operations.
5. Notify registered devices through APNs when event/ticket data changes.
6. Revoke or invalidate the pass when the underlying credential is cancelled, refunded, consumed, or otherwise no longer valid.
7. Test add-to-Wallet on physical iOS devices and verify update and revocation propagation.

## Current status

This file is an integration gate, not a claim that Wallet passes can already be issued. Implementation must not be shipped as active until signing material, APNs delivery, storage, and lifecycle tests are supplied and validated.
