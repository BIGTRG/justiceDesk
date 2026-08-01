/**
 * The deadline calculator.
 *
 * Pure functions: (rule, case facts, calendar) → due date + an explanation trace.
 * No I/O, no clock reads except where a caller passes `today` in explicitly. This is the
 * single most consequential piece of logic in the product — a wrong date here is a
 * defaulted case — so it explains every step it takes and refuses to guess when a fact
 * it needs is missing.
 *
 * Order of operations, deliberately: count the base period → apply the service-of-process
 * extension → roll off closed days. The extension is part of the period, so a due date
 * that lands on a Saturday only after the +3 mailing days still rolls to Monday.
 */

import { addDays, compareDates, fromEpochUtc, toEpochUtc, type PlainDate } from '../dates.js'
import { addCourtDays, nextCourtDay, previousCourtDay, type CourtCalendar } from './calendar.js'
import {
  MissingAnchorError,
  type ComputationStep,
  type DeadlineComputation,
  type DeadlineContext,
  type DeadlineRule,
  type ServiceExtension,
} from './types.js'

/** Default reminder cadence from the spec: 14, 7, 2 and 1 days out. */
export const DEFAULT_REMINDER_OFFSETS_DAYS = [14, 7, 2, 1]

/** Add whole months, clamping to the last day of the target month (Jan 31 + 1mo = Feb 28/29). */
function addMonths(date: PlainDate, months: number): PlainDate {
  const d = new Date(toEpochUtc(date))
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const day = d.getUTCDate()
  const targetMonthLastDay = new Date(Date.UTC(y, m + months + 1, 0)).getUTCDate()
  return fromEpochUtc(Date.UTC(y, m + months, Math.min(day, targetMonthLastDay)))
}

/**
 * Count the base period from the anchor.
 *
 * The anchor day itself is not counted — N.C. Gen. Stat. § 1A-1, Rule 6(a) ("the day of
 * the act ... from which the designated period of time begins to run shall not be
 * included"). Counting from the day after is what `addDays(anchor, n)` already does.
 */
function applyOffset(
  calendar: CourtCalendar,
  anchor: PlainDate,
  rule: DeadlineRule
): { date: PlainDate; step: ComputationStep } {
  const sign = rule.direction === 'after' ? 1 : -1
  const { count, unit } = rule.offset
  const signed = sign * count

  // Rule 6(a) short-period exclusion: under 7 days, intermediate closed days don't count,
  // which is arithmetically identical to counting in court days.
  const shortPeriod =
    unit === 'calendar_days' &&
    rule.shortPeriodExcludesIntermediateNonCourtDays === true &&
    count < 7

  if (unit === 'court_days' || shortPeriod) {
    const date = addCourtDays(calendar, anchor, signed)
    return {
      date,
      step: {
        label: shortPeriod
          ? `Count ${count} days ${rule.direction} ${anchor}, skipping weekends and holidays`
          : `Count ${count} court days ${rule.direction} ${anchor}`,
        date,
        detail: shortPeriod
          ? 'Periods shorter than 7 days do not count weekends or holidays in between.'
          : undefined,
      },
    }
  }

  if (unit === 'months') {
    const date = addMonths(anchor, signed)
    return {
      date,
      step: { label: `Count ${count} months ${rule.direction} ${anchor}`, date },
    }
  }

  const date = addDays(anchor, signed)
  return {
    date,
    step: {
      label: `Count ${count} days ${rule.direction} ${anchor}`,
      date,
      detail: 'The starting day itself is not counted.',
    },
  }
}

function resolveServiceExtension(
  rule: DeadlineRule,
  context: DeadlineContext
): ServiceExtension | null {
  const ext = rule.serviceExtension
  if (!ext) return null
  const method = context.serviceMethod
  if (!method || method === 'unknown') return null
  return ext.appliesToMethods.includes(method) ? ext : null
}

export interface CalculateOptions {
  /**
   * When supplied, reminder dates already in the past are dropped. Callers that want the
   * full theoretical schedule (admin previews, tests) omit it.
   */
  today?: PlainDate
}

/**
 * Compute one deadline. Throws `MissingAnchorError` when the case does not yet have the
 * date the rule counts from — callers surface that as "we still need X" rather than
 * inventing a date.
 */
