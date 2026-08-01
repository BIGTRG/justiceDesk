/**
 * Transcript → case intake prefill.
 *
 * v2 non-negotiable #7: "Call transcript → case intake mapping must be lossless:
 * subscribing callers never repeat themselves."
 *
 * "Lossless" is treated here as something to *verify*, not assert. The mapper returns a
 * coverage report naming every fact the caller gave and where it landed — or why it did
 * not. A dropped fact is visible in the response and countable in a metric, instead of a
 * caller discovering it by being asked their hearing date for the second time.
 *
 * Pure: no I/O, no clock. Given the same call facts it produces the same case.
 */

import { isValidDate, type PlainDate } from '../dates.js'
import type { ServiceMethod } from '../deadlines/types.js'
import type { CaseMetadata } from '../domain.js'
import type { PartyRole } from '../workflow/types.js'

/** Facts gathered during a call, before they become a case. */
export interface CallFacts {
  detectedCaseType?: string | null
  county?: string | null
  role?: PartyRole | 'unknown' | null
  /** Dates the caller gave or that OCR read, keyed by deadline anchor. */
  anchors?: Record<string, string | null | undefined>
  serviceMethod?: ServiceMethod | null
  opposingParty?: string | null
  courtCaseNumber?: string | null
  amountClaimedCents?: number | null
  /** What the caller said the matter was, in their words. */
  narrative?: string | null
  /** Answers already elicited that map onto interview questions. */
  answers?: Record<string, unknown>
  callerName?: string | null
  callerPhone?: string | null
}

export type DropReason =
  | 'not_supplied'
  | 'invalid_date'
  | 'unknown_anchor'
  | 'unrecognised_service_method'
  | 'no_destination'

export interface DroppedFact {
  field: string
  reason: DropReason
  /** Why it matters, for the operator reading a coverage report. */
  detail: string
}

export interface PrefillCoverage {
  /** Fields the caller supplied that landed somewhere. */
  transferred: string[]
  /** Fields the caller supplied that did NOT land. Each one is a question they will be asked again. */
  dropped: DroppedFact[]
  /**
   * True when the caller supplied nothing that failed to transfer.
   *
   * Note it is NOT "we filled everything in" — a caller who never mentioned a hearing
   * date has not lost anything by not having one carried over.
   */
  lossless: boolean
}

export interface PrefillResult {
  metadata: CaseMetadata
  /** Seeds the guided interview so the caller is not re-asked (v2 §4, S7). */
  interviewAnswers: Record<string, unknown>
  role: PartyRole
  coverage: PrefillCoverage
}

/** Anchors the deadline engine understands. Anything else has nowhere to go. */
const KNOWN_ANCHORS = new Set([
  'service_date',
  'summons_issued_date',
  'complaint_filed_date',
  'judgment_date',
  'hearing_date',
  'case_opened_date',
])

const SERVICE_METHODS = new Set<ServiceMethod>([
  'personal',
  'registered_mail',
  'certified_mail',
  'first_class_mail',
  'sheriff',
  'publication',
  'unknown',
])

/**
 * Map call facts onto a case.
 *
 * Refuses to coerce. A date the caller gave that does not parse is DROPPED and reported,
 * never guessed into something plausible — a wrong service date silently becoming a
 * deadline anchor is the worst failure this whole pipeline could produce.
 */
