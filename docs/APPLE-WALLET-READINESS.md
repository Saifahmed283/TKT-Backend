# Apple Wallet Readiness

Apple Wallet issuance is not enabled in TKT yet. The current ticket credential and QR remain the source of truth; no `.pkpass` signing or Apple Wallet web-service implementation is present in this repository.

## CSR prepared for the account owner

A fresh RSA-2048 private key and certificate signing request have been generated specifically for the TKT Pass Type ID certificate:

- CSR file: `TKT-Pass-Type-ID.certSigningRequest`
- Common name: `TKT Wallet Pass Signing`
- The matching private key is stored in the Backend Vercel project as the encrypted Production and Preview variable `WALLET_PRIVATE_KEY_B64`.
- Do not upload, commit, email, or share the private key. Upload only the CSR to Apple Developer.

The account owner must sign in to the Apple Developer portal using the Apple Developer account. Register a Pass Type ID (suggested identifier: `pass.com.yourtktinfo.events`, provided it is available), then create a Pass Type ID Certificate and upload the CSR. Download the issued `.cer` file. Obtain the Apple WWDR intermediate certificate from Apple's certificate authority resources.

## Required production material

Before enabling pass issuance, the owner must provide:

- Apple Developer team membership and the Team ID.
- The exact registered Pass Type ID and Apple Team ID shown in the Apple Developer account.
- The Pass Type ID certificate issued from the supplied CSR, plus the matching private key already stored in Vercel.
- The certificate password and the current Apple Worldwide Developer Relations (WWDR) intermediate certificate.
- A public HTTPS web-service base URL and durable records for pass serial numbers, authentication tokens, device registrations, and update timestamps.
- An APNs-capable update service and a rotation/revocation procedure.

## Important ticket-format decision

Apple's new poster event ticket semantic-tag format is not compatible with tickets that require a QR code or barcode for entry. TKT's current check-in process relies on its signed QR credential. The implementation must therefore use the backward-compatible `eventTicket` pass style with a QR barcode, rather than setting `posterEventTicket` as the preferred style. This preserves the existing scanner flow. See Apple's current documentation: https://developer.apple.com/documentation/walletpasses/creating-an-event-pass-using-semantic-tags

## Required implementation flow

1. Generate a unique pass serial per issued reservation credential.
2. Build a bilingual event-ticket pass containing the reservation/ticket identifiers and a QR barcode whose payload is the same signed TKT credential used at check-in.
3. Sign the pass package with the matching Pass Type ID certificate; never put the private key in the frontend or commit it to source control.
4. Expose authenticated Wallet web-service endpoints for device registration, pass retrieval, and unregister operations.
5. Notify registered devices through APNs when event/ticket data changes.
6. Revoke or invalidate the pass when the underlying credential is cancelled, refunded, consumed, or otherwise no longer valid.
7. Test add-to-Wallet on physical iOS devices and verify update and revocation propagation.

## Current status

A matching private key and CSR are prepared, and the private key is saved as a Vercel secret. Issuance is still blocked until the account owner registers the Pass Type ID and supplies the issued certificate, Team ID, and WWDR certificate. The Apple Wallet routes, signing and device-update lifecycle are not active yet; do not present an Add to Apple Wallet button until the signed pass and update/revocation integration are implemented and tested.
