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
      title: 'Booking Confirmation & Ticket Issuance',
      titleAr: 'تأكيد الحجز وإصدار التذكرة',
      body: 'Your ticket is ready.',
      bodyAr: 'تذكرتك جاهزة الآن.',
      rows: [{label:'Event',value:'TKT Signature Night'},{label:'Ticket code',value:'TKT-ABC23'}],
      qrCid: TICKET_QR_CID,
      ticketUrl: 'https://ticketak.vercel.app/reservation/TKT-ABC23',
    })
    expect(html).toContain('src="cid:tkt-ticket-qr@tkt"')
    expect(html).not.toContain('data:image/png;base64')
    expect(html).toContain('TKT Signature Night')
    expect(html).toContain('تأكيد الحجز وإصدار التذكرة')
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

  it('applies safe visual theme, logo, font, and drag-and-drop section order', () => {
    const html = ticketEmailShell({
      preheader: 'Designer preview',
      title: 'Designer heading',
      body: 'Intro section marker',
      rows: [{ label: 'Event', value: 'Design Test Event' }],
      qrCid: TICKET_QR_CID,
      ticketUrl: 'https://ticketak.vercel.app/reservation/DESIGN-1',
      footer: 'Footer section marker',
      design: {
        primaryColor: '#112233',
        accentColor: '#445566',
        backgroundColor: '#fafafa',
        headerColor: '#101010',
        panelColor: '#eeeeee',
        logoUrl: 'https://assets.example.com/tkt-logo.png',
        fontFamily: 'Tahoma',
        layoutOrder: ['footer', 'qr', 'details', 'intro', 'action', 'legal'],
      },
    })
    expect(html).toContain('src="https://assets.example.com/tkt-logo.png"')
    expect(html).toContain('background:#fafafa')
    expect(html).toContain('color:#112233')
    expect(html).toContain('background:#101010')
    expect(html).toContain('font-family:Tahoma,Tahoma,Arial,sans-serif')
    expect(html.indexOf('Footer section marker')).toBeLessThan(html.indexOf('src="cid:tkt-ticket-qr@tkt"'))
    expect(html.indexOf('src="cid:tkt-ticket-qr@tkt"')).toBeLessThan(html.indexOf('BOOKING DETAILS'))
    expect(html.indexOf('BOOKING DETAILS')).toBeLessThan(html.indexOf('Intro section marker'))
    expect(html.indexOf('Intro section marker')).toBeLessThan(html.indexOf('VIEW TICKET'))
  })

  it('renders the selected ticket sticker in the issued ticket email', () => {
    const html = ticketEmailShell({
      preheader: 'Ticket ready',
      title: 'Ticket ready',
      body: 'Your ticket is ready.',
      rows: [{ label: 'Event', value: 'Design Test' }],
      ticketDesign: {
        templateId: 'signature-split',
        paletteId: 'emerald-ink',
        stickerId: 'flower',
        panelColor: '#0C3028',
        accentColor: '#72C6A2',
        backgroundColor: '#EFF8F2',
        textColor: '#16392F',
      },
      ticketPreview: {
        attendeeName: 'Test Guest',
        eventName: 'Design Test',
        ticketTypeName: 'VIP',
        dateTime: 'Tomorrow',
      },
    })
    expect(html).toContain('❀')
    expect(html).toContain('#72C6A2')
  })

  it('renders the selected ticket design in the credential email safely', () => {
    const html = ticketEmailShell({
      preheader: 'Your custom ticket',
      title: 'Ticket ready',
      body: 'Your ticket is confirmed.',
      rows: [{ label: 'Event', value: 'Design review event' }],
      qrCid: TICKET_QR_CID,
      ticketDesign: {
        templateId: 'editorial-wide',
        paletteId: 'rose-noir',
        panelColor: '#350D24',
        accentColor: '#F22586',
        backgroundColor: '#FFF2F7',
        textColor: '#2A1020',
      },
      ticketPreview: {
        attendeeName: '<Attendee>',
        eventName: '<Design Event>',
        ticketTypeName: 'Program + Bus',
        dateTime: 'Fri, 27 Nov 2026',
        venue: 'Cairo',
        seat: 'A4',
        reference: 'TKT-TEST',
      },
    })

    expect(html).toContain('background:#FFF2F7')
    expect(html).toContain('background:#350D24')
    expect(html).toContain('color:#F22586')
    expect(html).toContain('&lt;Design Event&gt;')
    expect(html).toContain('&lt;Attendee&gt;')
    expect(html).toContain('A4')
    expect(html).toContain('src="cid:tkt-ticket-qr@tkt"')
    expect(html).not.toContain('<Design Event>')
  })

  it('does not render a broken ticket link when the URL is unavailable', () => {
    const html = ticketEmailShell({preheader:'Booking confirmed',title:'Your ticket',body:'Keep this email.',rows:[],qrCid:TICKET_QR_CID})
    expect(html).toContain('KEEP THIS EMAIL FOR ENTRY')
    expect(html).not.toContain('href="undefined"')
  })
})