export function prefillCaseFromCall(facts: CallFacts): PrefillResult {
  const transferred: string[] = []
  const dropped: DroppedFact[] = []

  const anchors: Record<string, PlainDate> = {}
  for (const [key, raw] of Object.entries(facts.anchors ?? {})) {
    if (raw === null || raw === undefined || raw === '') continue

    if (!KNOWN_ANCHORS.has(key)) {
      dropped.push({
        field: `anchors.${key}`,
        reason: 'unknown_anchor',
        detail: `"${key}" is not an anchor the deadline engine understands, so no date can be computed from it.`,
      })
      continue
    }
    if (!isValidDate(raw)) {
      dropped.push({
        field: `anchors.${key}`,
        reason: 'invalid_date',
        detail: `"${raw}" is not a valid calendar date. The caller will be asked for it again rather than given a guessed deadline.`,
      })
      continue
    }
    anchors[key] = raw
    transferred.push(`anchors.${key}`)
  }

  const metadata: CaseMetadata = {}
  if (Object.keys(anchors).length) metadata.anchors = anchors

  if (facts.serviceMethod) {
    if (SERVICE_METHODS.has(facts.serviceMethod)) {
      metadata.serviceMethod = facts.serviceMethod
      transferred.push('serviceMethod')
    } else {
      dropped.push({
        field: 'serviceMethod',
        reason: 'unrecognised_service_method',
        detail: `"${facts.serviceMethod}" is not a known service method. It affects whether three mailing days are added, so it is asked again rather than assumed.`,
      })
    }
  }

  if (facts.opposingParty?.trim()) {
    metadata.opposingParty = facts.opposingParty.trim().slice(0, 200)
    transferred.push('opposingParty')
  }
  if (typeof facts.amountClaimedCents === 'number' && Number.isFinite(facts.amountClaimedCents)) {
    metadata.amountClaimedCents = Math.max(0, Math.round(facts.amountClaimedCents))
    transferred.push('amountClaimedCents')
  }
  if (facts.narrative?.trim()) {
    // Stored as the caller's own words. Never presented as a legal characterisation.
    metadata.intakeSummary = facts.narrative.trim().slice(0, 4000)
    transferred.push('narrative')
  }
  if (facts.county?.trim()) {
    metadata.courtName = facts.county.trim().slice(0, 200)
    transferred.push('county')
  }

  // ---- interview seed ----
  const interviewAnswers: Record<string, unknown> = {}

  if (facts.callerName?.trim()) {
    interviewAnswers.full_name = facts.callerName.trim().slice(0, 120)
    transferred.push('callerName')
  }
  if (facts.courtCaseNumber?.trim()) {
    interviewAnswers.court_case_number = facts.courtCaseNumber.trim().slice(0, 60)
    transferred.push('courtCaseNumber')
  }
  if (facts.opposingParty?.trim()) {
    interviewAnswers.plaintiff_name = facts.opposingParty.trim().slice(0, 200)
  }
  if (typeof facts.amountClaimedCents === 'number' && Number.isFinite(facts.amountClaimedCents)) {
    interviewAnswers.amount_claimed = (facts.amountClaimedCents / 100).toFixed(2)
  }
  if (facts.narrative?.trim()) {
    interviewAnswers.additional_facts = facts.narrative.trim().slice(0, 2000)
  }

  for (const [key, value] of Object.entries(facts.answers ?? {})) {
    if (value === undefined || value === null || value === '') continue
    interviewAnswers[key] = value
    transferred.push(`answers.${key}`)
  }

  // The phone number is deliberately NOT copied into interview answers. It belongs to the
  // account, and a court filing should not carry it unless the litigant puts it there.
  if (facts.callerPhone?.trim()) {
    dropped.push({
      field: 'callerPhone',
      reason: 'no_destination',
      detail:
        'Held on the account, not copied into the document. A phone number appears on a filing only if the litigant chooses to put it there.',
    })
  }

  const role: PartyRole = facts.role === 'plaintiff' ? 'plaintiff' : 'defendant'

  return {
    metadata,
    interviewAnswers,
    role,
    coverage: {
      transferred,
      dropped,
      // callerPhone is an intentional destination-less field, not a loss.
      lossless: dropped.filter((d) => d.reason !== 'no_destination').length === 0,
    },
  }
}

/** One-line summary for logs and the call-economics dashboard. */
export function describeCoverage(coverage: PrefillCoverage): string {
  const lost = coverage.dropped.filter((d) => d.reason !== 'no_destination')
  return lost.length === 0
    ? `${coverage.transferred.length} fact(s) carried over; nothing lost`
    : `${coverage.transferred.length} carried over, ${lost.length} lost: ${lost.map((d) => d.field).join(', ')}`
}
