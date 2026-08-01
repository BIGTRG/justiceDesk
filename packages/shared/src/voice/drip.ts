/**
 * Drip eligibility — TCPA in code.
 *
 * v2 non-negotiable #4: express written consent before any outbound SMS or call, and a
 * one-tap opt-out honoured globally.
 *
 * Pure. Every input is supplied, including the clock, so the rules are testable without
 * a phone, a database, or a wait.
 *
 * The bias throughout is toward NOT sending. Every ambiguous case resolves to suppression,
 * because the cost of a wrongly-sent message (a TCPA claim, and a distressed person
 * getting an unwanted text about their lawsuit) is far higher than the cost of a missed
 * marketing touch.
 */

export type SuppressionReason =
  | 'no_consent'
  | 'opted_out'
  | 'consent_too_old'
  | 'quiet_hours'
  | 'frequency_cap'
  | 'campaign_not_live'
  | 'copy_not_approved'
  | 'already_sent'
  | 'not_due'

export interface DripCandidate {
  phoneE164: string
  consentGranted: boolean
  consentedAt: Date
  optedOut: boolean
  campaignLive: boolean
  copyApproved: boolean
  stepIndex: number
  stepOffsetHours: number
  enrolledAt: Date
  alreadySentSteps: number[]
  /** Sends to this number in the trailing window, across all campaigns. */
  sendsInWindow: number
  /** Local hour at the recipient, 0-23. */
  recipientLocalHour: number
}

export interface DripPolicy {
  /**
   * How long consent stays fresh.
   *
   * TCPA does not fix a number, and the right answer is counsel's — see HUMAN_REVIEW.md
   * D-1. 18 months is a conservative placeholder chosen so the system errs toward
   * re-asking rather than assuming.
   */
  consentMaxAgeMs: number
  /** No messages outside these local hours. */
  quietHoursStart: number
  quietHoursEnd: number
  /** Maximum messages per recipient in the trailing window. */
  maxSendsInWindow: number
}

export const DEFAULT_DRIP_POLICY: DripPolicy = {
  consentMaxAgeMs: 18 * 30 * 24 * 60 * 60 * 1000,
  // 8pm–8am local. Deliberately wider than the legal floor.
  quietHoursStart: 20,
  quietHoursEnd: 8,
  maxSendsInWindow: 4,
}

export interface DripDecision {
  send: boolean
  reasons: SuppressionReason[]
}

const EXPLANATIONS: Record<SuppressionReason, string> = {
  no_consent: 'No express written consent on file for this number.',
  opted_out: 'This number has opted out. Opt-out is global and permanent until they say otherwise.',
  consent_too_old: 'Consent is older than the freshness window and should be re-asked.',
  quiet_hours: 'It is outside permitted hours where the recipient is.',
  frequency_cap: 'This number has already received the maximum messages for the window.',
  campaign_not_live: 'The campaign is not published.',
  copy_not_approved: 'The message copy has not been approved by counsel.',
  already_sent: 'This step has already been sent to this recipient.',
  not_due: 'This step is not due yet.',
}

export function explainSuppression(reasons: SuppressionReason[]): string[] {
  return reasons.map((r) => EXPLANATIONS[r])
}

/**
 * May this message be sent?
 *
 * Collects every reason rather than short-circuiting, so an operator debugging a silent
 * campaign sees all of it at once.
 */
export function shouldSendDrip(
  candidate: DripCandidate,
  now: Date,
  policy: DripPolicy = DEFAULT_DRIP_POLICY
): DripDecision {
  const reasons: SuppressionReason[] = []

  // Consent and opt-out first: these are the ones that carry legal consequence.
  if (!candidate.consentGranted) reasons.push('no_consent')
  if (candidate.optedOut) reasons.push('opted_out')
  if (now.getTime() - candidate.consentedAt.getTime() > policy.consentMaxAgeMs) {
    reasons.push('consent_too_old')
  }

  if (!candidate.campaignLive) reasons.push('campaign_not_live')
  if (!candidate.copyApproved) reasons.push('copy_not_approved')
  if (candidate.alreadySentSteps.includes(candidate.stepIndex)) reasons.push('already_sent')

  const dueAt = candidate.enrolledAt.getTime() + candidate.stepOffsetHours * 3_600_000
  if (now.getTime() < dueAt) reasons.push('not_due')

  // Quiet hours wrap midnight (20:00 → 08:00).
  const hour = candidate.recipientLocalHour
  const inQuiet =
    policy.quietHoursStart > policy.quietHoursEnd
      ? hour >= policy.quietHoursStart || hour < policy.quietHoursEnd
      : hour >= policy.quietHoursStart && hour < policy.quietHoursEnd
  if (inQuiet) reasons.push('quiet_hours')

  if (candidate.sendsInWindow >= policy.maxSendsInWindow) reasons.push('frequency_cap')

  return { send: reasons.length === 0, reasons }
}

/**
 * Does an inbound message mean stop?
 *
 * Matched loosely on purpose. Someone typing "please stop texting me" has plainly opted
 * out, and requiring the exact keyword to honour it would be indefensible.
 */
const STOP_PATTERNS = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bcancel\b/i,
  /\bquit\b/i,
  /\bend\b/i,
  /\bopt\s*out\b/i,
  /\bremove me\b/i,
  /\bno more (texts|messages)\b/i,
  /\bleave me alone\b/i,
  /\bdon'?t (text|contact|message) me\b/i,
]

export function isOptOutMessage(body: string): boolean {
  const text = body.trim()
  if (!text) return false
  return STOP_PATTERNS.some((p) => p.test(text))
}

/** The footer every drip message carries. */
export const DRIP_OPT_OUT_FOOTER = 'Reply STOP to end these texts.'

export function hasOptOutFooter(body: string): boolean {
  return /reply\s+stop/i.test(body)
}
