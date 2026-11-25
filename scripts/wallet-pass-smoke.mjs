import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appleWalletIsConfigured, createAppleWalletPass } from '../dist/features/wallet/appleWallet.js'

const credentialCode = 'TKT1.eyJjcmVkSWQiOiJ3YWxsZXQtc21va2UifQ.test-signature'
assert.equal(appleWalletIsConfigured(), true, 'temporary Apple Wallet signing credentials must be configured for this smoke test')

const outputDirectory = await mkdtemp(join(tmpdir(), 'tkt-wallet-pass-'))
const passPath = join(outputDirectory, 'TKT-smoke.pkpass')
const manifestPath = join(outputDirectory, 'manifest.json')
const signaturePath = join(outputDirectory, 'signature.der')

try {
  const pass = await createAppleWalletPass({
    ticketId: 'wallet-smoke-ticket',
    reservationCode: 'TKT-WALLET-SMOKE',
    credentialCode,
    attendeeName: 'TKT Wallet Smoke Test',
    ticketTypeName: 'Program + Bus Included',
    event: {
      id: 'wallet-smoke-event',
      name: 'TKT Wallet Smoke Event',
      startAt: new Date('2026-11-24T17:30:00.000Z'),
      endAt: new Date('2026-11-24T22:00:00.000Z'),
      venueName: 'Cairo Opera House',
      venueAddress: 'Gezira, Cairo, Egypt',
    },
    seats: [{ label: 'A1', busName: 'TKT Shuttle' }],
    design: {
      templateId: 'signature-split',
      paletteId: 'rose-noir',
      panelColor: '#350D24',
      accentColor: '#F22586',
      backgroundColor: '#FFF2F7',
      textColor: '#2A1020',
    },
  })
  assert.ok(pass.length > 1_000, 'pkpass archive should not be empty')
  await writeFile(passPath, pass)
  execFileSync('unzip', ['-t', passPath], { stdio: 'ignore' })

  const passJson = JSON.parse(execFileSync('unzip', ['-p', passPath, 'pass.json'], { encoding: 'utf8' }))
  assert.equal(passJson.eventTicket.primaryFields[0].value, 'TKT Wallet Smoke Event')
  assert.equal(passJson.eventTicket.auxiliaryFields[0].value, 'TKT Wallet Smoke Test')
  assert.ok(passJson.eventTicket.auxiliaryFields.some((field) => field.key === 'seat' && field.value === 'TKT Shuttle · A1'))
  assert.ok(passJson.eventTicket.backFields.some((field) => field.key === 'booking-reference' && field.value === 'TKT-WALLET-SMOKE'))
  assert.equal(passJson.barcodes[0].message, credentialCode)
  assert.equal(passJson.backgroundColor, 'rgb(255, 242, 247)')

  await writeFile(manifestPath, execFileSync('unzip', ['-p', passPath, 'manifest.json']))
  await writeFile(signaturePath, execFileSync('unzip', ['-p', passPath, 'signature']))
  execFileSync('openssl', [
    'smime', '-verify', '-inform', 'DER',
    '-in', signaturePath,
    '-content', manifestPath,
    '-noverify',
    '-out', join(outputDirectory, 'verified-manifest.json'),
  ], { stdio: 'ignore' })

  console.log(`Apple Wallet smoke passed: ${pass.length} byte pkpass, ticket data, QR payload, artwork bundle and CMS signature verified.`)
} finally {
  await rm(outputDirectory, { recursive: true, force: true })
}
