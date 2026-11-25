import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'
import { PKPass } from 'passkit-generator'
import { config } from '../../config.js'

export type TicketDesignSnapshot = {
  templateId?: string
  paletteId?: string
  panelColor?: string
  accentColor?: string
  backgroundColor?: string
  textColor?: string
}

export type AppleWalletPassInput = {
  ticketId: string
  reservationCode: string
  credentialCode: string
  attendeeName: string
  ticketTypeName: string
  event: {
    id: string
    name: string
    startAt: Date
    endAt: Date | null
    venueName: string | null
    venueAddress: string | null
  }
  seats: Array<{ label: string; busName?: string | null }>
  design?: TicketDesignSnapshot | null
}

const DEFAULT_DESIGN = {
  panelColor: '#0b0b0c',
  accentColor: '#c8a25c',
  backgroundColor: '#f1ede4',
  textColor: '#171717',
}

const GLYPHS: Record<string, string[]> = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
}

function safeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback
}

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function createPng(width: number, height: number, background: string, accent: string, logo = false): Buffer {
  const pixels = Buffer.alloc((width * 4 + 1) * height)
  const bg = rgb(background)
  const fg = rgb(accent)

  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    pixels[row] = 0
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4
      pixels[offset] = bg[0]
      pixels[offset + 1] = bg[1]
      pixels[offset + 2] = bg[2]
      pixels[offset + 3] = 255
    }
  }

  const setPixel = (x: number, y: number, color: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const offset = y * (width * 4 + 1) + 1 + x * 4
    pixels[offset] = color[0]
    pixels[offset + 1] = color[1]
    pixels[offset + 2] = color[2]
    pixels[offset + 3] = 255
  }

  if (!logo) {
    const centerX = Math.floor(width / 2)
    const centerY = Math.floor(height / 2)
    const radius = Math.floor(width * 0.37)
    const thickness = Math.max(1, Math.round(width * 0.035))
    for (let y = centerY - radius; y <= centerY + radius; y += 1) {
      for (let x = centerX - radius; x <= centerX + radius; x += 1) {
        const distance = Math.hypot(x - centerX, y - centerY)
        if (distance <= radius && distance >= radius - thickness) setPixel(x, y, fg)
      }
    }
  }

  const scale = Math.max(1, Math.floor(Math.min(width / (logo ? 28 : 24), height / 10)))
  const word = 'TKT'
  const glyphWidth = 5
  const glyphHeight = 7
  const gap = Math.max(1, Math.floor(scale * 0.55))
  const totalWidth = word.length * glyphWidth * scale + (word.length - 1) * gap
  const startX = Math.floor((width - totalWidth) / 2)
  const startY = Math.floor((height - glyphHeight * scale) / 2)

  for (let index = 0; index < word.length; index += 1) {
    const letter = word.charAt(index)
    const glyph = GLYPHS[letter] ?? ['11111', '00100', '00100', '00100', '00100', '00100', '00100']
    for (let gy = 0; gy < glyphHeight; gy += 1) {
      const row = glyph[gy] ?? ''
      for (let gx = 0; gx < glyphWidth; gx += 1) {
        if (row[gx] !== '1') continue
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            setPixel(startX + index * (glyphWidth * scale + gap) + gx * scale + sx, startY + gy * scale + sy, fg)
          }
        }
      }
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** A deterministic TKT mark and strip graphic; no external image fetches at pass-generation time. */
function walletArtwork(panelColor: string, accentColor: string) {
  return {
    'icon.png': createPng(29, 29, panelColor, accentColor),
    'icon@2x.png': createPng(58, 58, panelColor, accentColor),
    'icon@3x.png': createPng(87, 87, panelColor, accentColor),
    'logo.png': createPng(160, 50, panelColor, accentColor, true),
    'logo@2x.png': createPng(320, 100, panelColor, accentColor, true),
    'strip.png': createPng(375, 123, panelColor, accentColor, true),
    'strip@2x.png': createPng(750, 246, panelColor, accentColor, true),
  }
}

