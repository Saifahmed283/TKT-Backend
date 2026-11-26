import { describe, expect, it } from 'vitest'
import { ticketDesignSchema } from '../src/features/public/schemas.js'

describe('public reservation ticket design schema', () => {
  const validDesign = {
    templateId: 'signature-split',
    paletteId: 'rose-noir',
    panelColor: '#350D24',
    accentColor: '#F22586',
    backgroundColor: '#FFF2F7',
    textColor: '#2A1020',
  }

  it('accepts supported templates and six-digit hex colors', () => {
    expect(ticketDesignSchema.parse(validDesign)).toEqual(validDesign)
  })

  it('rejects non-hex colors and script-like payloads', () => {
    expect(ticketDesignSchema.safeParse({
      ...validDesign,
      panelColor: 'red; background:url(javascript:alert(1))',
    }).success).toBe(false)
  })

  it('rejects presentation-only keys that are not part of the API contract', () => {
    expect(ticketDesignSchema.safeParse({
      ...validDesign,
      label: 'Rose Noir',
      id: 'rose-noir',
    }).success).toBe(false)
  })
})
