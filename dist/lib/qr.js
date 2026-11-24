import QRCode from 'qrcode';
/** Render a payload as a data-URL PNG for email/QR inlining. */
export function qrDataUrl(payload) {
    return QRCode.toDataURL(payload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 380,
        color: { dark: '#0b0c0d', light: '#ffffff' },
    });
}
//# sourceMappingURL=qr.js.map