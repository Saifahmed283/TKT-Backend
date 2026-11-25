import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../config.js'

let transporter: Transporter | null = null

function getTransporter(): Transporter | null {
  if (config.mailer.enabled && transporter === null) {
    transporter = nodemailer.createTransport({
      host: config.mailer.host,
      port: config.mailer.port,
      secure: config.mailer.secure,
      auth:
        config.mailer.user && config.mailer.pass
          ? { user: config.mailer.user, pass: config.mailer.pass }
          : undefined,
    })
  }
  return config.mailer.enabled ? transporter : null
}

export type MailAttachment = {
  filename: string
  content: Buffer
  contentType: string
  cid: string
  contentDisposition?: 'inline' | 'attachment'
}

export type MailPayload = {
  to: string
  subject: string
  html: string
  text?: string
  attachments?: MailAttachment[]
}

export type MailSendResult = {
  ok: boolean
  messageId?: string | null
  error?: string | null
}

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function safeHttpUrl(value?: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

/** Send an email with optional inline MIME attachments, including the ticket QR. */
export async function sendMail(payload: MailPayload): Promise<MailSendResult> {
  const t = getTransporter()
  if (!t) {
    console.log(`[mailer:noop] → ${payload.to} :: ${payload.subject}`)
    return { ok: false, error: 'SMTP not configured. Set SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM in backend .env.' }
  }
  try {
    const info = await t.sendMail({
      from: config.mailer.from,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      attachments: payload.attachments,
    })
    return { ok: true, messageId: typeof info?.messageId === 'string' ? info.messageId : null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to send email'
    console.error('[mailer:error]', msg)
    return { ok: false, error: msg }
  }
}

/**
 * Figma-aligned, responsive bilingual ticket email.
 * Uses presentation tables and inline styles for Gmail, Outlook and mobile clients.
 */
export function ticketEmailShell(opts: {
  preheader: string
  title: string
  titleAr?: string
  body: string
  bodyAr?: string
  rows: { label: string; value: string; labelAr?: string }[]
  qrCid?: string | null
  ticketUrl?: string | null
  footer?: string
  design?: {
    primaryColor?: string
    accentColor?: string
    backgroundColor?: string
    headerColor?: string
    panelColor?: string
    logoUrl?: string
    fontFamily?: string
    layoutOrder?: string[]
  }
}): string {
  const arabicLabels: Record<string, string> = {
    Event: 'الفعالية',
    Ticket: 'نوع التذكرة',
    Date: 'التاريخ والوقت',
    Venue: 'المكان',
    Reservation: 'الرقم المرجعي',
    'Ticket code': 'رقم التذكرة',
    Seats: 'المقاعد',
    Status: 'الحالة',
    'Payment method': 'طريقة الدفع',
    'Payment reference': 'مرجع الدفع',
  }

  const rows = opts.rows.map((row, index) => {
    const ar = escapeHtml(row.labelAr ?? arabicLabels[row.label] ?? row.label)
    const en = escapeHtml(row.label.toUpperCase())
    const value = escapeHtml(row.value)
    const border = index === opts.rows.length - 1 ? '' : 'border-bottom:1px solid #e3ddd2;'
    return `
      <tr>
        <td class="detail-cell detail-ar" width="30%" dir="rtl" style="padding:12px 10px;color:#6d6a64;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:13px;line-height:1.6;text-align:right;vertical-align:top;${border}">${ar}</td>
        <td class="detail-cell detail-en" width="25%" style="padding:12px 10px;color:#172033;font-family:Poppins,Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:.04em;line-height:1.6;text-align:left;vertical-align:top;${border}">${en}</td>
        <td class="detail-cell detail-value" width="45%" style="padding:12px 10px;color:#172033;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:13px;font-weight:600;line-height:1.6;text-align:right;vertical-align:top;overflow-wrap:anywhere;word-break:break-word;${border}">${value}</td>
      </tr>`
  }).join('')

  const qrBlock = opts.qrCid
    ? `
      <tr>
        <td class="qr-pad" style="padding:18px;background:#faf8f4;border-radius:16px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#faf8f4">
            <tr>
              <td class="qr-image-cell" width="148" align="center" valign="middle" style="width:148px;padding:4px 14px 4px 4px">
                <img src="cid:${escapeHtml(opts.qrCid)}" alt="Ticket QR code — scan to verify your ticket" width="120" height="120" style="display:block;width:120px;height:120px;max-width:100%;border:0;outline:none;text-decoration:none;background:#ffffff" />
              </td>
              <td class="qr-copy-cell" valign="middle" style="padding:8px 12px;text-align:right">
                <p dir="rtl" style="margin:0;color:#0b1f44;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:16px;font-weight:700;line-height:1.7">امسح الرمز للتحقق من صلاحية التذكرة</p>
                <p style="margin:6px 0 0;color:#565e6b;font-family:Poppins,Arial,sans-serif;font-size:12px;line-height:1.6">Scan this code to verify your ticket</p>
                <p dir="rtl" style="margin:8px 0 0;color:#8a6a35;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:11px;line-height:1.6">يرجى إظهار الرمز عند بوابة الدخول</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    : `
      <tr><td style="padding:18px;background:#faf8f4;border-radius:16px">
        <p dir="rtl" style="margin:0;color:#0b1f44;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:14px;line-height:1.8">سيكون رمز التذكرة متاحاً بعد إتمام إصدارها.</p>
        <p style="margin:4px 0 0;color:#565e6b;font-family:Poppins,Arial,sans-serif;font-size:12px;line-height:1.6">Your QR ticket will appear here once it has been issued.</p>
      </td></tr>`

  const ticketUrl = safeHttpUrl(opts.ticketUrl)
  const action = ticketUrl
    ? `<a href="${escapeHtml(ticketUrl)}" target="_blank" style="display:block;padding:15px 24px;background:#c8a25c;color:#ffffff;text-decoration:none;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:16px;font-weight:700;line-height:1.5;text-align:center;border-radius:28px">عرض التذكرة&nbsp; / &nbsp;VIEW TICKET</a>`
    : `<div style="padding:14px 20px;background:#f1ede4;color:#0b1f44;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:13px;font-weight:700;line-height:1.6;text-align:center;border-radius:28px">احتفظ بهذا البريد لإبرازه عند الدخول&nbsp; / &nbsp;KEEP THIS EMAIL FOR ENTRY</div>`

  const titleAr = escapeHtml(opts.titleAr ?? 'تأكيد الحجز وإصدار التذكرة')
  const title = escapeHtml(opts.title)
  const bodyAr = escapeHtml(opts.bodyAr ?? 'مرحباً، شكراً لحجزك معنا. يسعدنا تأكيد مشاركتك في الحدث التالي.')
  const body = escapeHtml(opts.body)
  const preheader = escapeHtml(opts.preheader)
  const footer = escapeHtml(opts.footer ?? 'Your Partner in Travel, Events & Special Occasions')
  const design = opts.design ?? {}
  const safeColor = (value: string | undefined, fallback: string) =>
    typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
  const palette = {
    primary: safeColor(design.primaryColor, '#0b1f44'),
    accent: safeColor(design.accentColor, '#c8a25c'),
    background: safeColor(design.backgroundColor, '#fdfbf7'),
    header: safeColor(design.headerColor, '#0b0b0c'),
    panel: safeColor(design.panelColor, '#f1ede4'),
  }
  const allowedFonts = ['Cairo', 'Tahoma', 'Arial', 'Poppins']
  const fontFamily = allowedFonts.includes(design.fontFamily ?? '') ? design.fontFamily! : 'Cairo'
  const logoUrl = safeHttpUrl(design.logoUrl)
  const logoMarkup = logoUrl
    ? '<img src="' + escapeHtml(logoUrl) + '" alt="TKT" width="112" style="display:block;max-width:112px;max-height:44px;width:auto;height:auto;border:0" />'
    : '${logoMarkup}'
  const defaultOrder = ['intro', 'details', 'qr', 'action', 'footer', 'legal']
  const requestedOrder = Array.isArray(design.layoutOrder) ? design.layoutOrder : defaultOrder
  const sectionOrder = [...new Set(requestedOrder.filter((name) => defaultOrder.includes(name)))]
  for (const section of defaultOrder) if (!sectionOrder.includes(section)) sectionOrder.push(section)

  let html = `
<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light" />
  <title>${title}</title>
  <style>
    body{margin:0!important;padding:0!important;background:#fdfbf7;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt}
    img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
    @media only screen and (max-width:620px){
      .outer-pad{padding:12px 8px!important}
      .email-shell{width:100%!important;max-width:100%!important;border-radius:14px!important}
      .email-pad{padding-left:18px!important;padding-right:18px!important}
      .header-pad{padding:24px 20px!important}
      .detail-cell{padding:10px 5px!important;font-size:11px!important}
      .detail-en{font-size:8px!important;letter-spacing:0!important}
      .detail-value{font-size:12px!important}
      .qr-pad{padding:12px!important}
      .qr-image-cell{width:112px!important;padding-right:4px!important}
      .qr-image-cell img{width:96px!important;height:96px!important}
      .qr-copy-cell{padding:4px!important}
      .footer-pad{padding-left:18px!important;padding-right:18px!important}
    }
    @media only screen and (max-width:380px){
      .detail-cell{padding:8px 3px!important}
      .detail-ar{font-size:10px!important}
      .detail-en{font-size:7px!important}
      .detail-value{font-size:11px!important}
      .qr-image-cell{width:96px!important}
      .qr-image-cell img{width:82px!important;height:82px!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#fdfbf7">
  <div style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fdfbf7" style="width:100%;background:#fdfbf7">
    <tr><td class="outer-pad" align="center" style="padding:30px 14px">
      <table class="email-shell" role="presentation" width="720" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:720px;background:#fdfbf7;border:1px solid #e8e3d9;border-radius:16px;overflow:hidden">
        <tr>
          <td class="header-pad" bgcolor="#0b0b0c" style="padding:28px 36px;background:#0b0b0c;border-radius:16px 16px 0 0">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="112" valign="middle" align="left" style="width:112px;text-align:left">
                  <div dir="ltr" style="color:#c8a25c;font-family:Italiana,Georgia,serif;font-size:36px;font-weight:400;letter-spacing:.04em;line-height:1">TKT</div>
                </td>
                <td valign="middle" align="right">
                  <p dir="rtl" style="margin:0;color:#ffffff;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:12px;line-height:1.7">رحلتك تبدأ معنا</p>
                  <p dir="ltr" style="margin:2px 0 0;color:#ffffff;font-family:Poppins,Arial,sans-serif;font-size:10px;letter-spacing:.08em;line-height:1.5">YOUR EXPERIENCE STARTS HERE</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!--TKT_SECTION_PLACEHOLDER-->
        <!--TKT_SECTION:intro-->
        <tr><td class="email-pad" style="padding:30px 36px 22px;background:#fdfbf7">
          <h1 dir="rtl" style="margin:0;color:#0b1f44;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:27px;font-weight:700;line-height:1.5">${titleAr}</h1>
          <p dir="ltr" style="margin:2px 0 0;color:#c8a25c;font-family:Poppins,Arial,sans-serif;font-size:17px;font-weight:700;line-height:1.5">${title}</p>
          <p dir="rtl" style="margin:22px 0 0;color:#172033;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:16px;line-height:1.9">${bodyAr}</p>
          <p dir="ltr" style="margin:8px 0 0;color:#172033;font-family:Poppins,Arial,sans-serif;font-size:13px;line-height:1.8">${body}</p>
        </td></tr>

        <!--TKT_SECTION:details-->
        <tr><td class="email-pad" style="padding:8px 36px 20px;background:#fdfbf7">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1ede4" style="width:100%;background:#f1ede4;border-radius:16px">
            <tr><td style="padding:20px 20px 8px">
              <h2 dir="rtl" style="margin:0;color:#0b1f44;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:17px;font-weight:700;line-height:1.6">تفاصيل الحجز</h2>
              <p dir="ltr" style="margin:0;color:#0b1f44;font-family:Poppins,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:.06em;line-height:1.6">BOOKING DETAILS</p>
            </td></tr>
            <tr><td style="padding:4px 14px 14px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%">${rows}</table>
            </td></tr>
          </table>
        </td></tr>

        <!--TKT_SECTION:qr-->
        <tr><td class="email-pad" style="padding:0 36px 18px;background:#fdfbf7">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%">${qrBlock}</table>
        </td></tr>

        <!--TKT_SECTION:action-->
        <tr><td class="email-pad" style="padding:0 36px 26px;background:#fdfbf7">
          ${action}
        </td></tr>

        <!--TKT_SECTION:footer-->
        <tr><td class="email-pad" style="padding:0 36px 18px;background:#fdfbf7">
          <p dir="rtl" style="margin:0;color:#0b1f44;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:14px;font-weight:700;line-height:1.8">TKT لتنظيم الرحلات والفعاليات والمناسبات</p>
          <p dir="ltr" style="margin:3px 0 0;color:#687080;font-family:Poppins,Arial,sans-serif;font-size:12px;line-height:1.7">${footer}</p>
        </td></tr>

        <!--TKT_SECTION:legal-->
        <tr><td class="footer-pad" style="padding:0 36px 26px;background:#fdfbf7">
          <div style="height:1px;background:#e8e3d9;line-height:1px;font-size:1px">&nbsp;</div>
          <p dir="rtl" style="margin:14px 0 0;color:#8b8e96;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:10px;line-height:1.6">تم إرسال هذا البريد لتأكيد تفاصيل حجزك مع TKT.</p>
        </td></tr>
        <!--TKT_SECTION_END-->
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const sectionNames = ['intro', 'details', 'qr', 'action', 'footer', 'legal']
  const ranges: Array<{ start: number; end: number; content: string }> = []
  const sectionStarts = sectionNames.map((name) => html.indexOf('<!--TKT_SECTION:' + name + '-->'))
  const endSentinel = html.indexOf('<!--TKT_SECTION_END-->')
  for (let i = 0; i < sectionNames.length; i += 1) {
    const start = sectionStarts[i]!
    const markerLength = ('<!--TKT_SECTION:' + sectionNames[i] + '-->').length
    const end = i + 1 < sectionNames.length ? sectionStarts[i + 1]! : endSentinel
    if (start < 0 || end < 0 || end < start) throw new Error('Invalid ticket email section markers')
    ranges.push({ start, end, content: html.slice(start + markerLength, end) })
  }
  for (const range of [...ranges].reverse()) html = html.slice(0, range.start) + html.slice(range.end)
  html = html.replace(/<!--TKT_SECTION:(intro|details|qr|action|footer|legal)-->/g, '')
  html = html.replace('<!--TKT_SECTION_END-->', '')
  const contentByName = Object.fromEntries(sectionNames.map((name, index) => [name, ranges[index]!.content])) as Record<string, string>
  html = html.replace('<!--TKT_SECTION_PLACEHOLDER-->', sectionOrder.map((name) => contentByName[name] ?? '').join('\n'))
  html = html.replaceAll('#fdfbf7', palette.background)
  html = html.replaceAll('#0b0b0c', palette.header)
  html = html.replaceAll('#0b1f44', palette.primary)
  html = html.replaceAll('#c8a25c', palette.accent)
  html = html.replaceAll('#f1ede4', palette.panel)
  html = html.replaceAll('Cairo,Tahoma,Arial,sans-serif', fontFamily + ',Tahoma,Arial,sans-serif')
  html = html.replaceAll('Poppins,Arial,sans-serif', fontFamily + ',Arial,sans-serif')
  return html
}