export function calculateDeadline(
  rule: DeadlineRule,
  context: DeadlineContext,
  calendar: CourtCalendar,
  options: CalculateOptions = {}
): DeadlineComputation {
  const warnings: string[] = []
  const steps: ComputationStep[] = []

  const anchorDate = context.anchors[rule.anchor]
  if (!anchorDate) throw new MissingAnchorError(rule.key, rule.anchor)

  steps.push({ label: `Start from the ${rule.anchor.replace(/_/g, ' ')}`, date: anchorDate })

  const base = applyOffset(calendar, anchorDate, rule)
  steps.push(base.step)
  let current = base.date

  const extension = resolveServiceExtension(rule, context)
  if (extension) {
    current = addDays(current, extension.days)
    steps.push({
      label: `Add ${extension.days} days because the papers were served by mail`,
      date: current,
      detail: extension.source.citation,
    })
  } else if (rule.serviceExtension && (!context.serviceMethod || context.serviceMethod === 'unknown')) {
    warnings.push(
      'We do not know how the papers were served. If they came by mail you may get extra days, so this date may be earlier than your real deadline.'
    )
  }

  if (rule.rollover !== 'none' && !calendar.isCourtDay(current)) {
    const closedReason = calendar.holidayName(current) ?? 'a weekend'
    const rolled =
      rule.rollover === 'next_court_day'
        ? nextCourtDay(calendar, current)
        : previousCourtDay(calendar, current)
    steps.push({
      label:
        rule.rollover === 'next_court_day'
          ? 'Move to the next day the court is open'
          : 'Move back to the last day the court is open',
      date: rolled,
      detail: `${current} is ${closedReason}.`,
    })
    current = rolled
  }

  if (calendar.verificationStatus === 'unverified') {
    warnings.push(
      'The court holiday calendar used for this date has not been verified by an attorney.'
    )
  }
  if (rule.verification.status === 'unverified') {
    warnings.push(`The rule behind this date (${rule.source.citation}) is pending attorney review.`)
  }

  const reminderOffsets = rule.reminderOffsetsDays ?? DEFAULT_REMINDER_OFFSETS_DAYS
  let reminderDates = reminderOffsets
    .map((d) => addDays(current, -d))
    .sort((a, b) => a.localeCompare(b))
  if (options.today) {
    const today = options.today
    reminderDates = reminderDates.filter((d) => compareDates(d, today) >= 0)
  }

  return {
    ruleKey: rule.key,
    title: rule.title,
    dueDate: current,
    steps,
    source: rule.source,
    serviceExtensionApplied: extension,
    verification: rule.verification,
    warnings,
    reminderDates,
    jurisdictional: rule.jurisdictional === true,
  }
}

export type DeadlineOutcome =
  | { ok: true; computation: DeadlineComputation }
  | { ok: false; ruleKey: string; missingAnchor: string; message: string }

/**
 * Compute a set of rules, keeping the ones that can be computed and reporting the ones
 * blocked on a missing fact. Used to build a case timeline where some dates are not yet
 * knowable — an unfiled case has no service date.
 */
export function calculateDeadlines(
  rules: DeadlineRule[],
  context: DeadlineContext,
  calendar: CourtCalendar,
  options: CalculateOptions = {}
): DeadlineOutcome[] {
  return rules.map((rule) => {
    try {
      return { ok: true, computation: calculateDeadline(rule, context, calendar, options) }
    } catch (err) {
      if (err instanceof MissingAnchorError) {
        return {
          ok: false,
          ruleKey: rule.key,
          missingAnchor: err.anchor,
          message: err.message,
        }
      }
      throw err
    }
  })
}

/** Whole days from `today` until `dueDate`. Negative once the deadline has passed. */
export function daysUntilDue(dueDate: PlainDate, today: PlainDate): number {
  return Math.round((toEpochUtc(dueDate) - toEpochUtc(today)) / 86_400_000)
}

export type DeadlineUrgency = 'overdue' | 'due_today' | 'critical' | 'soon' | 'upcoming'

/** Bucket a deadline for UI emphasis. Thresholds mirror the reminder cadence. */
export function urgencyOf(dueDate: PlainDate, today: PlainDate): DeadlineUrgency {
  const days = daysUntilDue(dueDate, today)
  if (days < 0) return 'overdue'
  if (days === 0) return 'due_today'
  if (days <= 2) return 'critical'
  if (days <= 7) return 'soon'
  return 'upcoming'
}
