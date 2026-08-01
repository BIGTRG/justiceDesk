/**
 * Lead qualification and billing eligibility.
 *
 * Pure functions. Whether a lead may be routed, and whether it may be billed, are two
 * separate questions with two separate gates — deliberately, because they fail for
 * different reasons and conflating them is how an unbillable lead gets billed.
 *
 * v2 non-negotiables enforced here:
 *   #2 the fee is resolved from practice area + county ONLY. `damagesBand` is accepted
 *      for routing and is structurally unable to reach the fee — `feeKeyFor` does not
 *      take it as an argument.
 *   #3 not-already-represented is a hard precondition of billing.
 *   #4 TCPA consent, plus the rung-5 referral disclosure, are preconditions of routing.
 */

export type DamagesBand = 'under_5k' | '5k_25k' | '25k_100k' | 'over_100k' | 'unknown'

export type PracticeArea =
  | 'debt_defense'
  | 'landlord_tenant'
  | 'small_claims'
  | 'family'
  | 'criminal'
  | 'personal_injury'
  | 'other'

export interface LeadQualification {
  practiceArea: PracticeArea
  county: string
  state: string
  /** The caller confirmed they do not already have a lawyer for this matter. */
  notAlreadyRepresented: boolean | null
  /** Express written consent for follow-up contact (#4). */
  consentTcpa: boolean
  /** The caller heard and acknowledged the referral disclosure (rung 5). */
  consentReferralDisclosure: boolean
  /** Routing signal only. */
  damagesBand?: DamagesBand
  /** Something a recipient can act on. A blank summary is not a lead. */
  summary: string
  contactPhone?: string | null
}

export type QualificationFailure =
  | 'no_representation_check'
  | 'already_represented'
  | 'no_tcpa_consent'
  | 'no_referral_disclosure'
  | 'no_contact'
  | 'no_summary'
  | 'unsupported_area'

export interface QualificationResult {
  qualified: boolean
  failures: QualificationFailure[]
  /** Plain-language reasons, for the admin queue. */
  reasons: string[]
}

const REASONS: Record<QualificationFailure, string> = {
  no_representation_check:
    'The caller was never asked whether they already have a lawyer. Required before a referral can be billed.',
  already_represented:
    'The caller already has a lawyer for this matter, so this is not a referable lead.',
  no_tcpa_consent:
    'No express consent to be contacted. Passing this on would be a TCPA problem for the recipient as well as for us.',
  no_referral_disclosure:
    'The caller did not hear or acknowledge the referral disclosure, so they do not know an attorney will contact them.',
  no_contact: 'No way for the recipient to reach the caller.',
  no_summary: 'No description of the matter. A recipient cannot act on an empty lead.',
  unsupported_area: 'No panel covers this practice area.',
}

const ROUTABLE_AREAS = new Set<PracticeArea>([
  'debt_defense',
  'landlord_tenant',
  'small_claims',
  'family',
  'criminal',
  'personal_injury',
])

/**
 * May this lead be routed to a recipient?
 *
 * Every failure is collected rather than short-circuiting, so an operator sees the whole
 * picture at once instead of fixing one problem to reveal the next.
 */
export function qualifyLead(lead: LeadQualification): QualificationResult {
  const failures: QualificationFailure[] = []

  if (lead.notAlreadyRepresented === null || lead.notAlreadyRepresented === undefined) {
    failures.push('no_representation_check')
  } else if (lead.notAlreadyRepresented === false) {
    failures.push('already_represented')
  }

  if (!lead.consentTcpa) failures.push('no_tcpa_consent')
  if (!lead.consentReferralDisclosure) failures.push('no_referral_disclosure')
  if (!lead.contactPhone?.trim()) failures.push('no_contact')
  if (!lead.summary?.trim()) failures.push('no_summary')
  if (!ROUTABLE_AREAS.has(lead.practiceArea)) failures.push('unsupported_area')

  return {
    qualified: failures.length === 0,
    failures,
    reasons: failures.map((f) => REASONS[f]),
  }
}

/**
 * The fee schedule key for a referral.
 *
 * Takes practice area and county. Nothing else. This signature is the enforcement point
 * for non-negotiable #2 — there is no parameter through which case value, damages band,
 * retention or an attorney's fee could influence the price, so a contingent fee cannot be
 * introduced here without changing the function signature and every call site.
 */
export function feeKeyFor(practiceArea: PracticeArea, county: string): string {
  return `referral.${practiceArea}.${county.trim().toLowerCase().replace(/\s+/g, '_')}`
}

/** The fallback used when no county-specific fee is published. */
export function fallbackFeeKeyFor(practiceArea: PracticeArea): string {
  return `referral.${practiceArea}.default`
}

export type BillingBlock =
  | 'not_qualified'
  | 'not_delivered'
  | 'no_published_fee'
  | 'already_charged'
  | 'disputed'

export interface BillingEligibility {
  billable: boolean
  blocks: BillingBlock[]
}

export interface BillingContext {
  qualification: QualificationResult
  delivered: boolean
  publishedFeeCents: number | null
  alreadyCharged: boolean
  disputeOpen: boolean
}

/**
 * May this lead be billed?
 *
 * Separate from qualification on purpose. A lead can be perfectly qualified and still
 * unbillable — nobody took it, no fee is published, it is already charged, or it is
 * under dispute. Charging on qualification alone would bill for leads that never
 * actually reached anyone.
 */
export function billingEligibility(context: BillingContext): BillingEligibility {
  const blocks: BillingBlock[] = []
  if (!context.qualification.qualified) blocks.push('not_qualified')
  if (!context.delivered) blocks.push('not_delivered')
  if (context.publishedFeeCents === null) blocks.push('no_published_fee')
  if (context.alreadyCharged) blocks.push('already_charged')
  if (context.disputeOpen) blocks.push('disputed')
  return { billable: blocks.length === 0, blocks }
}

/** v2 §3: speed-to-lead target is under 60 seconds. */
export const SPEED_TO_LEAD_TARGET_MS = 60_000

export function metSpeedTarget(qualifiedAt: Date, deliveredAt: Date): boolean {
  return deliveredAt.getTime() - qualifiedAt.getTime() <= SPEED_TO_LEAD_TARGET_MS
}

/**
 * The universal lead object.
 *
 * Shaped to the v2 spec so the cutover to the TRG Lead Exchange ingestion API is a config
 * change rather than a rewrite: the local table and the remote POST body serialise
 * identically.
 */
export interface UniversalLead {
  caseType: string
  practiceArea: PracticeArea
  county: string
  state: string
  summary: string
  qualificationAnswers: Record<string, unknown>
  consentRecords: Array<{ kind: string; granted: boolean; capturedAt: string }>
  sourceCallId: string | null
  damagesBand?: DamagesBand
}

/**
 * Contact details are NOT part of the universal lead body.
 *
 * They are released to a recipient on acceptance, not broadcast with the offer. A lead
 * fanned out to a panel would otherwise hand a caller's phone number to every firm that
 * looked at it and declined.
 */
export const LEAD_BODY_FORBIDDEN_FIELDS = [
  'contactPhone',
  'contactEmail',
  'contactName',
  'transcript',
] as const
