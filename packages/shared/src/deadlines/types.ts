/**
 * The deadline rule language.
 *
 * Every deadline in the platform is data, not code — a rule object stored inside a
 * workflow definition. Adding a case type or a jurisdiction is a content change.
 *
 * Two invariants, both load-bearing for the compliance gate:
 *   1. Every rule carries a `source` naming the statute or court rule it came from.
 *   2. Every rule carries a `verification` status. Nothing computed from an `unverified`
 *      rule may be presented to a litigant as authoritative — the UI must surface the
 *      caveat and the API tags the response. See COMPLIANCE.md.
 */

import type { PlainDate } from '../dates.js'
import type { VerificationStatus } from './calendar.js'

export type { VerificationStatus }

/** How the defendant was served — drives the Rule 6(e) mailing extension. */
export type ServiceMethod =
  | 'personal'
  | 'registered_mail'
  | 'certified_mail'
  | 'first_class_mail'
  | 'sheriff'
  | 'publication'
  | 'unknown'

/**
 * Named dates a rule can count from. Anchors are supplied per-case from case facts
 * (OCR of the summons, the litigant's answers, or a filing event).
 */
export type AnchorKey =
  | 'service_date'
  | 'summons_issued_date'
  | 'complaint_filed_date'
  | 'judgment_date'
  | 'hearing_date'
  | 'stage_entered_date'
  | 'case_opened_date'
  | (string & {})

export interface LegalSource {
  /** Formal citation, e.g. "N.C. Gen. Stat. § 1A-1, Rule 12(a)(1)". */
  citation: string
  /** Short plain-language paraphrase shown to the litigant. Not a quotation. */
  summary: string
  url?: string
}

export interface Verification {
  status: VerificationStatus
  /** Set only when status is `attorney_verified`. */
  verifiedBy?: string
  verifiedAt?: string
  /** Anything a reviewing attorney needs to resolve before this can be verified. */
  openQuestions?: string[]
}

export type OffsetUnit = 'calendar_days' | 'court_days' | 'months'

export interface DeadlineOffset {
  count: number
  unit: OffsetUnit
}

export interface ServiceExtension {
  /** Service methods that trigger the extension. */
  appliesToMethods: ServiceMethod[]
  days: number
  source: LegalSource
}

export type Rollover = 'next_court_day' | 'previous_court_day' | 'none'

export interface DeadlineRule {
  key: string
  /** 6th-grade-reading-level description of what is due. */
  title: string
  description: string
  anchor: AnchorKey
  offset: DeadlineOffset
  direction: 'after' | 'before'
  /**
   * N.C. Gen. Stat. § 1A-1, Rule 6(a): when the prescribed period is shorter than seven
   * days, intermediate Saturdays, Sundays and legal holidays are not counted.
   */
  shortPeriodExcludesIntermediateNonCourtDays?: boolean
  /** N.C. Gen. Stat. § 1A-1, Rule 6(e): extra days when service was by mail. */
  serviceExtension?: ServiceExtension
  rollover: Rollover
  source: LegalSource
  verification: Verification
  /** Days-before-due at which to send reminders. Spec default: 14 / 7 / 2 / 1. */
  reminderOffsetsDays?: number[]
  /**
   * True when missing this deadline can end the case (default judgment, dismissal).
   * Drives UI emphasis and reminder aggressiveness.
   */
  jurisdictional?: boolean
}

/** Case facts a rule is evaluated against. */
export interface DeadlineContext {
  anchors: Partial<Record<AnchorKey, PlainDate>>
  serviceMethod?: ServiceMethod
}

/** One step of the computation, kept so the UI can show its work to the litigant. */
export interface ComputationStep {
  label: string
  date: PlainDate
  detail?: string
}

export interface DeadlineComputation {
  ruleKey: string
  title: string
  dueDate: PlainDate
  steps: ComputationStep[]
  source: LegalSource
  serviceExtensionApplied: ServiceExtension | null
  verification: Verification
  /**
   * Non-fatal problems. Any entry here means the result must not be presented as
   * authoritative — it is shown with a caveat and routed for human review.
   */
  warnings: string[]
  reminderDates: PlainDate[]
  jurisdictional: boolean
}

export class MissingAnchorError extends Error {
  readonly ruleKey: string
  readonly anchor: AnchorKey
  constructor(ruleKey: string, anchor: AnchorKey) {
    super(`Rule "${ruleKey}" needs the ${anchor} date, which this case does not have yet.`)
    this.name = 'MissingAnchorError'
    this.ruleKey = ruleKey
    this.anchor = anchor
  }
}
