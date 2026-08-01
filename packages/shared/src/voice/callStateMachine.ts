/**
 * The call state machine.
 *
 * Pure: `(snapshot, event) → { snapshot, effects }`. No I/O, no clock reads — every event
 * carries its own `atMs`, so a whole call can be replayed deterministically in a test.
 *
 * Three invariants it exists to hold, all of which are load-bearing:
 *
 *   1. **A call can never end without an outcome** (v2 non-negotiable #1). `end()` takes
 *      an outcome as a required argument; there is no path to `ended` that omits it.
 *   2. **The free window is never billable.** Billable time accrues only while metering
 *      runs, and metering cannot start before the caller has accepted the paywall.
 *   3. **No recording without an announcement** (#5). The machine will not enter the free
 *      window until the announcement has played.
 */

import {
  DEFAULT_PAYWALL_POLICY,
  IllegalCallTransitionError,
  type CallEffect,
  type CallEvent,
  type CallOutcome,
  type CallSnapshot,
  type CallTransition,
  type PaywallPolicy,
} from './types.js'

export function initialSnapshot(): CallSnapshot {
  return {
    state: 'greeting',
    outcome: null,
    elapsedMs: 0,
    billableMs: 0,
    meteringStartedMs: null,
    recordingAnnouncedAtMs: null,
    consents: {},
    contactCaptured: false,
    paidCents: 0,
  }
}

/** Billable ms accrued so far, including an in-flight metering run. */
export function billableMsAt(snapshot: CallSnapshot, atMs: number): number {
  if (snapshot.meteringStartedMs === null) return snapshot.billableMs
  return snapshot.billableMs + Math.max(0, atMs - snapshot.meteringStartedMs)
}

/**
 * What the caller owes for metered time.
 *
 * Rounds **down** to whole minutes. Rounding up would bill a caller 2 minutes for 61
 * seconds, which is the kind of thing that is technically disclosed and still reads as
 * sharp practice to someone already being sued over money. Partial minutes are free.
 */
export function meteredChargeCents(billableMs: number, perMinuteCents: number): number {
  return Math.floor(billableMs / 60_000) * perMinuteCents
}

function stopMetering(snapshot: CallSnapshot, atMs: number): CallSnapshot {
  if (snapshot.meteringStartedMs === null) return snapshot
  return {
    ...snapshot,
    billableMs: billableMsAt(snapshot, atMs),
    meteringStartedMs: null,
  }
}

/** Terminate with an explicit outcome. The only route to `ended`. */
function end(snapshot: CallSnapshot, atMs: number, outcome: CallOutcome): CallTransition {
  const stopped = stopMetering(snapshot, atMs)
  return {
    snapshot: { ...stopped, state: 'ended', outcome, elapsedMs: atMs },
    effects: [
      ...(snapshot.meteringStartedMs !== null ? [{ type: 'stop_metering' } as CallEffect] : []),
      { type: 'end_call', outcome },
    ],
  }
}

/**
 * Where a hangup lands on the ladder.
 *
 * Deliberately NOT "whatever we last offered". A caller who hangs up during the paywall
 * pitch has not bought a session; recording them as `paid_session` because they reached
 * that state would corrupt the north-star metric in the flattering direction.
 */
function outcomeOnHangup(snapshot: CallSnapshot): CallOutcome {
  if (snapshot.state === 'greeting' || snapshot.state === 'free_window') {
    // Hung up before ever being asked for anything.
    return snapshot.contactCaptured ? 'drip' : 'abandoned'
  }
  if (snapshot.paidCents > 0) return 'paid_session'
  if (snapshot.contactCaptured && snapshot.consents.tcpa_sms === true) return 'drip'
  return 'none'
}