export function appleWalletIsConfigured(): boolean {
  return config.appleWallet.enabled
}

export async function createAppleWalletPass(input: AppleWalletPassInput): Promise<Buffer> {
  if (!appleWalletIsConfigured()) {
    throw new Error('APPLE_WALLET_NOT_CONFIGURED')
  }

  const design = input.design ?? {}
  const panelColor = safeColor(design.panelColor, DEFAULT_DESIGN.panelColor)
  const accentColor = safeColor(design.accentColor, DEFAULT_DESIGN.accentColor)
  const backgroundColor = safeColor(design.backgroundColor, DEFAULT_DESIGN.backgroundColor)
  const textColor = safeColor(design.textColor, DEFAULT_DESIGN.textColor)
  const venue = [input.event.venueName, input.event.venueAddress].filter(Boolean).join(' · ') || 'To be announced'
  const seatLabels = input.seats.map((seat) => `${seat.busName ? seat.busName + ' · ' : ''}${seat.label}`)
  const passProps = {
    formatVersion: 1 as const,
    passTypeIdentifier: config.appleWallet.passTypeIdentifier,
    teamIdentifier: config.appleWallet.teamIdentifier,
    organizationName: config.appleWallet.organizationName,
    description: `${input.ticketTypeName} · ${input.event.name}`.slice(0, 120),
    serialNumber: input.ticketId,
    logoText: 'TKT',
    groupingIdentifier: `tkt-event-${input.event.id}`,
    sharingProhibited: true,
    backgroundColor: `rgb(${rgb(backgroundColor).join(', ')})`,
    foregroundColor: `rgb(${rgb(textColor).join(', ')})`,
    labelColor: `rgb(${rgb(accentColor).join(', ')})`,
    relevantDates: [{ relevantDate: input.event.startAt.toISOString() }],
    ...(input.event.endAt ? { expirationDate: input.event.endAt.toISOString() } : {}),

  }

  const certificates = {
    wwdr: Buffer.from(config.appleWallet.wwdrCertificateB64, 'base64'),
    signerCert: Buffer.from(config.appleWallet.signerCertificateB64, 'base64'),
    signerKey: Buffer.from(config.appleWallet.signerKeyB64, 'base64'),
    ...(config.appleWallet.signerKeyPassphrase ? { signerKeyPassphrase: config.appleWallet.signerKeyPassphrase } : {}),
  }

  const pass = new PKPass(
    walletArtwork(panelColor, accentColor),
    certificates,
    passProps,
  )
  // passkit-generator v3 requires an explicit PassType. Event ticket fields
  // belong to that typed object rather than a free-form pass.json property.
  pass.type = 'eventTicket'
  pass.headerFields.push({
    key: 'pass-kind',
    label: 'TKT EVENT PASS',
    value: input.ticketTypeName,
  })
  pass.primaryFields.push({
    key: 'event-name',
    label: 'EVENT',
    value: input.event.name,
  })
  pass.secondaryFields.push({
    key: 'date-time',
    label: 'DATE & TIME',
    value: input.event.startAt.toISOString(),
    dateStyle: 'PKDateStyleLong',
    timeStyle: 'PKDateStyleShort',
  })
  pass.auxiliaryFields.push(
    { key: 'pass-holder', label: 'PASS HOLDER', value: input.attendeeName },
    ...(seatLabels.length ? [{ key: 'seat', label: 'SEAT', value: seatLabels.join(', ') }] : []),
  )
  pass.backFields.push(
    { key: 'location', label: 'LOCATION', value: venue },
    { key: 'ticket-type', label: 'TICKET TYPE', value: input.ticketTypeName },
    { key: 'booking-reference', label: 'BOOKING REFERENCE', value: input.reservationCode },
    { key: 'event-name-back', label: 'EVENT', value: input.event.name },
  )
  pass.setBarcodes({
    format: 'PKBarcodeFormatQR',
    message: input.credentialCode,
    altText: input.reservationCode,
    messageEncoding: 'iso-8859-1',
  })

  return pass.getAsBuffer()
}
