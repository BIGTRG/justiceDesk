/**
 * Call state machine tests.
 *
 * These are the revenue and compliance tests. They assert the three invariants the
 * machine exists to hold: a call never ends without an outcome, the free window is never
 * billed, and nothing is recorded before the announcement plays.
 */

import {
  billableMsAt,
  finalize,
  initialSnapshot,
  meteredChargeCents,
  replay,
  transition,
} from './callStateMachine.js'
import {
  DEFAULT_PAYWALL_POLICY,
  IllegalCallTransitionError,
  type CallEvent,
  type CallSnapshot,
  type PaywallPolicy,
} from './types.js'

const MIN = 60_000
const policy = DEFAULT_PAYWALL_POLICY

/** Answer the call and play the announcement — the preamble to every scenario. */
function answered(): CallSnapshot {
  const { snapshot } = replay([
    { type: 'call_answered', atMs: 0 },
    { type: 'recording_announced', atMs: 2_000 },
  ])
  return snapshot
}

function run(events: CallEvent[], p: PaywallPolicy = policy) {
  return replay(
    [{ type: 'call_answered', atMs: 0 }, { type: 'recording_announced', atMs: 2_000 }, ...events],
    p
  )
}

describe('recording announcement (non-negotiable #5)', () => {
  it('announces before anything else happens', () => {
    const { effects } = transition(initialSnapshot(), { type: 'call_answered', atMs: 0 })
    expect(effects).toEqual([
      { type: 'say', key: 'recording_notice' },
      { type: 'announce_recording' },
    ])
  })

  it('does not enter the free window until the announcement has played', () => {
    const { snapshot } = transition(initialSnapshot(), { type: 'call_answered', atMs: 0 })
    expect(snapshot.state).toBe('greeting')
    expect(snapshot.recordingAnnouncedAtMs).toBeNull()
  })

  it('records when the announcement actually played, not when it was queued', () => {
    expect(answered().recordingAnnouncedAtMs).toBe(2_000)
    expect(answered().state).toBe('free_window')
  })
})

describe('the free window (rung 1)', () => {
  it('is not billable', () => {
    const { snapshot } = run([{ type: 'tick', atMs: 2 * MIN }])
    expect(snapshot.state).toBe('free_window')
    expect(billableMsAt(snapshot, 2 * MIN)).toBe(0)
  })

  it('offers the paywall once the window plus grace has elapsed', () => {
    const { snapshot, effects } = run([
      { type: 'tick', atMs: policy.freeWindowMs + policy.graceMs },
    ])
    expect(snapshot.state).toBe('paywall_offer')
    expect(effects).toContainEqual({
      type: 'offer_paywall',
      perMinuteCents: 199,
      flatSessionCents: 900,
    })
  })

  it('does not cut the caller off mid-sentence during the grace period', () => {
    // Grace exists so the answer in flight can finish.
    const { snapshot } = run([{ type: 'tick', atMs: policy.freeWindowMs + 1_000 }])
    expect(snapshot.state).toBe('free_window')
  })

  it('expires on the clock even if the scheduled timer never fires', () => {
    // A missed timer must not hand out unlimited free minutes.
    const { snapshot } = run([{ type: 'tick', atMs: 30 * MIN }])
    expect(snapshot.state).toBe('paywall_offer')
  })

  it('lets a caller convert without ever seeing a paywall', () => {
    const { snapshot } = run([
      { type: 'subscription_requested', atMs: 90_000, caseTypeKey: 'debt_defense' },
    ])
    expect(snapshot.state).toBe('outcome_capture')
  })
})

