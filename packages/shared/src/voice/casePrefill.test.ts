/**
 * Prefill tests — v2 non-negotiable #7.
 *
 * The requirement is that a subscribing caller never repeats themselves. These assert
 * that facts carry over, and — more importantly — that anything which does NOT carry over
 * is reported rather than silently lost.
 */

import { describeCoverage, prefillCaseFromCall, type CallFacts } from './casePrefill.js'

const fullCall: CallFacts = {
  detectedCaseType: 'debt_defense',
  county: 'Wake',
  role: 'defendant',
  anchors: { service_date: '2026-03-02', hearing_date: '2026-04-15' },
  serviceMethod: 'first_class_mail',
  opposingParty: 'Acme Recovery LLC',
  courtCaseNumber: '26 CVD 001234',
  amountClaimedCents: 184500,
  narrative: 'They say I owe on a card I closed years ago.',
  callerName: 'Jane Doe',
  answers: { defense_too_old: true, recognize_debt: 'no' },
}

describe('a caller never repeats themselves', () => {
  const result = prefillCaseFromCall(fullCall)

  it('carries every fact across', () => {
    expect(result.coverage.lossless).toBe(true)
    expect(result.coverage.dropped.filter((d) => d.reason !== 'no_destination')).toEqual([])
  })

  it('carries the deadline anchors, which is what drives the whole timeline', () => {
    expect(result.metadata.anchors).toEqual({
      service_date: '2026-03-02',
      hearing_date: '2026-04-15',
    })
  })

  it('carries the service method, because it changes the deadline', () => {
    expect(result.metadata.serviceMethod).toBe('first_class_mail')
  })

  it('seeds the interview so S7 opens pre-filled', () => {
    expect(result.interviewAnswers).toMatchObject({
      full_name: 'Jane Doe',
      court_case_number: '26 CVD 001234',
      plaintiff_name: 'Acme Recovery LLC',
      amount_claimed: '1845.00',
      defense_too_old: true,
      recognize_debt: 'no',
    })
  })

  it('keeps the caller’s own words as their words', () => {
    expect(result.metadata.intakeSummary).toBe('They say I owe on a card I closed years ago.')
  })

  it('defaults an unknown role to defendant', () => {
    // Most callers to this product have been sued, not the other way round. Getting it
    // wrong shows the wrong timeline, so the safer default is the common one.
    expect(prefillCaseFromCall({ role: 'unknown' }).role).toBe('defendant')
    expect(prefillCaseFromCall({ role: 'plaintiff' }).role).toBe('plaintiff')
  })
})

describe('it refuses to coerce, and says what it dropped', () => {
  it('drops an unparseable date rather than guessing one', () => {
    // A wrong service date silently becoming a deadline anchor is the worst thing this
    // pipeline could produce.
    const result = prefillCaseFromCall({ anchors: { service_date: 'last Tuesday' } })
    expect(result.metadata.anchors).toBeUndefined()
    expect(result.coverage.lossless).toBe(false)
    expect(result.coverage.dropped[0]).toMatchObject({
      field: 'anchors.service_date',
      reason: 'invalid_date',
    })
  })

  it('explains the consequence of a dropped date in the report', () => {
    const result = prefillCaseFromCall({ anchors: { service_date: '03/02/2026' } })
    expect(result.coverage.dropped[0]!.detail).toMatch(/asked for it again/i)
  })

  it('drops a date that does not exist', () => {
    expect(prefillCaseFromCall({ anchors: { service_date: '2026-02-30' } }).coverage.lossless).toBe(
      false
    )
  })

  it('drops an anchor the deadline engine does not know', () => {
    const result = prefillCaseFromCall({ anchors: { the_day_i_got_upset: '2026-03-02' } })
    expect(result.coverage.dropped[0]).toMatchObject({ reason: 'unknown_anchor' })
    expect(result.metadata.anchors).toBeUndefined()
  })

  it('drops an unrecognised service method rather than assuming personal service', () => {
    // Assuming wrong here silently removes three days from the caller's deadline.
    const result = prefillCaseFromCall({
      serviceMethod: 'left_it_on_my_porch' as never,
    })
    expect(result.metadata.serviceMethod).toBeUndefined()
    expect(result.coverage.dropped[0]).toMatchObject({ reason: 'unrecognised_service_method' })
    expect(result.coverage.dropped[0]!.detail).toMatch(/three mailing days/i)
  })

  it('keeps the good facts when one is bad', () => {
    const result = prefillCaseFromCall({
      anchors: { service_date: '2026-03-02', hearing_date: 'sometime in April' },
      opposingParty: 'Acme',
    })
    expect(result.metadata.anchors).toEqual({ service_date: '2026-03-02' })
    expect(result.metadata.opposingParty).toBe('Acme')
    expect(result.coverage.transferred).toContain('anchors.service_date')
    expect(result.coverage.lossless).toBe(false)
  })
})

