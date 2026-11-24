import { sendMail, ticketEmailShell } from './mailer.js';
class EmailDeliveryAdapter {
    channel = 'EMAIL';
    async send(payload) {
        const result = await sendMail(payload);
        return {
            ok: result.ok,
            provider: 'smtp',
            providerMessageId: result.messageId ?? null,
            error: result.error ?? null,
        };
    }
}
class WhatsAppDeliveryAdapter {
    channel = 'WHATSAPP';
    async send() {
        return {
            ok: false,
            provider: 'whatsapp',
            skipped: true,
            error: 'WhatsApp delivery adapter not configured',
        };
    }
}
const adapters = {
    EMAIL: new EmailDeliveryAdapter(),
    WHATSAPP: new WhatsAppDeliveryAdapter(),
};
export function getDeliveryAdapter(channel) {
    return adapters[channel];
}
export { ticketEmailShell };
//# sourceMappingURL=delivery.js.map