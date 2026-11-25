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
 * Responsive bilingual confirmation email based on the TKT Figma design.
 * A table-based layout is used for compatibility with Gmail, Outlook and mobile clients.
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
}): string {
  const arabicLabels: Record<string, string> = {
    Event: 'الفعالية',
    Ticket: 'نوع التذكرة',
    Date: 'التاريخ والوقت',
    Venue: 'المكان',
    Reservation: 'رقم الحجز',
    'Ticket code': 'رمز التذكرة',
    Seats: 'المقاعد',
    Status: 'الحالة',
  }

  const rows = opts.rows.map((row) => {
    const ar = escapeHtml(row.labelAr ?? arabicLabels[row.label] ?? row.label)
    const en = escapeHtml(row.label.toUpperCase())
    const value = escapeHtml(row.value)
    return `
      <tr>
        <td class="detail-cell detail-ar" width="27%" style="padding:14px 10px;color:#77736c;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;text-align:left;vertical-align:middle"><span dir="rtl">${ar}</span></td>
        <td class="detail-cell detail-en" width="28%" style="padding:14px 10px;color:#171615;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:.04em;line-height:1.5;text-align:left;vertical-align:middle">${en}</td>
        <td class="detail-cell detail-value" width="45%" style="padding:14px 10px;color:#24221f;font-family:Arial,sans-serif;font-size:13px;font-weight:600;line-height:1.5;text-align:right;vertical-align:middle;overflow-wrap:anywhere">${value}</td>
      </tr>`
  }).join('')

  const qrBlock = opts.qrCid
    ? `
      <tr><td align="center" style="padding:26px 20px 8px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:340px;background:#ffffff;border:1px solid #e8e2d7;border-radius:14px">
          <tr><td align="center" style="padding:20px 18px 8px">
            <img src="cid:${escapeHtml(opts.qrCid)}" alt="Ticket QR code — scan at the entrance" width="190" height="190" style="display:block;width:190px;max-width:100%;height:auto;border:0;background:#ffffff" />
          </td></tr>
          <tr><td align="center" style="padding:8px 18px 18px;color:#8e6d36;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:.1em;line-height:1.5">
            <span dir="rtl" style="display:block;font-size:14px;letter-spacing:0">امسح الرمز عند الدخول</span>
            <span style="display:block;margin-top:4px">SCAN THIS CODE AT THE ENTRANCE</span>
          </td></tr>
        </table>
      </td></tr>`
    : ''

  const ticketUrl = safeHttpUrl(opts.ticketUrl)
  const action = ticketUrl
    ? `<a href="${escapeHtml(ticketUrl)}" target="_blank" style="display:inline-block;padding:13px 25px;background:#c8a25c;color:#171615;text-decoration:none;font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.04em;border-radius:10px">VIEW TICKET</a>`
    : `<span style="display:inline-block;padding:13px 18px;color:#e8d08b;font-family:Arial,sans-serif;font-size:11px;letter-spacing:.08em">KEEP THIS EMAIL FOR ENTRY</span>`

  return `
<!doctype html>
<html lang="ar">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light" />
  <title>${escapeHtml(opts.title)}</title>
  <style>
    body{margin:0!important;padding:0!important;background:#f1eee7;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt}
    img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
    @media only screen and (max-width:620px){
      .outer-pad{padding:12px 8px!important}
      .email-shell{width:100%!important;max-width:100%!important;border-radius:16px!important}
      .email-pad{padding-left:20px!important;padding-right:20px!important}
      .detail-cell{padding:11px 5px!important;font-size:11px!important}
      .detail-en{font-size:9px!important;letter-spacing:0!important}
      .detail-value{font-size:12px!important}
      .qr-pad{padding-left:14px!important;padding-right:14px!important}
      .footer-pad{padding-left:20px!important;padding-right:20px!important}
    }
    @media only screen and (max-width:380px){
      .detail-cell{padding:9px 3px!important}
      .detail-ar{font-size:10px!important}
      .detail-en{font-size:8px!important}
      .detail-value{font-size:11px!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f1eee7">
  <div style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all">${escapeHtml(opts.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1eee7" style="width:100%;background:#f1eee7">
    <tr><td class="outer-pad" align="center" style="padding:28px 14px">
      <table class="email-shell" role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#faf8f4;border:1px solid #e7e0d5;border-radius:20px;overflow:hidden">
        <tr><td bgcolor="#1b1917" style="padding:30px 34px 27px;background:#1b1917">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td valign="middle" style="text-align:left">
              <div style="color:#faf8f4;font-family:Arial,sans-serif;font-size:34px;font-weight:800;letter-spacing:.08em;line-height:1">TKT</div>
              <div dir="rtl" style="margin-top:12px;color:#e8d08b;font-family:Arial,sans-serif;font-size:15px;line-height:1.4">تجربة تستحق التذكر</div>
              <div style="margin-top:4px;color:#e7e1d7;font-family:Arial,sans-serif;font-size:10px;letter-spacing:.08em;line-height:1.4">AN EXPERIENCE WORTH REMEMBERING</div>
            </td>
            <td width="100" align="right" valign="middle"><div style="display:inline-block;width:66px;height:66px;border:1px solid #c8a25c;border-radius:50%;box-sizing:border-box;text-align:center;line-height:64px;color:#c8a25c;font-family:Arial,sans-serif;font-size:25px">✦</div></td>
          </tr></table>
        </td></tr>
        <tr><td class="email-pad" style="padding:34px 36px 8px;background:#faf8f4">
          <h1 dir="rtl" style="margin:0;color:#171615;font-family:Arial,sans-serif;font-size:26px;font-weight:800;line-height:1.35">${escapeHtml(opts.titleAr ?? 'تم تأكيد حجزك بنجاح!')}</h1>
          <p style="margin:2px 0 0;color:#a27b3f;font-family:Arial,sans-serif;font-size:18px;font-weight:700;line-height:1.45">${escapeHtml(opts.title)}</p>
          <p dir="rtl" style="margin:28px 0 0;color:#5f5a53;font-family:Arial,sans-serif;font-size:14px;line-height:1.9">${escapeHtml(opts.bodyAr ?? 'يسعدنا تأكيد حجزك. تذكرتك جاهزة الآن.')}</p>
          <p style="margin:2px 0 0;color:#777169;font-family:Arial,sans-serif;font-size:13px;line-height:1.7">${escapeHtml(opts.body)}</p>
        </td></tr>
        <tr><td class="email-pad" style="padding:28px 36px 0;background:#faf8f4">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f0ece3" style="width:100%;background:#f0ece3;border-radius:16px">
            <tr><td style="padding:22px 20px 4px">
              <div dir="rtl" style="color:#171615;font-family:Arial,sans-serif;font-size:18px;font-weight:800;line-height:1.4">تفاصيل الحجز</div>
              <div style="margin-top:3px;color:#a27b3f;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:.1em">BOOKING DETAILS</div>
            </td></tr>
            <tr><td style="padding:8px 14px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>
          </table>
        </td></tr>
        <tr><td class="qr-pad" style="padding:0 36px;background:#faf8f4">${qrBlock}</td></tr>
        <tr><td class="email-pad" style="padding:24px 36px 0;background:#faf8f4">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#11100f" style="width:100%;background:#11100f;border-radius:15px"><tr>
            <td style="padding:20px 18px" valign="middle">
              <div dir="rtl" style="color:#e8d08b;font-family:Arial,sans-serif;font-size:15px;font-weight:700;line-height:1.5">تذكرتك جاهزة — احتفظ بهذا البريد</div>
              <div style="margin-top:5px;color:#f1eee7;font-family:Arial,sans-serif;font-size:12px;line-height:1.5">Your ticket is ready. Keep this email for entry.</div>
            </td>
            <td width="145" align="center" valign="middle" style="padding:10px 12px">${action}</td>
          </tr></table>
        </td></tr>
        <tr><td class="email-pad" style="padding:30px 36px 24px;background:#faf8f4">
          <p dir="rtl" style="margin:0;color:#777169;font-family:Arial,sans-serif;font-size:13px;line-height:1.8">شكرًا لاختيارك TKT. نتمنى لك تجربة رائعة.</p>
          <p style="margin:3px 0 0;color:#777169;font-family:Arial,sans-serif;font-size:12px;line-height:1.7">Thank you for choosing TKT. Enjoy your experience.</p>
        </td></tr>
        <tr><td class="footer-pad" style="padding:0 36px 27px;background:#faf8f4">
          <div style="height:1px;background:#e7e0d5;line-height:1px;font-size:1px">&nbsp;</div>
          <p style="margin:18px 0 0;color:#a27b3f;font-family:Arial,sans-serif;font-size:10px;letter-spacing:.08em;line-height:1.5">${escapeHtml(opts.footer ?? 'TKT · YOUR EXPERIENCE STARTS HERE')}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}
