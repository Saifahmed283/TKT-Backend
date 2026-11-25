import { afterEach, describe, expect, it, vi } from 'vitest'

const walletMock = vi.hoisted(() => ({
  artwork: null as Record<string, Buffer> | null,
  certificates: null as Record<string, unknown> | null,
  props: null as Record<string, any> | null,
  type: null as string | null,
  headerFields: [] as Array<Record<string, unknown>>,
  primaryFields: [] as Array<Record<string, unknown>>,
  secondaryFields: [] as Array<Record<string, unknown>>,
  auxiliaryFields: [] as Array<Record<string, unknown>>,
  backFields: [] as Array<Record<string, unknown>>,
  barcodes: null as Array<Record<string, unknown>> | null,
}))

vi.mock('passkit-generator', () => ({
  PKPass: class {
    constructor(artwork: Record<string, Buffer>, certificates: Record<string, unknown>, props: Record<string, any>) {
      walletMock.artwork = artwork
      walletMock.certificates = certificates
      walletMock.props = props
    }
    headerFields: Array<Record<string, unknown>> = (walletMock.headerFields = [])
    primaryFields: Array<Record<string, unknown>> = (walletMock.primaryFields = [])
    secondaryFields: Array<Record<string, unknown>> = (walletMock.secondaryFields = [])
    auxiliaryFields: Array<Record<string, unknown>> = (walletMock.auxiliaryFields = [])
    backFields: Array<Record<string, unknown>> = (walletMock.backFields = [])
    set type(value: string) {
      walletMock.type = value
    }
    setBarcodes(...barcodes: Array<Record<string, unknown>>) {
      walletMock.barcodes = barcodes
    }
    getAsBuffer() {
      return Buffer.from('test-pkpass-buffer')
    }
  },
}))

import { config } from '../src/config.js'
import { appleWalletIsConfigured, createAppleWalletPass } from '../src/features/wallet/appleWallet.js'

const original = {
  passTypeIdentifier: config.appleWallet.passTypeIdentifier,
  teamIdentifier: config.appleWallet.teamIdentifier,
  organizationName: config.appleWallet.organizationName,
  signerCertificateB64: config.appleWallet.signerCertificateB64,
  signerKeyB64: config.appleWallet.signerKeyB64,
  signerKeyPassphrase: config.appleWallet.signerKeyPassphrase,
  wwdrCertificateB64: config.appleWallet.wwdrCertificateB64,
}

afterEach(() => {
  Object.assign(config.appleWallet, original)
  walletMock.artwork = null
  walletMock.certificates = null
  walletMock.props = null
  walletMock.type = null
  walletMock.headerFields = []
  walletMock.primaryFields = []
  walletMock.secondaryFields = []
  walletMock.auxiliaryFields = []
  walletMock.backFields = []
  walletMock.barcodes = null
})

function configureWallet() {
  Object.assign(config.appleWallet, {
    passTypeIdentifier: 'pass.com.example.tkt',
    teamIdentifier: 'TEAM123456',
    organizationName: 'TKT Events',
    signerCertificateB64: Buffer.from('signer-cert').toString('base64'),
    signerKeyB64: Buffer.from('private-key').toString('base64'),
    signerKeyPassphrase: 'test-passphrase',
    wwdrCertificateB64: Buffer.from('wwdr-cert').toString('base64'),
  })
}