export function transition(
  snapshot: CallSnapshot,
  event: CallEvent,
  policy: PaywallPolicy = DEFAULT_PAYWALL_POLICY
): CallTransition {
  const at = event.atMs
  const base = { ...snapshot, elapsedMs: Math.max(snapshot.elapsedMs, at) }

  // A hangup is legal from anywhere except a call already ended.
  if (event.type === 'caller_hung_up') {
    if (snapshot.state === 'ended') throw new IllegalCallTransitionError(snapshot.state, event.type)
    return end(base, at, outcomeOnHangup(base))
  }

  if (snapshot.state === 'ended') {
    throw new IllegalCallTransitionError(snapshot.state, event.type)
  }

  if (event.type === 'transfer_requested') {
    return end(base, at, 'transferred')
  }

  // Consent can be captured at any point in a live call.
  if (event.type === 'consent_captured') {
    return {
      snapshot: { ...base, consents: { ...base.consents, [event.kind]: event.granted } },
      effects: [],
    }
  }

  if (event.type === 'contact_captured') {
    return { snapshot: { ...base, contactCaptured: true }, effects: [] }
  }

  switch (snapshot.state) {
    // ------------------------------------------------------------------ greeting
    case 'greeting': {
      if (event.type === 'call_answered') {
        // #5: the announcement comes first, before anything is recorded.
        return { snapshot: base, effects: [{ type: 'say', key: 'recording_notice' }, { type: 'announce_recording' }] }
      }
      if (event.type === 'recording_announced') {
        return {
          snapshot: { ...base, state: 'free_window', recordingAnnouncedAtMs: at },
          effects: [
            { type: 'start_free_window', durationMs: policy.freeWindowMs },
            { type: 'say', key: 'free_window_intro' },
          ],
        }
      }
      if (event.type === 'tick') return { snapshot: base, effects: [] }
      throw new IllegalCallTransitionError(snapshot.state, event.type)
    }

    // ------------------------------------------------------------------ free window
    case 'free_window': {
      if (event.type === 'tick') {
        // The window expires on the clock, not on a scheduler firing. A missed timer
        // must not hand out unlimited free minutes.
        if (at >= policy.freeWindowMs + policy.graceMs) {
          return offerPaywall(base, at, policy)
        }
        return { snapshot: base, effects: [] }
      }
      if (event.type === 'free_window_elapsed') {
        return offerPaywall(base, at, policy)
      }
      // A caller can convert straight from the free window without ever seeing a paywall.
      if (event.type === 'document_requested') return requestDocument(base, at, event.templateKey)
      if (event.type === 'subscription_requested') return requestSubscription(base, at, event.caseTypeKey)
      if (event.type === 'referral_qualified') return routeReferral(base, at, event.practiceArea, event.county)
      throw new IllegalCallTransitionError(snapshot.state, event.type)
    }

    // ------------------------------------------------------------------ paywall
    case 'paywall_offer': {
      if (event.type === 'caller_chose_metered') {
        return {
          snapshot: { ...base, state: 'metered', meteringStartedMs: at },
          effects: [
            { type: 'send_payment_link', kind: 'metered', amountCents: policy.perMinuteCents },
            { type: 'start_metering', perMinuteCents: policy.perMinuteCents },
          ],
        }
      }
      if (event.type === 'caller_chose_flat_session') {
        return {
          snapshot: { ...base, state: 'flat_session' },
          effects: [
            { type: 'send_payment_link', kind: 'flat_session', amountCents: policy.flatSessionCents },
            { type: 'say', key: 'payment_link_sent' },
          ],
        }
      }
      if (event.type === 'caller_declined_paywall') {
        // Rung 6: no sale, but the call still becomes pipeline if they consent.
        return {
          snapshot: { ...base, state: 'outcome_capture' },
          effects: [
            { type: 'say', key: 'drip_offer' },
            { type: 'request_consent', kind: 'tcpa_sms' },
          ],
        }
      }
      if (event.type === 'document_requested') return requestDocument(base, at, event.templateKey)
      if (event.type === 'subscription_requested') return requestSubscription(base, at, event.caseTypeKey)
      if (event.type === 'referral_qualified') return routeReferral(base, at, event.practiceArea, event.county)
      if (event.type === 'tick') return { snapshot: base, effects: [] }
      throw new IllegalCallTransitionError(snapshot.state, event.type)
    }

    // ------------------------------------------------------------------ paid states
    case 'metered':
    case 'flat_session': {
      if (event.type === 'payment_settled') {
        return { snapshot: { ...base, paidCents: base.paidCents + event.amountCents }, effects: [] }
      }
      if (event.type === 'payment_failed') {
        // Stop the clock rather than accruing charges against a card that will not settle.
        return {
          snapshot: { ...stopMetering(base, at), state: 'outcome_capture' },
          effects: [
            { type: 'stop_metering' },
            { type: 'say', key: 'payment_failed' },
            { type: 'request_consent', kind: 'tcpa_sms' },
          ],
        }
      }
      if (event.type === 'document_requested') return requestDocument(base, at, event.templateKey)
      if (event.type === 'subscription_requested') return requestSubscription(base, at, event.caseTypeKey)
      if (event.type === 'referral_qualified') return routeReferral(base, at, event.practiceArea, event.county)
      if (event.type === 'tick') return { snapshot: base, effects: [] }
      throw new IllegalCallTransitionError(snapshot.state, event.type)
    }

    // ------------------------------------------------------------------ outcome capture
    case 'outcome_capture': {
      if (event.type === 'document_requested') return requestDocument(base, at, event.templateKey)
      if (event.type === 'subscription_requested') return requestSubscription(base, at, event.caseTypeKey)
      if (event.type === 'referral_qualified') return routeReferral(base, at, event.practiceArea, event.county)
      if (event.type === 'payment_settled') {
        return { snapshot: { ...base, paidCents: base.paidCents + event.amountCents }, effects: [] }
      }
      if (event.type === 'tick') return { snapshot: base, effects: [] }
      throw new IllegalCallTransitionError(snapshot.state, event.type)
    }

    default:
      throw new IllegalCallTransitionError(snapshot.state, event.type)
  }
}