describe('the paywall (rung 2)', () => {
  const atPaywall = () => run([{ type: 'free_window_elapsed', atMs: 3 * MIN }]).snapshot

  it('starts metering when the caller chooses per-minute', () => {
    const { snapshot, effects } = transition(atPaywall(), {
      type: 'caller_chose_metered',
      atMs: 3 * MIN,
    })
    expect(snapshot.state).toBe('metered')
    expect(snapshot.meteringStartedMs).toBe(3 * MIN)
    expect(effects).toContainEqual({ type: 'start_metering', perMinuteCents: 199 })
  })

  it('sends a payment link for the flat session', () => {
    const { snapshot, effects } = transition(atPaywall(), {
      type: 'caller_chose_flat_session',
      atMs: 3 * MIN,
    })
    expect(snapshot.state).toBe('flat_session')
    expect(effects).toContainEqual({
      type: 'send_payment_link',
      kind: 'flat_session',
      amountCents: 900,
    })
  })

  it('moves a decline to outcome capture and asks for TCPA consent', () => {
    const { snapshot, effects } = transition(atPaywall(), {
      type: 'caller_declined_paywall',
      atMs: 3 * MIN,
    })
    expect(snapshot.state).toBe('outcome_capture')
    expect(effects).toContainEqual({ type: 'request_consent', kind: 'tcpa_sms' })
  })

  it('can be waived by policy, and never is by default', () => {
    expect(policy.waivePaywall).toBeUndefined()

    const waiving: PaywallPolicy = { ...policy, waivePaywall: () => true }
    const { snapshot } = run([{ type: 'free_window_elapsed', atMs: 3 * MIN }], waiving)
    expect(snapshot.state).toBe('free_window')
  })
})

describe('billing', () => {
  it('bills only from the moment metering starts', () => {
    const { snapshot } = run([
      { type: 'free_window_elapsed', atMs: 3 * MIN },
      { type: 'caller_chose_metered', atMs: 3 * MIN },
    ])
    // Five minutes into a call that has been metered for two.
    expect(billableMsAt(snapshot, 5 * MIN)).toBe(2 * MIN)
  })

  it('rounds partial minutes down, never up', () => {
    // Billing 2 minutes for 61 seconds is technically disclosed and still reads as
    // sharp practice to someone already being sued over money.
    expect(meteredChargeCents(61_000, 199)).toBe(199)
    expect(meteredChargeCents(119_999, 199)).toBe(199)
    expect(meteredChargeCents(120_000, 199)).toBe(398)
    expect(meteredChargeCents(59_000, 199)).toBe(0)
  })

  it('stops the clock when a payment fails rather than accruing more', () => {
    const { snapshot, effects } = run([
      { type: 'free_window_elapsed', atMs: 3 * MIN },
      { type: 'caller_chose_metered', atMs: 3 * MIN },
      { type: 'payment_failed', atMs: 5 * MIN, reason: 'card_declined' },
    ])
    expect(snapshot.meteringStartedMs).toBeNull()
    expect(snapshot.billableMs).toBe(2 * MIN)
    expect(effects).toContainEqual({ type: 'stop_metering' })
    // Billable time does not keep growing after the stop.
    expect(billableMsAt(snapshot, 20 * MIN)).toBe(2 * MIN)
  })

  it('stops metering the moment the caller converts to a document', () => {
    // Otherwise they are charged per-minute while being sold something else.
    const { snapshot } = run([
      { type: 'free_window_elapsed', atMs: 3 * MIN },
      { type: 'caller_chose_metered', atMs: 3 * MIN },
      { type: 'document_requested', atMs: 6 * MIN, templateKey: 'nc_debt_answer' },
    ])
    expect(snapshot.meteringStartedMs).toBeNull()
    expect(billableMsAt(snapshot, 20 * MIN)).toBe(3 * MIN)
  })
})

