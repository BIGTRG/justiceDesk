import {
  assertScriptsUsable,
  LEGALLY_OPERATIVE_LINES,
  SCRIPT_STATUS,
  SCRIPT_VERSION,
  ScriptsNotApprovedError,
  scriptFor,
} from './scripts.js'
import { redactEventPayload } from './session.js'

describe('the script approval interlock', () => {
  it('allows draft scripts while the compliance gate is closed', () => {
    // Staging is exactly where draft copy belongs.
    expect(() => assertScriptsUsable(false)).not.toThrow()
  })

  it('refuses to answer calls with draft scripts once the gate opens', () => {
    // Placeholder copy going live is the failure this prevents.
    expect(() => assertScriptsUsable(true)).toThrow(ScriptsNotApprovedError)
  })

  it('names the legally operative lines in the error', () => {
    try {
      assertScriptsUsable(true)
    } catch (err) {
      const message = (err as Error).message
      for (const line of LEGALLY_OPERATIVE_LINES) expect(message).toContain(line)
    }
  })

  it('is still marked draft', () => {
    expect(SCRIPT_STATUS).toBe('draft_pending_counsel')
  })
})

describe('the legally operative lines', () => {
  it('announces recording, non-law-firm status and no legal advice, in one breath', () => {
    const notice = scriptFor('recording_notice')
    expect(notice).toMatch(/recorded/i)
    expect(notice).toMatch(/not a law firm/i)
    expect(notice).toMatch(/cannot give you legal advice/i)
  })

  it('states the referral fee is flat and outcome-independent', () => {
    // Non-negotiable #2: never contingent on case value or retention.
    const disclosure = scriptFor('referral_disclosure')
    expect(disclosure).toMatch(/flat fee/i)
    expect(disclosure).toMatch(/same whatever happens/i)
    expect(disclosure).toMatch(/contact you/i)
  })

  it('offers a one-tap opt-out when asking for TCPA consent', () => {
    expect(scriptFor('tcpa_consent_request')).toMatch(/STOP/)
  })

  it('offers a way out at the paywall rather than only a way to pay', () => {
    // A caller who cannot pay should not be cornered.
    expect(scriptFor('paywall_notice')).toMatch(/decide later|link instead/i)
  })

  it('gives no legal advice in any line', () => {
    for (const line of LEGALLY_OPERATIVE_LINES) {
      const text = scriptFor(line)
      expect(text).not.toMatch(/\byou should\b/i)
      expect(text).not.toMatch(/\bI recommend\b/i)
      expect(text).not.toMatch(/your best/i)
    }
  })

  it('tells a caller whose payment failed that nothing more is charged', () => {
    expect(scriptFor('payment_failed')).toMatch(/nothing more will be charged/i)
  })
})

describe('Spanish', () => {
  it('has every line the English table has', () => {
    for (const line of LEGALLY_OPERATIVE_LINES) {
      expect(scriptFor(line, 'es').length).toBeGreaterThan(20)
    }
  })

  it('carries the same required disclosures', () => {
    expect(scriptFor('recording_notice', 'es')).toMatch(/graba/i)
    expect(scriptFor('recording_notice', 'es')).toMatch(/no es un bufete/i)
    expect(scriptFor('tcpa_consent_request', 'es')).toMatch(/STOP/)
  })
})

describe('script versioning', () => {
  it('carries a version stamped onto every consent record', () => {
    // A consent claim has to be evidenced against the wording actually read.
    expect(SCRIPT_VERSION).toMatch(/^draft-/)
  })
})

describe('event payload redaction', () => {
  it('keeps caller speech out of the operational event log', () => {
    const payload = redactEventPayload({
      type: 'consent_captured',
      atMs: 1000,
      kind: 'tcpa_sms',
      granted: true,
    })
    expect(payload).toEqual({ kind: 'tcpa_sms', granted: true })
    expect(payload.type).toBeUndefined()
    expect(payload.atMs).toBeUndefined()
  })

  it('replaces an utterance with a pointer to the transcript', () => {
    const payload = redactEventPayload({
      type: 'contact_captured',
      atMs: 1,
      // @ts-expect-error deliberately passing a field the type does not carry
      utterance: 'my number is 919-555-0123',
    })
    expect(payload.utterance).toBe('[stored in transcript]')
  })
})