describe('the phone number is deliberately not carried into the document', () => {
  it('is reported as destination-less, not as a loss', () => {
    const result = prefillCaseFromCall({ callerPhone: '+19195550123' })
    expect(result.interviewAnswers.phone).toBeUndefined()
    // It belongs to the account. A filing carries it only if the litigant puts it there.
    expect(result.coverage.dropped[0]).toMatchObject({ field: 'callerPhone', reason: 'no_destination' })
    expect(result.coverage.lossless).toBe(true)
  })

  it('never appears anywhere in the prefilled case', () => {
    const result = prefillCaseFromCall({ callerPhone: '+19195550123', callerName: 'Jane Doe' })
    expect(JSON.stringify(result.metadata)).not.toContain('9195550123')
    expect(JSON.stringify(result.interviewAnswers)).not.toContain('9195550123')
  })
})

describe('empty and partial calls', () => {
  it('handles a call that gathered nothing', () => {
    const result = prefillCaseFromCall({})
    expect(result.coverage.lossless).toBe(true)
    expect(result.coverage.transferred).toEqual([])
    expect(result.metadata).toEqual({})
  })

  it('does not treat a fact the caller never mentioned as lost', () => {
    // Losslessness is "nothing they gave us was dropped", not "we filled everything in".
    const result = prefillCaseFromCall({ callerName: 'Jane Doe' })
    expect(result.coverage.lossless).toBe(true)
  })

  it('ignores blank and null values without reporting them', () => {
    const result = prefillCaseFromCall({
      opposingParty: '   ',
      narrative: '',
      anchors: { service_date: null, hearing_date: undefined },
      answers: { a: '', b: null },
    })
    expect(result.coverage.dropped).toEqual([])
    expect(result.coverage.transferred).toEqual([])
  })
})

describe('bounds', () => {
  it('truncates rather than storing unbounded caller text', () => {
    const result = prefillCaseFromCall({ narrative: 'x'.repeat(10_000) })
    expect(result.metadata.intakeSummary!.length).toBe(4000)
    expect((result.interviewAnswers.additional_facts as string).length).toBe(2000)
  })

  it('normalises a negative amount to zero rather than storing it', () => {
    expect(prefillCaseFromCall({ amountClaimedCents: -500 }).metadata.amountClaimedCents).toBe(0)
  })

  it('ignores a non-finite amount', () => {
    expect(prefillCaseFromCall({ amountClaimedCents: NaN }).metadata.amountClaimedCents).toBeUndefined()
  })
})

describe('describeCoverage', () => {
  it('says nothing was lost when nothing was', () => {
    expect(describeCoverage(prefillCaseFromCall(fullCall).coverage)).toMatch(/nothing lost/)
  })

  it('names the lost fields so an operator can act on it', () => {
    const coverage = prefillCaseFromCall({ anchors: { service_date: 'bad' } }).coverage
    expect(describeCoverage(coverage)).toMatch(/1 lost: anchors\.service_date/)
  })

  it('does not count a destination-less field as lost', () => {
    const coverage = prefillCaseFromCall({ callerPhone: '+19195550123' }).coverage
    expect(describeCoverage(coverage)).toMatch(/nothing lost/)
  })
})