describe('every call ends with an outcome (non-negotiable #1)', () => {
  it('is impossible to reach `ended` without one', () => {
    // Exhaustive over hangup points: no path yields a null outcome.
    const hangupPoints: CallEvent[][] = [
      [],
      [{ type: 'tick', atMs: MIN }],
      [{ type: 'free_window_elapsed', atMs: 3 * MIN }],
      [
        { type: 'free_window_elapsed', atMs: 3 * MIN },
        { type: 'caller_chose_metered', atMs: 3 * MIN },
      ],
      [
        { type: 'free_window_elapsed', atMs: 3 * MIN },
        { type: 'caller_declined_paywall', atMs: 3 * MIN },
      ],
    ]
    for (const prefix of hangupPoints) {
      const { snapshot } = run([...prefix, { type: 'caller_hung_up', atMs: 10 * MIN }])
      expect(snapshot.state).toBe('ended')
      expect(snapshot.outcome).not.toBeNull()
    }
  })

  it('records an early hangup as abandoned, not as "none"', () => {
    // These are different facts. Folding them together would inflate the no-capture
    // bucket with people who were never asked for anything, and free-window
    // abandonment would stop meaning anything.
    const { snapshot } = run([{ type: 'caller_hung_up', atMs: 40_000 }])
    expect(snapshot.outcome).toBe('abandoned')
  })

  it('does not credit a paid session to someone who hung up during the pitch', () => {
    const { snapshot } = run([
      { type: 'free_window_elapsed', atMs: 3 * MIN },
      { type: 'caller_hung_up', atMs: 3.2 * MIN },
    ])
    expect(snapshot.outcome).not.toBe('paid_session')
    expect(snapshot.outcome).toBe('none')
  })

  it('credits a paid session only when money actually settled', () => {
    const { snapshot } = run([
      { type: 'free_window_elapsed', atMs: 3 * MIN },
      { type: 'caller_chose_metered', atMs: 3 * MIN },
      { type: 'payment_settled', atMs: 4 * MIN, amountCents: 199 },
      { type: 'caller_hung_up', atMs: 6 * MIN },
    ])
    expect(snapshot.outcome).toBe('paid_session')
    expect(snapshot.paidCents).toBe(199)
  })

  it('records a transfer as its own outcome', () => {
    const { snapshot } = run([{ type: 'transfer_requested', atMs: MIN }])
    expect(snapshot.outcome).toBe('transferred')
  })

  it('refuses any event after the call has ended', () => {
    const { snapshot } = run([{ type: 'caller_hung_up', atMs: MIN }])
    expect(() => transition(snapshot, { type: 'tick', atMs: 2 * MIN })).toThrow(
      IllegalCallTransitionError
    )
  })
})

describe('rung 6 — drip requires a lawful basis', () => {
  it('is not recorded as drip without TCPA consent', () => {
    // A captured phone number with no consent is not pipeline, it is a liability.
    const { snapshot } = run([
      { type: 'free_window_elapsed', atMs: 3 * MIN },
      { type: 'caller_declined_paywall', atMs: 3 * MIN },
      { type: 'contact_captured', atMs: 3.5 * MIN },
    ])
    expect(finalize(snapshot, 4 * MIN, 'drip').snapshot.outcome).toBe('none')
  })

  it('is not recorded as drip with consent but no contact', () => {
    const { snapshot } = run([
      { type: 'free_window_elapsed', atMs: 3 * MIN },
      { type: 'caller_declined_paywall', atMs: 3 * MIN },
      { type: 'consent_captured', atMs: 3.5 * MIN, kind: 'tcpa_sms', granted: true },
    ])
    expect(finalize(snapshot, 4 * MIN, 'drip').snapshot.outcome).toBe('none')
  })

  it('is recorded as drip when both are present', () => {
    const { snapshot } = run([
      { type: 'free_window_elapsed', atMs: 3 * MIN },
      { type: 'caller_declined_paywall', atMs: 3 * MIN },
      { type: 'contact_captured', atMs: 3.4 * MIN },
      { type: 'consent_captured', atMs: 3.5 * MIN, kind: 'tcpa_sms', granted: true },
    ])
    expect(finalize(snapshot, 4 * MIN, 'drip').snapshot.outcome).toBe('drip')
  })

  it('treats a refused consent as refused, not as missing', () => {
    const { snapshot } = run([
      { type: 'free_window_elapsed', atMs: 3 * MIN },
      { type: 'caller_declined_paywall', atMs: 3 * MIN },
      { type: 'contact_captured', atMs: 3.4 * MIN },
      { type: 'consent_captured', atMs: 3.5 * MIN, kind: 'tcpa_sms', granted: false },
    ])
    expect(finalize(snapshot, 4 * MIN, 'drip').snapshot.outcome).toBe('none')
  })
})

