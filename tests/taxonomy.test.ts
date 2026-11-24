import { describe, expect, it } from 'vitest'
import {
  ATTENDEE_TYPE_CODES,
  EVENT_CATEGORY_CODES,
  EVENT_DOMAIN_CODES,
  EVENT_FORMAT_CODES,
  TICKET_TIER_CODES,
  allowedAttendeeTypes,
  normalizeToken,
  resolveAttendeeType,
  resolveEventCategory,
  resolveEventDomain,
  resolveEventFormat,
  resolveTicketTier,
  taxonomySnapshot,
} from '../src/config/taxonomy.js'

describe('taxonomy code sets', () => {
  it('matches the existing Prisma enums exactly', () => {
    expect(EVENT_FORMAT_CODES).toEqual([
      'CONFERENCE', 'CONCERT', 'WEDDING', 'SPORTS', 'EXHIBITION',
      'CHARITY', 'CORPORATE', 'UNIVERSITY', 'OTHER',
    ])
    expect(TICKET_TIER_CODES).toEqual([
      'STANDARD', 'VIP', 'PREMIUM', 'EARLY_BIRD', 'STUDENT',
      'COMPLIMENTARY', 'STAFF', 'SPEAKER', 'SPONSOR', 'OTHER',
    ])
    expect(ATTENDEE_TYPE_CODES).toEqual([
      'ATTENDEE', 'VIP', 'SPEAKER', 'SPONSOR', 'EXHIBITOR', 'MEDIA',
      'STAFF', 'ORGANIZER', 'STUDENT', 'GUEST', 'OTHER',
    ])
  })

  it('keeps legacy event categories and new domains separate', () => {
    expect(EVENT_CATEGORY_CODES).toContain('FESTIVAL')
    expect(EVENT_CATEGORY_CODES).not.toContain('TECHNOLOGY')
    expect(EVENT_DOMAIN_CODES).toContain('TECHNOLOGY')
    expect(EVENT_DOMAIN_CODES).not.toContain('FESTIVAL')
  })
})

describe('normalization', () => {
  it('normalizes SAC-style tokens consistently', () => {
    expect(normalizeToken(' Business / Corporate Events ')).toBe('business_corporate_events')
    expect(normalizeToken('Follow-Up')).toBe('follow_up')
    expect(normalizeToken('R&D')).toBe('r_and_d')
    expect(normalizeToken('')).toBe('')
  })

  it('maps SAC event categories to TKT formats without conflating the class', () => {
    expect(resolveEventFormat('educational')?.code).toBe('CONFERENCE')
    expect(resolveEventFormat('business_corporate')?.code).toBe('CORPORATE')
    expect(resolveEventFormat('technology')?.code).toBe('CONFERENCE')
    expect(resolveEventFormat('sports')?.code).toBe('SPORTS')
    expect(resolveEventFormat('music_concert')?.code).toBe('CONCERT')
    expect(resolveEventFormat('charity')?.code).toBe('CHARITY')
    expect(resolveEventFormat('protocol_official')?.code).toBe('OTHER')
    expect(resolveEventFormat('not-a-real-format')).toBeNull()
  })

  it('resolves legacy categories and domains independently', () => {
    expect(resolveEventCategory('music')?.code).toBe('CONCERT')
    expect(resolveEventCategory('expo')?.code).toBe('EXHIBITION')
    expect(resolveEventDomain('technology')?.code).toBe('TECHNOLOGY')
    expect(resolveEventDomain('charity')?.code).toBe('NON_PROFIT')
    expect(resolveEventDomain('music')?.code).toBe('ENTERTAINMENT')
  })

  it('canonicalizes legacy ticket tier labels', () => {
    expect(resolveTicketTier('General')?.code).toBe('STANDARD')
    expect(resolveTicketTier('general admission')?.code).toBe('STANDARD')
    expect(resolveTicketTier('Early Bird')?.code).toBe('EARLY_BIRD')
    expect(resolveTicketTier('Comp')?.code).toBe('COMPLIMENTARY')
    expect(resolveTicketTier('VIP')?.code).toBe('VIP')
    expect(resolveTicketTier('platinum')?.code).toBe('PREMIUM')
    expect(resolveTicketTier('something else')).toBeNull()
  })

  it('maps the full SAC attendee alias set into TKT codes', () => {
    const expectations: [string, string][] = [
      ['regular', 'ATTENDEE'],
      ['member', 'ATTENDEE'],
      ['vip_guest', 'VIP'],
      ['press', 'MEDIA'],
      ['professor', 'SPEAKER'],
      ['keynote_speaker', 'SPEAKER'],
      ['brand', 'SPONSOR'],
      ['exhibitor', 'EXHIBITOR'],
      ['safety_team', 'STAFF'],
      ['follow_up', 'STAFF'],
      ['organizer', 'ORGANIZER'],
      ['student', 'STUDENT'],
      ['diplomat', 'GUEST'],
      ['government_official', 'GUEST'],
      ['athlete', 'GUEST'],
      ['unknown-type', 'OTHER'],
    ]
    for (const [alias, code] of expectations) {
      expect(resolveAttendeeType(alias)?.code, `alias ${alias}`).toBe(code)
    }
    expect(resolveAttendeeType(null)).toBeNull()
  })
})

describe('policy helper', () => {
  it('uses the event format first and includes student access for conferences', () => {
    const allowed = allowedAttendeeTypes('CONFERENCE', 'PRIVATE')
    expect(allowed).toContain('STUDENT')
    expect(allowed).toContain('SPEAKER')
    expect(allowed).not.toContain('EXHIBITOR')
  })

  it('includes exhibitors for exhibitions', () => {
    expect(allowedAttendeeTypes('EXHIBITION')).toContain('EXHIBITOR')
  })

  it('returns the full catalog only when the format is unknown', () => {
    expect(allowedAttendeeTypes('mystery')).toEqual([...ATTENDEE_TYPE_CODES])
  })
})

describe('metadata snapshot', () => {
  it('returns all sections and does not leak internal indexes', () => {
    const snapshot = taxonomySnapshot()
    expect(snapshot.eventFormats).toHaveLength(EVENT_FORMAT_CODES.length)
    expect(snapshot.eventCategories).toHaveLength(EVENT_CATEGORY_CODES.length)
    expect(snapshot.eventDomains).toHaveLength(EVENT_DOMAIN_CODES.length)
    expect(snapshot.ticketTiers).toHaveLength(TICKET_TIER_CODES.length)
    expect(snapshot.attendeeTypes).toHaveLength(ATTENDEE_TYPE_CODES.length)
    expect(Object.keys(snapshot)).toEqual([
      'eventFormats', 'eventCategories', 'eventDomains', 'ticketTiers', 'attendeeTypes',
    ])
  })
})
