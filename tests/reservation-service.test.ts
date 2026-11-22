import { describe, it, expect } from 'vitest'
import {
  reservationApprovalOf,
  reservationPaymentOf,
  reservationCodeOf,
  normalizeReservationEmail,
  normalizeReservationPhone,
  canIssueReservationCredential,
  reservationStatePatch,
  isPaidTicket,
} from '../src/features/reservations/service.js'

describe('reservation service helpers', () => {
  it('normalizes reservation identity fields', () => {
    expect(normalizeReservationEmail('  USER@Example.COM ')).toBe('user@example.com')
    expect(normalizeReservationEmail('')).toBeNull()
    expect(normalizeReservationPhone('+1 (555) 123-4567')).toBe('15551234567')
    expect(normalizeReservationPhone('  ')).toBeNull()
  })

  it('prefers explicit reservation fields over legacy metadata', () => {
    const ticket = {
      reservationCode: 'TKT-EXPLICIT',
      approvalStatus: 'APPROVED',
      paymentStatus: 'CONFIRMED',
      metadata: { channel: 'public', approval: 'PENDING', reservationCode: 'TKT-LEGACY' },
      price: 100,
    }
    expect(reservationCodeOf(ticket as any)).toBe('TKT-EXPLICIT')
    expect(reservationApprovalOf(ticket as any)).toBe('APPROVED')
    expect(reservationPaymentOf(ticket as any)).toBe('CONFIRMED')
  })

  it('derives legacy public paid reservation as pending', () => {
    const ticket = { metadata: { channel: 'public' }, price: 50 }
    expect(reservationApprovalOf(ticket as any)).toBe('PENDING')
    expect(reservationPaymentOf(ticket as any)).toBe('PENDING')
  })

  it('derives legacy public free reservation as approved/not required', () => {
    const ticket = { metadata: { channel: 'public' }, price: 0 }
    expect(reservationApprovalOf(ticket as any)).toBe('APPROVED')
    expect(reservationPaymentOf(ticket as any)).toBe('NOT_REQUIRED')
  })

  it('computes paid ticket detection', () => {
    expect(isPaidTicket({ price: 10, ticketType: { price: 0 } } as any)).toBe(true)
    expect(isPaidTicket({ price: 0, ticketType: { price: 25 } } as any)).toBe(true)
    expect(isPaidTicket({ price: 0, ticketType: { price: 0 } } as any)).toBe(false)
  })

  it('blocks credential issuance for pending paid or rejected reservations', () => {
    expect(
      canIssueReservationCredential({
        status: 'ISSUED',
        approvalStatus: 'PENDING',
        paymentStatus: 'PENDING',
        metadata: { channel: 'public' },
        price: 50,
      } as any),
    ).toBe(false)
    expect(
      canIssueReservationCredential({
        status: 'CANCELLED',
        approvalStatus: 'REJECTED',
        paymentStatus: 'FAILED',
        metadata: { channel: 'public' },
        price: 50,
      } as any),
    ).toBe(false)
    expect(
      canIssueReservationCredential({
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        paymentStatus: 'CONFIRMED',
        metadata: { channel: 'public' },
        price: 50,
      } as any),
    ).toBe(true)
    expect(
      canIssueReservationCredential({
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        paymentStatus: 'NOT_REQUIRED',
        metadata: { channel: 'public' },
        price: 0,
      } as any),
    ).toBe(true)
  })

  it('returns expected state patches', () => {
    expect(reservationStatePatch({ paid: false, approved: true })).toEqual({
      approvalStatus: 'APPROVED',
      paymentStatus: 'NOT_REQUIRED',
    })
    expect(reservationStatePatch({ paid: true, approved: false })).toEqual({
      approvalStatus: 'PENDING',
      paymentStatus: 'PENDING',
    })
    expect(reservationStatePatch({ paid: true, approved: true })).toEqual({
      approvalStatus: 'APPROVED',
      paymentStatus: 'CONFIRMED',
    })
    expect(reservationStatePatch({ paid: true, approved: false, rejected: true })).toEqual({
      approvalStatus: 'REJECTED',
      paymentStatus: 'FAILED',
    })
  })
})
