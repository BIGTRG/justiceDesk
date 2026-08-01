import {
  ALL_UPL_PATTERNS,
  DEFAULT_DISCLOSURE_FOOTER,
  DISCLOSURE_COPY_STATUS,
  defaultDisclosureConfig,
  scanForUpl,
  withDisclosure,
} from './guardrails.js'

describe('scanForUpl — directive advice is blocked', () => {
  it.each([
    ['You should file an answer before the deadline.', 'upl.directive_you_should'],
    ['You need to counterclaim for the harassment.', 'upl.directive_you_should'],
    ['I recommend disputing the debt in writing.', 'upl.recommendation'],
    ['I would advise you to settle.', 'upl.recommendation'],
    ['Your best defense is the statute of limitations.', 'upl.best_option'],
    ['The strongest argument here is lack of standing.', 'upl.best_option'],
    ['You will win this case.', 'upl.outcome_prediction'],
    ['You have a strong case against them.', 'upl.outcome_prediction'],
    ['The judge will rule in your favor.', 'upl.outcome_prediction'],
    ['In my legal opinion this debt is time-barred.', 'upl.legal_opinion'],
    ['This debt is not enforceable.', 'upl.legal_opinion'],
    ['As your attorney I can tell you this is fine.', 'upl.attorney_relationship'],
    ['You have plenty of time to respond.', 'upl.deadline_reassurance'],
    ['There is no need to respond right away.', 'upl.deadline_reassurance'],
  ])('blocks %p', (text, code) => {
    const result = scanForUpl(text)
    expect(result.blocked).toBe(true)
    expect(result.findings.map((f) => f.code)).toContain(code)
    expect(result.highestSeverity).toBe('block')
  })
})

describe('scanForUpl — authoritative actions are blocked', () => {
  it.each([
    "I'll file this with the court for you.",
    'We will serve the answer on your behalf.',
    "I'll sign the document for you.",
  ])('blocks %p', (text) => {
    expect(scanForUpl(text).blocked).toBe(true)
  })
})

describe('scanForUpl — legal information is allowed through', () => {
  it.each([
    'You should know that the court charges a filing fee.',
    'You need to bring two copies of the form to the clerk.',
    'You should check the deadline with the clerk of court.',
    'Under N.C. Gen. Stat. § 1A-1, Rule 12(a)(1), a defendant generally has 30 days after service to respond.',
    'People in this situation usually have two options. One is to file a written Answer. The other is to do nothing, which usually results in a default judgment.',
    'A statute of limitations is a time limit for bringing a lawsuit. Whether one applies here depends on the facts, and an attorney can review that with you.',
    'The magistrate hears small claims cases. Hearings are usually short.',
    'Your hearing is on April 6 at the Wake County Courthouse.',
  ])('allows %p', (text) => {
    const result = scanForUpl(text)
    expect(result.blocked).toBe(false)
    expect(result.flagged).toBe(false)
  })
})

describe('scanForUpl — review-severity findings', () => {
  it('flags a specific settlement figure for review without blocking', () => {
    const result = scanForUpl('You could offer them $500 to settle.')
    expect(result.flagged).toBe(true)
    expect(result.blocked).toBe(false)
    expect(result.highestSeverity).toBe('review')
    expect(result.findings[0]?.code).toBe('upl.settlement_amount')
  })
})

describe('scanForUpl — mechanics', () => {
  it('returns no findings for empty or benign text', () => {
    expect(scanForUpl('')).toMatchObject({ findings: [], blocked: false, flagged: false, highestSeverity: null })
  })

  it('finds every occurrence, not just the first', () => {
    const text = 'I recommend filing. Later on, I recommend appealing.'
    const findings = scanForUpl(text).findings.filter((f) => f.code === 'upl.recommendation')
    expect(findings).toHaveLength(2)
  })

  it('orders findings by position in the text', () => {
    const text = 'You will win. I recommend filing anyway.'
    const indices = scanForUpl(text).findings.map((f) => f.index)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  it('captures an excerpt for the review queue', () => {
    const result = scanForUpl('Some context here. I recommend disputing the debt. More context.')
    expect(result.findings[0]?.excerpt).toMatch(/I recommend disputing the debt/)
  })

  it('carries a remediation hint for regeneration', () => {
    const result = scanForUpl('I recommend disputing.')
    expect(result.findings[0]?.remediation).toMatch(/options/i)
  })

  it('is case-insensitive', () => {
    expect(scanForUpl('YOU SHOULD FILE AN ANSWER.').blocked).toBe(true)
  })

  it('does not leak regex state between calls', () => {
    const text = 'I recommend filing.'
    expect(scanForUpl(text).findings).toHaveLength(scanForUpl(text).findings.length)
    expect(scanForUpl(text).blocked).toBe(true)
    expect(scanForUpl(text).blocked).toBe(true)
  })

  it('accepts a narrowed pattern set', () => {
    const only = ALL_UPL_PATTERNS.filter((p) => p.code === 'upl.recommendation')
    expect(scanForUpl('You should file.', only).flagged).toBe(false)
    expect(scanForUpl('I recommend filing.', only).flagged).toBe(true)
  })
})

describe('disclosure', () => {
  const config = defaultDisclosureConfig()

  it('appends the footer', () => {
    const out = withDisclosure('Here is how the hearing works.', config)
    expect(out).toContain(DEFAULT_DISCLOSURE_FOOTER)
  })

  it('is idempotent — never stacks duplicate footers', () => {
    const once = withDisclosure('Body text.', config)
    expect(withDisclosure(once, config)).toBe(once)
  })

  it('states plainly that this is not legal advice', () => {
    expect(config.aiResponseFooter).toMatch(/not legal advice/i)
    expect(config.persistentFooter).toMatch(/not a law firm/i)
  })

  it('is still marked as draft copy pending counsel', () => {
    // Guard against shipping placeholder disclosure copy as final. When ethics counsel
    // approves the wording, this flips to 'approved' and this expectation changes with it.
    expect(DISCLOSURE_COPY_STATUS).toBe('draft_pending_counsel')
  })
})
