import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
// Request-scoped start time for the reservation-only latency log.
export const reservationStartedAt = new WeakMap<object, number>()

// ─────────────────────────────────────────────────────────────
// Prize wheel — segment order must match the frontend wheel
// render order (index is used to land the animation).
// ─────────────────────────────────────────────────────────────
export const WHEEL_SEGMENTS = [
  { reward: 'FIFTEEN_OFF', label: '15% off your ticket', weight: 30 },
  { reward: 'TWENTY_FIVE_OFF', label: '25% off your ticket', weight: 25 },
  { reward: 'GIFT', label: 'Gift from TKT', weight: 15 },
  { reward: 'RETRY', label: 'One more chance', weight: 15 },
  { reward: 'FIFTY_OFF', label: '50% off your ticket', weight: 10 },
  { reward: 'FREE_TICKET', label: 'FREE ticket — jackpot', weight: 5 },
] as const

export const ticketDesignSchema = z.object({
  templateId: z.enum(['signature-split', 'editorial-wide']),
  paletteId: z.enum(['obsidian-gold', 'rose-noir', 'champagne', 'midnight-azure', 'emerald-ink', 'lavender-silk', 'custom']),
  stickerId: z.enum(['none', 'sparkle', 'star', 'flower', 'heart', 'bolt', 'crown']).optional().default('none'),
  panelColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
}).strict()

export type TicketDesignInput = z.infer<typeof ticketDesignSchema>

export const reservationSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(8).max(24),
  gender: z.enum(['male', 'female', 'other', 'prefer_not_to_say']),
  nationality: z.enum(['EG', 'OTHER']),
  identityNumber: z.string().trim().min(5).max(20),
  notes: z.string().max(1000).optional().nullable(),
  ticketTypeId: z.string(),
  ticketDesign: ticketDesignSchema.optional(),
  paymentProviderId: z.string().optional().nullable(),
  paymentReference: z.string().max(200).optional().nullable(),
  paymentProofUrl: z.string().max(2_000_000).optional().nullable(),
  paymentAmount: z.coerce.number().nonnegative().optional().nullable(),
  busId: z.string().optional().nullable(),
  seatIds: z.array(z.string()).max(20).optional(),
  seatPassengers: z.array(z.object({ seatId: z.string(), name: z.string().min(2), email: z.string().email().optional().nullable(), phone: z.string().optional().nullable() })).optional(),
  holdToken: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  const id = value.identityNumber.replace(/\s/g, '')
  const valid = value.nationality === 'EG'
    ? /^\d{14}$/.test(id)
    : /^[A-Za-z0-9][A-Za-z0-9-]{4,19}$/.test(id)
  if (!valid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['identityNumber'],
      message: value.nationality === 'EG'
        ? 'Egyptian National ID must contain exactly 14 digits'
        : 'Passport number must contain 5–20 letters or digits',
    })
  }
})

export const contactSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  orgName: z.string().optional(),
  eventType: z.string().optional(),
  eventDate: z.string().optional(),
  message: z.string().min(10),
})

export function clientIp(req: { ip?: string }): string {
  return req.ip || 'unknown'
}

// Secure access token for reservation lookup (128+ bits of entropy)
export function secureAccessToken(): string {
  return randomBytes(16).toString('hex')
}

// Hash access token for storage (use SHA-256 for token hashing)
export function hashAccessToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Human-readable reservation reference (32 bits, for display only)
export function reservationCode(): string {
  return 'TKT-' + randomBytes(4).toString('hex').toUpperCase()
}
export function paidAmountMismatch(clientAmount: number | null, computedTotal: number): boolean {
  if (clientAmount == null) return false
  if (!Number.isFinite(clientAmount) || !Number.isFinite(computedTotal)) return true
  return Math.abs(clientAmount - computedTotal) > 0.01
}

// ─────────────────────────────────────────────────────────────
// Reservation availability — mirrors SAC's eventAvailability.
// States: upcoming | open | sold_out | locked | closed
// ─────────────────────────────────────────────────────────────
export type RegSettings = { enabled?: boolean; open?: boolean; startAt?: string; endAt?: string }

export function registrationWindow(reg: RegSettings): { start: string | null; end: string | null } {
  return {
    start: typeof reg.startAt === 'string' && reg.startAt ? reg.startAt : null,
    end: typeof reg.endAt === 'string' && reg.endAt ? reg.endAt : null,
  }
}

export function availabilityOf(params: {
  reg: RegSettings
  now: Date
  eventStartAt: Date
  soldOut: boolean
}): 'upcoming' | 'open' | 'sold_out' | 'locked' | 'closed' {
  const { reg, now, eventStartAt, soldOut } = params
  const window = registrationWindow(reg)
  if (reg.enabled === false || reg.open === false) return 'locked'
  if (window.start && new Date(window.start).getTime() > now.getTime()) return 'upcoming'
  if (window.end && new Date(window.end).getTime() <= now.getTime()) return 'closed'
  if (now.getTime() >= eventStartAt.getTime()) return 'closed'
  if (soldOut) return 'sold_out'
  return 'open'
}

