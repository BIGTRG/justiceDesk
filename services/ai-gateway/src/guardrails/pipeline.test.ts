/**
 * Guardrail pipeline tests.
 *
 * These are the compliance tests. They assert the properties ethics counsel will be asked
 * to sign off on: that advice is withheld, that uncurated citations never reach a filing,
 * that the disclosure is always present, and that a broken safety check fails closed.
 */

import { CitationLibrary, defaultDisclosureConfig } from '@justicedesk/shared'
import type { Classifier, ClassifierVerdict } from './classifier.js'
import { applyGuardrails, flagRowsFor, type GuardrailOptions } from './pipeline.js'

const disclosure = defaultDisclosureConfig()

const library = new CitationLibrary([
  {
    citation: 'N.C. Gen. Stat. § 1A-1, Rule 12(a)(1)',
    kind: 'rule',
    summary: 'A defendant generally has 30 days after service to answer.',
  },
  { citation: 'N.C. Gen. Stat. § 42-28', kind: 'statute', summary: 'Eviction summons.' },
])

const clean: ClassifierVerdict = {
  crossesLine: false,
  category: 'none',
  rationale: 'Information only.',
  confidence: 0.95,
}

const cleanClassifier: Classifier = async () => clean
const advisingClassifier: Classifier = async () => ({
  crossesLine: true,
  category: 'strategy_recommendation',
  rationale: 'Implies a course of action.',
  confidence: 0.9,
})

function opts(over: Partial<GuardrailOptions> = {}): GuardrailOptions {
  return {
    surface: 'assistant',
    library,
    disclosure,
    citationPolicy: 'strip',
    classifier: cleanClassifier,
    ...over,
  }
}

describe('a safe answer passes through', () => {
  const safe =
    'Your Answer is due on April 1, 2026. You file it with the Clerk of Court and send a copy to the other side. ' +
    'Under N.C. Gen. Stat. § 1A-1, Rule 12(a)(1), a defendant generally has 30 days after being served.'

  it('is returned with the disclosure appended', async () => {
    const result = await applyGuardrails(safe, opts())
    expect(result.outcome).toBe('passed')
    expect(result.text).toContain('Clerk of Court')
    expect(result.text).toContain(disclosure.aiResponseFooter)
  })

  it('produces no review flags', async () => {
    const result = await applyGuardrails(safe, opts())
    expect(result.requiresReview).toBe(false)
    expect(flagRowsFor(result)).toEqual([])
  })

  it('keeps a curated citation intact', async () => {
    const result = await applyGuardrails(safe, opts())
    expect(result.text).toContain('N.C. Gen. Stat. § 1A-1, Rule 12(a)(1)')
  })
})

describe('the deterministic layer blocks advice', () => {
  it('withholds a directive answer and never returns the text', async () => {
    const result = await applyGuardrails(
      'You should file a motion to dismiss — your best defense is the statute of limitations.',
      opts()
    )
    expect(result.outcome).toBe('blocked')
    expect(result.text).toBeNull()
    expect(result.blockedMessage).toMatch(/not able to give/i)
  })

  it('blocks before spending a classifier call', async () => {
    let calls = 0
    const classifier: Classifier = async () => {
      calls++
      return clean
    }
    await applyGuardrails('I recommend you settle.', opts({ classifier }))
    expect(calls).toBe(0)
  })

  it('records the finding for the review queue', async () => {
    const result = await applyGuardrails('You will win this case.', opts())
    const rows = flagRowsFor(result)
    expect(rows.some((r) => r.code === 'upl.outcome_prediction' && r.blocked)).toBe(true)
    expect(result.reviewReasons.join(' ')).toMatch(/Pattern guardrail matched/)
  })

  it('cannot be cleared by a clean classifier verdict', async () => {
    // Layers only add restrictions. A permissive classifier must not rescue a blocked answer.
    const result = await applyGuardrails('You should just pay it.', opts({ classifier: cleanClassifier }))
    expect(result.outcome).toBe('blocked')
  })
})

describe('the classifier layer catches implied advice', () => {
  const implied =
    'Most people in your position find that questioning whether the company can prove it owns the debt is where the case turns.'

  it('blocks when the classifier says the line was crossed', async () => {
    const result = await applyGuardrails(implied, opts({ classifier: advisingClassifier }))
    expect(result.outcome).toBe('blocked')
    expect(result.text).toBeNull()
  })

  it('would have passed the pattern layer alone — which is why this layer exists', async () => {
    const result = await applyGuardrails(implied, opts({ classifier: cleanClassifier }))
    expect(result.findings).toEqual([])
    expect(result.outcome).toBe('passed')
  })

  it('flags a low-confidence clean verdict for human review without blocking', async () => {
    const unsure: Classifier = async () => ({ ...clean, confidence: 0.4 })
    const result = await applyGuardrails('Some borderline wording.', opts({ classifier: unsure }))
    expect(result.outcome).toBe('passed')
    expect(result.requiresReview).toBe(true)
    expect(flagRowsFor(result).some((r) => r.code === 'classifier.low_confidence')).toBe(true)
  })
})

