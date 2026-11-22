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

export type MailPayload = {
  to: string
  subject: string
  html: string
  text?: string
}

export type MailSendResult = {
  ok: boolean
  messageId?: string | null
  error?: string | null
}

/**
 * Send an email. When SMTP is not configured the message is logged instead
 * (dev-friendly fail-open).
 */
export async function sendMail(payload: MailPayload): Promise<MailSendResult> {
  const t = getTransporter()
  if (!t) {
    console.log(`[mailer:noop] → ${payload.to} :: ${payload.subject}`)
    return { ok: false, error: 'SMTP not configured' }
  }
  try {
    const info = await t.sendMail({
      from: config.mailer.from,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    })
    return { ok: true, messageId: typeof info?.messageId === 'string' ? info.messageId : null }
  } catch (err) {
    console.error('[mailer:error]', err)
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to send email' }
  }
}

/** Shared email shell — dark ticket-style layout used for reservation emails. */
export function ticketEmailShell(opts: {
  preheader: string
  title: string
  body: string
  rows: { label: string; value: string }[]
  qrDataUrl?: string | null
  footer?: string
}): string {
  const rows = opts.rows
    .map(
      (r) => `
      <tr>
        <td style="padding:7px 16px;color:#8a8f98;font-size:11px;text-transform:uppercase;letter-spacing:0.12em;border-bottom:1px solid #1f2227;white-space:nowrap">${r.label}</td>
        <td style="padding:7px 16px;color:#e8e9ec;font-size:13px;font-weight:600;border-bottom:1px solid #1f2227">${r.value}</td>
      </tr>`,
    )
    .join('')
  return `
    <!doctype html>
    <html>
      <head><meta charset="utf-8" /></head>
      <body style="margin:0;background:#0b0c0d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
        <div style="display:none;max-height:0;overflow:hidden">${opts.preheader}</div>
        <div style="max-width:560px;margin:24px auto;background:#121316;border:1px solid #23252b;border-radius:12px;overflow:hidden">
          <div style="padding:18px 24px;background:#16181c;border-bottom:1px solid #23252b;display:flex;align-items:center;justify-content:space-between">
            <span style="color:#ffb020;font-size:18px;font-weight:800;letter-spacing:0.2em">TKT</span>
            <span style="color:#5c616a;font-size:10px;letter-spacing:0.18em;text-transform:uppercase">Control center for live events</span>
          </div>
          <div style="padding:28px 24px 8px">
            <h1 style="margin:0 0 10px;color:#f2f3f5;font-size:22px;font-weight:700;letter-spacing:0.02em">${opts.title}</h1>
            <p style="margin:0 0 20px;color:#a7abb3;font-size:14px;line-height:1.6">${opts.body}</p>
            <table style="width:100%;border-collapse:collapse;border:1px solid #23252b">${rows}</table>
            ${
              opts.qrDataUrl
                ? `<div style="text-align:center;margin:24px 0 8px">
                     <img src="${opts.qrDataUrl}" alt="Ticket QR" width="190" height="190" style="border-radius:8px;background:#fff;padding:8px" />
                     <p style="color:#5c616a;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;margin:10px 0 0">Present this code at check-in</p>
                   </div>`
                : ''
            }
          </div>
          <div style="padding:16px 24px;border-top:1px solid #23252b;color:#5c616a;font-size:11px;text-align:center">
            ${opts.footer ?? 'TKT Ops · Automated system message'}
          </div>
        </div>
      </body>
    </html>`
}