describe('rung 5 — referral', () => {
  it('reads the disclosure and asks for acknowledgement before routing', () => {
    const { effects } = run([
      { type: 'referral_qualified', atMs: 2 * MIN, practiceArea: 'family', county: 'Wake' },
    ])
    const order = effects.map((e) => e.type)
    // The caller learns an attorney will contact them BEFORE their details go anywhere.
    expect(order.indexOf('request_consent')).toBeLessThan(order.indexOf('route_referral'))
    expect(effects).toContainEqual({ type: 'say', key: 'referral_disclosure' })
  })

  it('will not book a referral outcome without the disclosure acknowledged', () => {
    const { snapshot } = run([
      { type: 'referral_qualified', atMs: 2 * MIN, practiceArea: 'family', county: 'Wake' },
      { type: 'contact_captured', atMs: 2.1 * MIN },
      { type: 'consent_captured', atMs: 2.2 * MIN, kind: 'tcpa_sms', granted: true },
    ])
    expect(finalize(snapshot, 3 * MIN, 'referral').snapshot.outcome).toBe('drip')
  })

  it('books the referral once acknowledged', () => {
    const { snapshot } = run([
      { type: 'referral_qualified', atMs: 2 * MIN, practiceArea: 'family', county: 'Wake' },
      { type: 'consent_captured', atMs: 2.2 * MIN, kind: 'referral_disclosure', granted: true },
    ])
    expect(finalize(snapshot, 3 * MIN, 'referral').snapshot.outcome).toBe('referral')
  })
})

describe('rungs 3 and 4 — conversion', () => {
  it('drafts a case and sends the app link for a document', () => {
    const { effects } = run([
      { type: 'document_requested', atMs: 2 * MIN, templateKey: 'nc_debt_answer' },
    ])
    expect(effects).toContainEqual({ type: 'create_case_draft', caseTypeKey: 'nc_debt_answer' })
    expect(effects).toContainEqual({ type: 'send_app_link' })
  })

  it('drafts a case for a subscription so the caller never re-enters anything (#7)', () => {
    const { effects } = run([
      { type: 'subscription_requested', atMs: 2 * MIN, caseTypeKey: 'debt_defense' },
    ])
    expect(effects).toContainEqual({ type: 'create_case_draft', caseTypeKey: 'debt_defense' })
  })

  it('finalizes as subscription', () => {
    const { snapshot } = run([
      { type: 'subscription_requested', atMs: 2 * MIN, caseTypeKey: 'debt_defense' },
    ])
    expect(finalize(snapshot, 3 * MIN, 'subscription').snapshot.outcome).toBe('subscription')
  })
})

describe('illegal transitions', () => {
  it('refuses a paywall choice before the paywall was offered', () => {
    expect(() =>
      transition(answered(), { type: 'caller_chose_metered', atMs: MIN })
    ).toThrow(IllegalCallTransitionError)
  })

  it('refuses a recording announcement twice', () => {
    expect(() =>
      transition(answered(), { type: 'recording_announced', atMs: 3_000 })
    ).toThrow(IllegalCallTransitionError)
  })

  it('names the state and event so a driver bug is diagnosable', () => {
    try {
      transition(answered(), { type: 'caller_chose_metered', atMs: MIN })
    } catch (err) {
      expect((err as Error).message).toMatch(/free_window.*caller_chose_metered/)
    }
  })
})

describe('replay is deterministic', () => {
  it('reconstructs the same snapshot from the same events', () => {
    const events: CallEvent[] = [
      { type: 'call_answered', atMs: 0 },
      { type: 'recording_announced', atMs: 2_000 },
      { type: 'free_window_elapsed', atMs: 3 * MIN },
      { type: 'caller_chose_metered', atMs: 3 * MIN },
      { type: 'payment_settled', atMs: 4 * MIN, amountCents: 199 },
      { type: 'caller_hung_up', atMs: 7 * MIN },
    ]
    expect(replay(events).snapshot).toEqual(replay(events).snapshot)
    expect(replay(events).snapshot.outcome).toBe('paid_session')
    expect(replay(events).snapshot.billableMs).toBe(4 * MIN)
  })
})
