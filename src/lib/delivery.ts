import { sendMail, ticketEmailShell } from './mailer.js'

export type DeliveryChannelName = 'EMAIL' | 'WHATSAPP'

export type DeliveryPayload = {
  to: string
  subject: string
  html: string
  text?: string
}

export type DeliveryResult = {
  ok: boolean
  provider: string
  providerMessageId?: string | null
  error?: string | null
  skipped?: boolean
}

export interface DeliveryAdapter {
  channel: DeliveryChannelName
  send(payload: DeliveryPayload): Promise<DeliveryResult>
}

class EmailDeliveryAdapter implements DeliveryAdapter {
  channel: DeliveryChannelName = 'EMAIL'
  async send(payload: DeliveryPayload): Promise<DeliveryResult> {
    const result = await sendMail(payload)
    return {
      ok: result.ok,
      provider: 'smtp',
      providerMessageId: result.messageId ?? null,
      error: result.error ?? null,
    }
  }
}

class WhatsAppDeliveryAdapter implements DeliveryAdapter {
  channel: DeliveryChannelName = 'WHATSAPP'
  async send(): Promise<DeliveryResult> {
    return {
      ok: false,
      provider: 'whatsapp',
      skipped: true,
      error: 'WhatsApp delivery adapter not configured',
    }
  }
}

const adapters: Record<DeliveryChannelName, DeliveryAdapter> = {
  EMAIL: new EmailDeliveryAdapter(),
  WHATSAPP: new WhatsAppDeliveryAdapter(),
}

export function getDeliveryAdapter(channel: DeliveryChannelName): DeliveryAdapter {
  return adapters[channel]
}

export { ticketEmailShell }