// ---------------------------------------------------------------- shared transitions

function offerPaywall(snapshot: CallSnapshot, at: number, policy: PaywallPolicy): CallTransition {
  if (policy.waivePaywall?.(snapshot)) {
    // Waived: stay in the free window rather than charging. No default sets this.
    return { snapshot, effects: [] }
  }
  return {
    snapshot: { ...snapshot, state: 'paywall_offer' },
    effects: [
      { type: 'say', key: 'paywall_notice' },
      {
        type: 'offer_paywall',
        perMinuteCents: policy.perMinuteCents,
        flatSessionCents: policy.flatSessionCents,
      },
    ],
  }
}

/** Rung 3. */
function requestDocument(snapshot: CallSnapshot, at: number, templateKey: string): CallTransition {
  const stopped = stopMetering(snapshot, at)
  return {
    snapshot: { ...stopped, state: 'outcome_capture' },
    effects: [
      ...(snapshot.meteringStartedMs !== null ? [{ type: 'stop_metering' } as CallEffect] : []),
      { type: 'create_case_draft', caseTypeKey: templateKey },
      { type: 'send_app_link' },
    ],
  }
}

/** Rung 4. */
function requestSubscription(snapshot: CallSnapshot, at: number, caseTypeKey: string): CallTransition {
  const stopped = stopMetering(snapshot, at)
  return {
    snapshot: { ...stopped, state: 'outcome_capture' },
    effects: [
      ...(snapshot.meteringStartedMs !== null ? [{ type: 'stop_metering' } as CallEffect] : []),
      { type: 'create_case_draft', caseTypeKey },
      { type: 'send_app_link' },
    ],
  }
}

/**
 * Rung 5.
 *
 * The disclosure is requested before the referral is routed, not after. A caller should
 * know a participating attorney will contact them before their details are handed over.
 */
function routeReferral(
  snapshot: CallSnapshot,
  at: number,
  practiceArea: string,
  county: string
): CallTransition {
  const stopped = stopMetering(snapshot, at)
  return {
    snapshot: { ...stopped, state: 'outcome_capture' },
    effects: [
      ...(snapshot.meteringStartedMs !== null ? [{ type: 'stop_metering' } as CallEffect] : []),
      { type: 'say', key: 'referral_disclosure' },
      { type: 'request_consent', kind: 'referral_disclosure' },
      { type: 'route_referral', practiceArea, county },
    ],
  }
}

/**
 * Close a call that reached `outcome_capture`, choosing the outcome from what actually
 * happened. Callers pass the highest rung reached; this validates it against the snapshot
 * rather than trusting it.
 */
export function finalize(
  snapshot: CallSnapshot,
  atMs: number,
  reached: Exclude<CallOutcome, 'abandoned' | 'transferred'>
): CallTransition {
  // A referral outcome requires the disclosure to have been acknowledged (#2/#5 posture).
  if (reached === 'referral' && snapshot.consents.referral_disclosure !== true) {
    return end(snapshot, atMs, snapshot.contactCaptured ? 'drip' : 'none')
  }
  // Rung 6 requires both a contact and TCPA consent — otherwise there is no lawful drip.
  if (reached === 'drip' && !(snapshot.contactCaptured && snapshot.consents.tcpa_sms === true)) {
    return end(snapshot, atMs, 'none')
  }
  return end(snapshot, atMs, reached)
}

/** Replay a whole call. Used by tests and by the driver when reconstructing from events. */
export function replay(
  events: CallEvent[],
  policy: PaywallPolicy = DEFAULT_PAYWALL_POLICY
): { snapshot: CallSnapshot; effects: CallEffect[] } {
  let snapshot = initialSnapshot()
  const effects: CallEffect[] = []
  for (const event of events) {
    const result = transition(snapshot, event, policy)
    snapshot = result.snapshot
    effects.push(...result.effects)
  }
  return { snapshot, effects }
}
