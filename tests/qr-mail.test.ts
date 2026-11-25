import { describe, expect, it } from 'vitest'
import { createTicketQrAttachment, TICKET_QR_CID } from '../src/lib/qr.js'
import { ticketEmailShell } from '../src/lib/mailer.js'

describe('ticket email QR and responsive template', () => {
  it('generates a real inline PNG attachment for the signed credential payload', async () => {
    const attachment = await createTicketQrAttachment('TKT1.eyJ2IjoxLCJjcmVkSWQiOiJ0ZXN0In0.signature')
    expect(attachment.filename).toBe('tkt-ticket-qr.png')
    expect(attachment.contentType).toBe('image/png')
    expect(attachment.cid).toBe(TICKET_QR_CID)
    expect(attachment.contentDisposition).toBe('inline')
    expect(attachment.content.subarray(0, 8)).toEqual(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))
    expect(attachment.content.length).toBeGreaterThan(100)
  })

  it('references the QR through CID and keeps the Figma visual direction', () => {
    const html = ticketEmailShell({
      preheader: 'Booking confirmed',
      title: 'Your booking is confirmed!',
      titleAr: 'تم تأكيد حجزك بنجاح!',
      body: 'Your ticket is ready.',
      bodyAr: 'تذكرتك جاهزة الآن.',
      rows: [{label:'Event',value:'TKT Signature Night'},{label:'Ticket code',value:'TKT-ABC23'}],
      qrCid: TICKET_QR_CID,
      ticketUrl: 'https://ticketak.vercel.app/reservation/TKT-ABC23',
    })
    expect(html).toContain('src="cid:tkt-ticket-qr@tkt"')
    expect(html).not.toContain('data:image/png;base64')
    expect(html).toContain('TKT Signature Night')
    expect(html).toContain('تم تأكيد حجزك بنجاح!')
    expect(html).toContain('#f1ede4')
    expect(html).toContain('#0b0b0c')
    expect(html).toContain('#c8a25c')
    expect(html).toContain('@media only screen and (max-width:620px)')
    expect(html).toContain('VIEW TICKET')
    expect(html).toContain('#faf8f4')
    expect(html).toContain('Booking Confirmation')
    expect(html).toContain('BOOKING DETAILS')
    expect(html).toContain('720')
    expect(html).toContain('font-family:Italiana,Georgia,serif')
    expect(html).toContain('alt="Ticket QR code — scan to verify your ticket"')
  })

  it('escapes attendee-controlled content before embedding it in HTML', () => {
    const html = ticketEmailShell({
      preheader: 'Safe preview',
      title: '<script>alert(1)</script>',
      body: 'Safe body',
      rows: [{label:'Event',value:'<img src=x onerror=alert(1)>'}],
      qrCid: TICKET_QR_CID,
    })
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
  })

  it('does not render a broken ticket link when the URL is unavailable', () => {
    const html = ticketEmailShell({preheader:'Booking confirmed',title:'Your ticket',body:'Keep this email.',rows:[],qrCid:TICKET_QR_CID})
    expect(html).toContain('KEEP THIS EMAIL FOR ENTRY')
    expect(html).not.toContain('href="undefined"')
  })
})
