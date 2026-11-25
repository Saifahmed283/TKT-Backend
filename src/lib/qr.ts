import QRCode from 'qrcode'
import type { MailAttachment } from './mailer.js'

export const TICKET_QR_CID = 'tkt-ticket-qr@tkt'

/** Generate a validated PNG used as an inline MIME image in ticket emails. */
export async function createTicketQrAttachment(payload: string): Promise<MailAttachment> {
  if (!payload.trim()) throw new Error('Ticket QR payload is empty')

  const content = await QRCode.toBuffer(payload, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 440,
    color: { dark: '#0b0b0c', light: '#ffffff' },
  })

  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!content.subarray(0, 8).equals(pngSignature)) {
    throw new Error('Ticket QR generator did not return a valid PNG image')
  }

  return {
    filename: 'tkt-ticket-qr.png',
    content,
    contentType: 'image/png',
    cid: TICKET_QR_CID,
    contentDisposition: 'inline',
  }
}
