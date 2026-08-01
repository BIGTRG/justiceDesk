/**
 * Referral qualification tests.
 *
 * These are compliance tests as much as logic tests: they pin non-negotiables #2, #3 and
 * #4 at the point where money changes hands.
 */

import {
  billingEligibility,
  fallbackFeeKeyFor,
  feeKeyFor,
  LEAD_BODY_FORBIDDEN_FIELDS,
  metSpeedTarget,
  qualifyLead,
  SPEED_TO_LEAD_TARGET_MS,
  type LeadQualification,
} from './qualification.js'

function lead(over: Partial<LeadQualification> = {}): LeadQualification {
  return {
    practiceArea: 'family',
    county: 'Wake',
    state: 'NC',
    notAlreadyRepresented: true,
    consentTcpa: true,
    consentReferralDisclosure: true,
    summary: 'Caller asked about a custody matter and wants a lawyer.',
    contactPhone: '+19195550123',
    ...over,
  }
}

describe('a lead only qualifies when every gate passes', () => {
  it('accepts a complete lead', () => {
    expect(qualifyLead(lead())).toMatchObject({ qualified: true, failures: [] })
  })

  it('refuses when nobody asked about existing representation (#3)', () => {
    const result = qualifyLead(lead({ notAlreadyRepresented: null }))
    expect(result.qualified).toBe(false)
    expect(result.failures).toContain('no_representation_check')
  })

  it('refuses a caller who already has a lawyer (#3)', () => {
    const result = qualifyLead(lead({ notAlreadyRepresented: false }))
    expect(result.qualified).toBe(false)
    expect(result.failures).toContain('already_represented')
  })

  it('refuses without TCPA consent (#4)', () => {
    // Passing this on is a problem for the recipient as much as for us.
    const result = qualifyLead(lead({ consentTcpa: false }))
    expect(result.qualified).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/TCPA/)
  })

  it('refuses without the referral disclosure acknowledged', () => {
    // The caller must know an attorney will contact them before their details move.
    const result = qualifyLead(lead({ consentReferralDisclosure: false }))
    expect(result.qualified).toBe(false)
    expect(result.failures).toContain('no_referral_disclosure')
  })

  it('refuses a lead nobody can act on', () => {
    expect(qualifyLead(lead({ summary: '   ' })).failures).toContain('no_summary')
    expect(qualifyLead(lead({ contactPhone: null })).failures).toContain('no_contact')
  })

  it('refuses an area no panel covers', () => {
    expect(qualifyLead(lead({ practiceArea: 'other' })).failures).toContain('unsupported_area')
  })

  it('reports every failure at once rather than one at a time', () => {
    const result = qualifyLead(
      lead({ notAlreadyRepresented: null, consentTcpa: false, summary: '', contactPhone: null })
    )
    expect(result.failures).toHaveLength(4)
    expect(result.reasons).toHaveLength(4)
  })

  it('gives plain-language reasons for the admin queue', () => {
    const result = qualifyLead(lead({ notAlreadyRepresented: false }))
    expect(result.reasons[0]).toMatch(/already has a lawyer/i)
  })
})

describe('non-negotiable #2 — the fee cannot vary by case', () => {
  it('resolves a fee key from practice area and county alone', () => {
    expect(feeKeyFor('family', 'Wake')).toBe('referral.family.wake')
    expect(feeKeyFor('personal_injury', 'New Hanover')).toBe('referral.personal_injury.new_hanover')
  })

  it('produces the same key regardless of damages band', () => {
    // The structural guarantee: `feeKeyFor` has no parameter through which case value
    // could influence price. Two leads differing only in damages band price identically.
    const small = lead({ damagesBand: 'under_5k' })
    const large = lead({ damagesBand: 'over_100k' })
    expect(feeKeyFor(small.practiceArea, small.county)).toBe(
      feeKeyFor(large.practiceArea, large.county)
    )
  })

  it('takes exactly two arguments, so nothing else can reach the price', () => {
    // If someone later adds a third parameter, this fails and they have to justify it.
    expect(feeKeyFor).toHaveLength(2)
  })

  it('normalises county casing and spacing so one county is one price', () => {
    expect(feeKeyFor('family', '  WAKE ')).toBe(feeKeyFor('family', 'wake'))
  })

  it('has a per-area fallback when no county fee is published', () => {
    expect(fallbackFeeKeyFor('family')).toBe('referral.family.default')
  })
})

describe('billing is a separate gate from qualification', () => {
  const qualified = qualifyLead(lead())

  const base = {
    qualification: qualified,
    delivered: true,
    publishedFeeCents: 6000,
    alreadyCharged: false,
    disputeOpen: false,
  }

  it('bills a qualified, delivered lead with a published fee', () => {
    expect(billingEligibility(base)).toEqual({ billable: true, blocks: [] })
  })

  it('does not bill a lead that reached nobody', () => {
    // Qualification alone would otherwise charge for leads that never got delivered.
    expect(billingEligibility({ ...base, delivered: false }).blocks).toContain('not_delivered')
  })

  it('does not bill when no fee is published', () => {
    // The expected state while COMPLIANCE.md §3 is open: no referral fees are seeded.
    expect(billingEligibility({ ...base, publishedFeeCents: null }).blocks).toContain(
      'no_published_fee'
    )
  })

  it('does not bill twice for the same lead', () => {
    expect(billingEligibility({ ...base, alreadyCharged: true }).blocks).toContain('already_charged')
  })

  it('does not bill while a dispute is open', () => {
    expect(billingEligibility({ ...base, disputeOpen: true }).blocks).toContain('disputed')
  })

  it('never bills an unqualified lead', () => {
    const unqualified = qualifyLead(lead({ notAlreadyRepresented: false }))
    expect(billingEligibility({ ...base, qualification: unqualified }).billable).toBe(false)
  })

  it('reports every block at once', () => {
    const result = billingEligibility({
      ...base,
      delivered: false,
      publishedFeeCents: null,
      disputeOpen: true,
    })
    expect(result.blocks).toHaveLength(3)
  })
})

describe('speed to lead', () => {
  it('targets 60 seconds', () => {
    expect(SPEED_TO_LEAD_TARGET_MS).toBe(60_000)
  })

  it('counts a delivery inside the window as met', () => {
    const at = new Date('2026-08-01T12:00:00Z')
    expect(metSpeedTarget(at, new Date(at.getTime() + 45_000))).toBe(true)
    expect(metSpeedTarget(at, new Date(at.getTime() + 60_000))).toBe(true)
    expect(metSpeedTarget(at, new Date(at.getTime() + 61_000))).toBe(false)
  })
})

describe('contact details are not broadcast with the offer', () => {
  it('names the fields excluded from the lead body', () => {
    // A lead fanned out to a panel would otherwise hand the caller's phone number to
    // every firm that looked at it and declined.
    expect(LEAD_BODY_FORBIDDEN_FIELDS).toEqual(
      expect.arrayContaining(['contactPhone', 'contactEmail', 'transcript'])
    )
  })
})