describe('Apple Wallet pass generation', () => {
  it('fails closed until signing certificates and pass identifiers are configured', async () => {
    Object.assign(config.appleWallet, {
      passTypeIdentifier: '',
      teamIdentifier: '',
      signerCertificateB64: '',
      signerKeyB64: '',
      wwdrCertificateB64: '',
    })

    expect(appleWalletIsConfigured()).toBe(false)
    await expect(createAppleWalletPass({
      ticketId: 'ticket-1',
      reservationCode: 'TKT-26001',
      credentialCode: 'TKT1.signed.credential',
      attendeeName: 'Abdullah Mohammed',
      ticketTypeName: 'Program + Bus Included',
      event: {
        id: 'event-1',
        name: 'TKT Signature Night',
        startAt: new Date('2026-11-24T17:30:00.000Z'),
        endAt: new Date('2026-11-24T22:00:00.000Z'),
        timezone: 'Africa/Cairo',
        venueName: 'Cairo Opera House',
        venueAddress: 'Gezira, Cairo',
      },
      seats: [{ label: 'A1', busName: 'Shuttle One' }],
    })).rejects.toThrow('APPLE_WALLET_NOT_CONFIGURED')
  })

  it('maps the official ticket record, saved visual theme and signed credential QR to the pass', async () => {
    configureWallet()
    expect(appleWalletIsConfigured()).toBe(true)

    const result = await createAppleWalletPass({
      ticketId: 'ticket-1',
      reservationCode: 'TKT-26001',
      credentialCode: 'TKT1.eyJjcmVkSWQiOiJ0aWNrZXQtMSJ9.signature',
      attendeeName: 'Abdullah Mohammed',
      ticketTypeName: 'Program + Bus Included',
      event: {
        id: 'event-1',
        name: 'TKT Signature Night',
        startAt: new Date('2026-11-24T17:30:00.000Z'),
        endAt: new Date('2026-11-24T22:00:00.000Z'),
        timezone: 'Africa/Cairo',
        venueName: 'Cairo Opera House',
        venueAddress: 'Gezira, Cairo',
      },
      seats: [{ label: 'A1', busName: 'Shuttle One' }],
      design: {
        templateId: 'signature-split',
        paletteId: 'rose-noir',
        panelColor: '#350D24',
        accentColor: '#F22586',
        backgroundColor: '#FFF2F7',
        textColor: '#2A1020',
      },
    })

    expect(result).toEqual(Buffer.from('test-pkpass-buffer'))
    expect(walletMock.certificates?.wwdr).toEqual(Buffer.from('wwdr-cert'))
    expect(walletMock.certificates?.signerCert).toEqual(Buffer.from('signer-cert'))
    expect(walletMock.certificates?.signerKey).toEqual(Buffer.from('private-key'))
    expect(walletMock.certificates?.signerKeyPassphrase).toBe('test-passphrase')
    expect(walletMock.props).toMatchObject({
      serialNumber: 'ticket-1',
      passTypeIdentifier: 'pass.com.example.tkt',
      teamIdentifier: 'TEAM123456',
      organizationName: 'TKT Events',
    })
    expect(walletMock.type).toBe('eventTicket')
    expect(walletMock.headerFields).toContainEqual({ key: 'pass-kind', label: 'TKT EVENT PASS', value: 'Program + Bus Included' })
    expect(walletMock.primaryFields).toContainEqual({ key: 'event-name', label: 'EVENT', value: 'TKT Signature Night' })
    expect(walletMock.secondaryFields[0]).toMatchObject({
      key: 'date-time',
      label: 'DATE & TIME',
    })
    expect(String(walletMock.secondaryFields[0]?.value)).toContain('24 Nov 2026')
    expect(String(walletMock.secondaryFields[0]?.value)).toContain('19:30')
    expect(walletMock.auxiliaryFields).toEqual(expect.arrayContaining([
      { key: 'pass-holder', label: 'PASS HOLDER', value: 'Abdullah Mohammed' },
      { key: 'seat', label: 'SEAT', value: 'Shuttle One · A1' },
    ]))
    expect(walletMock.backFields).toEqual(expect.arrayContaining([
      { key: 'location', label: 'LOCATION', value: 'Cairo Opera House · Gezira, Cairo' },
      { key: 'ticket-type', label: 'TICKET TYPE', value: 'Program + Bus Included' },
      { key: 'booking-reference', label: 'BOOKING REFERENCE', value: 'TKT-26001' },
      { key: 'event-name-back', label: 'EVENT', value: 'TKT Signature Night' },
    ]))
    expect(walletMock.props?.backgroundColor).toBe('rgb(255, 242, 247)')
    expect(walletMock.props?.foregroundColor).toBe('rgb(42, 16, 32)')
    expect(walletMock.props?.labelColor).toBe('rgb(242, 37, 134)')
    expect(walletMock.artwork?.['icon.png'].subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(walletMock.barcodes).toEqual([{
      format: 'PKBarcodeFormatQR',
      message: 'TKT1.eyJjcmVkSWQiOiJ0aWNrZXQtMSJ9.signature',
      altText: 'TKT-26001',
      messageEncoding: 'iso-8859-1',
    }])
  })

  it('falls back from invalid saved color values instead of writing unsafe CSS colors to pass.json', async () => {
    configureWallet()
    await createAppleWalletPass({
      ticketId: 'ticket-2',
      reservationCode: 'TKT-26002',
      credentialCode: 'TKT1.credential.signature',
      attendeeName: 'Guest',
      ticketTypeName: 'Program Only',
      event: {
        id: 'event-2',
        name: 'TKT Night',
        startAt: new Date('2026-11-24T17:30:00.000Z'),
        endAt: null,
        venueName: null,
        venueAddress: null,
      },
      seats: [],
      design: { panelColor: 'red; background:url(javascript:alert(1))' } as any,
    })

    expect(walletMock.props?.backgroundColor).toBe('rgb(241, 237, 228)')
    expect(walletMock.props?.foregroundColor).toBe('rgb(23, 23, 23)')
    expect(walletMock.props?.labelColor).toBe('rgb(200, 162, 92)')
  })
})
