/**
 * Call state machine types.
 *
 * v2 §3: FREE_WINDOW → PAYWALL_OFFER → (METERED | FLAT_SESSION) → OUTCOME.
 *
 * Modelled as a pure reducer for the same reason the case engine is: this decides when a
 * person in distress gets cut off and what they are charged, and that logic should be
 * exercisable without a phone line, a Twilio account, or a card.
 */

export type CallState =
  | 'greeting'
  | 'free_window'
  | 'paywall_offer'
  | 'metered'
  | 'flat_session'
  | 'outcome_capture'
  | 'ended'

/**
 * The six rungs of the ladder plus two terminal realities the spec's list omits.
 *
 * `abandoned` and `transferred` exist because non-negotiable #1 requires EVERY call to
 * carry an outcome. A caller who hangs up at 40 seconds has not chosen `none` — folding
 * them into it would quietly inflate the "we captured nothing" bucket with people who
 * never got the chance, and the free-window abandonment metric would lose its meaning.
 */
export type CallOutcome =
  | 'paid_session'
  | 'document'
  | 'subscription'
  | 'referral'
  | 'drip'
  | 'none'
  | 'abandoned'
  | 'transferred'

export type ConsentKind = 'recording' | 'tcpa_sms' | 'tcpa_call' | 'referral_disclosure'

export type CallEvent =
  | { type: 'call_answered'; atMs: number }
  | { type: 'recording_announced'; atMs: number }
  | { type: 'free_window_elapsed'; atMs: number }
  | { type: 'caller_chose_metered'; atMs: number }
  | { type: 'caller_chose_flat_session'; atMs: number }
  | { type: 'caller_declined_paywall'; atMs: number }
  | { type: 'payment_settled'; atMs: number; amountCents: number }
  | { type: 'payment_failed'; atMs: number; reason: string }
  | { type: 'document_requested'; atMs: number; templateKey: string }
  | { type: 'subscription_requested'; atMs: number; caseTypeKey: string }
  | { type: 'referral_qualified'; atMs: number; practiceArea: string; county: string }
  | { type: 'consent_captured'; atMs: number; kind: ConsentKind; granted: boolean }
  | { type: 'contact_captured'; atMs: number }
  | { type: 'transfer_requested'; atMs: number }
  | { type: 'caller_hung_up'; atMs: number }
  | { type: 'tick'; atMs: number }

/**
 * Side effects the driver performs. The machine never does I/O — it says what should
 * happen and svc-voice carries it out, which is what makes the whole thing testable.
 */
export type CallEffect =
  | { type: 'announce_recording' }
  | { type: 'start_free_window'; durationMs: number }
  | { type: 'offer_paywall'; perMinuteCents: number; flatSessionCents: number }
  | { type: 'send_payment_link'; kind: 'metered' | 'flat_session' | 'document'; amountCents: number }
  | { type: 'start_metering'; perMinuteCents: number }
  | { type: 'stop_metering' }
  | { type: 'request_consent'; kind: ConsentKind }
  | { type: 'create_case_draft'; caseTypeKey: string }
  | { type: 'route_referral'; practiceArea: string; county: string }
  | { type: 'send_app_link' }
  | { type: 'enroll_in_drip' }
  | { type: 'say'; key: SpokenLine }
  | { type: 'end_call'; outcome: CallOutcome }

/**
 * Spoken lines are referenced by key, never by literal text.
 *
 * Every one of these is read to a frightened person at speed, and four of them carry
 * legal weight (recording announcement, paywall notice, referral disclosure, TCPA
 * consent). The wording is counsel's to write — see HUMAN_REVIEW.md L-2 — so the machine
 * refers to slots and the script table supplies the words.
 */
export type SpokenLine =
  | 'recording_notice'
  | 'free_window_intro'
  | 'paywall_notice'
  | 'payment_link_sent'
  | 'payment_failed'
  | 'referral_disclosure'
  | 'tcpa_consent_request'
  | 'drip_offer'
  | 'goodbye'
  | 'goodbye_no_capture'

export interface CallSnapshot {
  state: CallState
  outcome: CallOutcome | null
  /** Wall-clock ms since the call was answered. */
  elapsedMs: number
  /** Ms the caller is billable for. The free window is never billable. */
  billableMs: number
  /** When metering started, if it is running. */
  meteringStartedMs: number | null
  recordingAnnouncedAtMs: number | null
  consents: Partial<Record<ConsentKind, boolean>>
  /** True once we have something to remarket to (rung 6). */
  contactCaptured: boolean
  paidCents: number
}

export interface PaywallPolicy {
  /** v2 rung 1: "First 3 minutes free." */
  freeWindowMs: number
  perMinuteCents: number
  flatSessionCents: number
  /**
   * Grace after the free window before the paywall is offered, so the caller is not cut
   * off mid-sentence. Does not extend billable time.
   */
  graceMs: number
  /**
   * Escape hatch for waiving the paywall — e.g. a hearing tomorrow, or a caller in
   * crisis. Defaults to never waiving, which is the spec as written.
   *
   * The hook exists because the policy question is real and unanswered: the spec's
   * "no call ends without a revenue event" applied to someone whose hearing is tomorrow
   * is a decision somebody should make deliberately rather than discover in production.
   * See HUMAN_REVIEW.md V-1. No default behaviour is invented here.
   */
  waivePaywall?: (snapshot: CallSnapshot) => boolean
}

export const DEFAULT_PAYWALL_POLICY: PaywallPolicy = {
  freeWindowMs: 3 * 60 * 1000,
  perMinuteCents: 199,
  flatSessionCents: 900,
  graceMs: 15 * 1000,
}

export interface CallTransition {
  snapshot: CallSnapshot
  effects: CallEffect[]
}

export class IllegalCallTransitionError extends Error {
  constructor(state: CallState, event: CallEvent['type']) {
    super(`A call in state "${state}" cannot handle "${event}".`)
    this.name = 'IllegalCallTransitionError'
  }
}