describe('citation enforcement', () => {
  const withBadCite = 'The rule here is N.C. Gen. Stat. § 99-1234, which sets the deadline.'

  it('strips an uncurated citation from a chat answer', async () => {
    const result = await applyGuardrails(withBadCite, opts({ citationPolicy: 'strip' }))
    expect(result.outcome).toBe('repaired')
    expect(result.text).not.toContain('99-1234')
    expect(result.text).toContain('citation removed')
    expect(result.requiresReview).toBe(true)
  })

  it('refuses to produce a document containing an uncurated citation', async () => {
    // The failure this prevents: a court filing citing a statute that does not exist.
    const result = await applyGuardrails(withBadCite, opts({ citationPolicy: 'reject' }))
    expect(result.outcome).toBe('blocked')
    expect(result.text).toBeNull()
    expect(result.blockedMessage).toMatch(/could not be prepared/i)
  })

  it('refuses a case citation in a document even though it looks authoritative', async () => {
    const result = await applyGuardrails(
      'See Smith v. Jones, 123 N.C. App. 456 (2001), which controls here.',
      opts({ citationPolicy: 'reject' })
    )
    expect(result.outcome).toBe('blocked')
  })

  it('records the violation for review either way', async () => {
    const stripped = await applyGuardrails(withBadCite, opts({ citationPolicy: 'strip' }))
    expect(flagRowsFor(stripped).some((r) => r.code === 'citation.uncurated')).toBe(true)
    const rejected = await applyGuardrails(withBadCite, opts({ citationPolicy: 'reject' }))
    expect(flagRowsFor(rejected).some((r) => r.code === 'citation.uncurated' && r.blocked)).toBe(true)
  })
})

describe('disclosure', () => {
  it('is appended to every conversational answer', async () => {
    const result = await applyGuardrails('The hearing is on April 6.', opts())
    expect(result.text).toContain(disclosure.aiResponseFooter)
  })

  it('survives citation repair, because it is appended after stripping', async () => {
    const result = await applyGuardrails(
      'Under N.C. Gen. Stat. § 99-1234 the answer is due soon.',
      opts({ citationPolicy: 'strip' })
    )
    expect(result.text).toContain(disclosure.aiResponseFooter)
  })

  it('is omitted from document body text, which carries the template’s own disclosure', async () => {
    const result = await applyGuardrails('I deny paragraph 4.', opts({ omitDisclosure: true }))
    expect(result.text).not.toContain(disclosure.aiResponseFooter)
  })
})

describe('failure modes', () => {
  it('never puts blocked text on a litigant-facing field', async () => {
    // Finding excerpts DO contain the offending text — the reviewer needs to see what
    // was blocked, and they land in upl_flags. What must never carry it is anything the
    // litigant reads: `text` and `blockedMessage`.
    for (const policy of ['strip', 'reject'] as const) {
      const result = await applyGuardrails(
        'I recommend you ignore this. You will win. See N.C. Gen. Stat. § 99-1.',
        opts({ citationPolicy: policy })
      )
      expect(result.text).toBeNull()
      expect(result.blockedMessage).not.toContain('ignore this')
      expect(result.blockedMessage).not.toContain('You will win')
    }
  })

  it('keeps the offending text in the flag excerpt, for the review queue', async () => {
    const result = await applyGuardrails('I recommend you ignore this.', opts())
    expect(flagRowsFor(result).some((r) => r.excerpt?.includes('ignore this'))).toBe(true)
  })

  it('a classifier that throws is treated as "not cleared"', async () => {
    // Availability is the right thing to trade: unknown safety must not read as safe.
    const { failClosed } = await import('./classifier.js')
    const broken: Classifier = async () => {
      throw new Error('upstream down')
    }
    const result = await applyGuardrails('Anything at all.', opts({ classifier: failClosed(broken) }))
    expect(result.outcome).toBe('blocked')
    expect(result.verdict.rationale).toMatch(/could not run/i)
  })

  it('handles an empty model response without throwing', async () => {
    const result = await applyGuardrails('', opts())
    expect(result.outcome).toBe('passed')
    expect(result.text).toContain(disclosure.aiResponseFooter)
  })
})
