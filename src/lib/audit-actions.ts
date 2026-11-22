export const AuditActions = {
  RESERVATION_APPROVED: 'reservation.approved',
  RESERVATION_REJECTED: 'reservation.rejected',
  CREDENTIAL_ISSUED_RESERVATION: 'credential.issued_via_reservation',
  CREDENTIAL_DELIVERY_SENT: 'credential.delivery.sent',
  CREDENTIAL_DELIVERY_FAILED: 'credential.delivery.failed',
  ACCESS_GRANTED: 'access.granted',
  ACCESS_DENIED: 'access.denied',
} as const

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions]
