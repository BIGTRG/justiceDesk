import { northCarolinaCalendar } from './calendar.js'
import {
  calculateDeadline,
  calculateDeadlines,
  daysUntilDue,
  DEFAULT_REMINDER_OFFSETS_DAYS,
  urgencyOf,
} from './calculator.js'
import { MissingAnchorError, type DeadlineRule } from './types.js'

const calendar = northCarolinaCalendar()

const unverified = { status: 'unverified' as const }

/** N.C. Gen. Stat. § 1A-1, Rule 12(a)(1) — 30 days to answer a complaint. UNVERIFIED. */
const answerRule: DeadlineRule = {
  key: 'answer_due',
  title: 'File your written Answer',
  description: 'The court needs your written response to the lawsuit by this date.',
  anchor: 'service_date',
  offset: { count: 30, unit: 'calendar_days' },
  direction: 'after',
  rollover: 'next_court_day',
  jurisdictional: true,
  serviceExtension: {
    appliesToMethods: ['first_class_mail', 'certified_mail', 'registered_mail'],
    days: 3,
    source: {
      citation: 'N.C. Gen. Stat. § 1A-1, Rule 6(e)',
      summary: 'When papers are served by mail, three days are added to the response period.',
    },
  },
  source: {
    citation: 'N.C. Gen. Stat. § 1A-1, Rule 12(a)(1)',
    summary: 'A defendant generally has 30 days after being served to file a written answer.',
  },
  verification: unverified,
}

/** A short period, exercising the Rule 6(a) under-seven-days exclusion. UNVERIFIED. */
const shortRule: DeadlineRule = {
  key: 'short_notice',
  title: 'Short-notice step',
  description: 'A step with a period shorter than seven days.',
  anchor: 'service_date',
  offset: { count: 5, unit: 'calendar_days' },
  direction: 'after',
  shortPeriodExcludesIntermediateNonCourtDays: true,
  rollover: 'next_court_day',
  source: {
    citation: 'N.C. Gen. Stat. § 1A-1, Rule 6(a)',
    summary: 'Periods shorter than seven days do not count weekends or holidays in between.',
  },
  verification: unverified,
}

describe('calculateDeadline — base counting', () => {
  it('counts 30 calendar days from personal service and does not count the service day', () => {
    const result = calculateDeadline(
      answerRule,
      { anchors: { service_date: '2026-03-02' }, serviceMethod: 'personal' },
      calendar
    )
    expect(result.dueDate).toBe('2026-04-01')
    expect(result.serviceExtensionApplied).toBeNull()
    expect(result.jurisdictional).toBe(true)
  })

  it('shows its work so the litigant can check the date', () => {
    const result = calculateDeadline(
      answerRule,
      { anchors: { service_date: '2026-03-02' }, serviceMethod: 'personal' },
      calendar
    )
    expect(result.steps.map((s) => s.date)).toEqual(['2026-03-02', '2026-04-01'])
    expect(result.steps[0]?.label).toMatch(/start from the service date/i)
    expect(result.steps[1]?.detail).toMatch(/starting day itself is not counted/i)
  })

  it('carries the statutory source through to the result', () => {
    const result = calculateDeadline(
      answerRule,
      { anchors: { service_date: '2026-03-02' }, serviceMethod: 'personal' },
      calendar
    )
    expect(result.source.citation).toBe('N.C. Gen. Stat. § 1A-1, Rule 12(a)(1)')
  })
})

describe('calculateDeadline — service extension (Rule 6(e))', () => {
  it('adds three days when service was by mail', () => {
    const result = calculateDeadline(
      answerRule,
      { anchors: { service_date: '2026-03-02' }, serviceMethod: 'first_class_mail' },
      calendar
    )
    // 30 days lands 2026-04-01, +3 = Sat 2026-04-04, rolled to Mon 2026-04-06.
    expect(result.serviceExtensionApplied?.days).toBe(3)
    expect(result.dueDate).toBe('2026-04-06')
    expect(result.steps.map((s) => s.date)).toEqual([
      '2026-03-02',
      '2026-04-01',
      '2026-04-04',
      '2026-04-06',
    ])
  })

  it('does not add days for personal or sheriff service', () => {
    for (const method of ['personal', 'sheriff'] as const) {
      const result = calculateDeadline(
        answerRule,
        { anchors: { service_date: '2026-03-02' }, serviceMethod: method },
        calendar
      )
      expect(result.serviceExtensionApplied).toBeNull()
      expect(result.dueDate).toBe('2026-04-01')
    }
  })

  it('warns rather than guessing when the service method is unknown', () => {
    const result = calculateDeadline(
      answerRule,
      { anchors: { service_date: '2026-03-02' } },
      calendar
    )
    // Computes the earlier (safer) date and says so.
    expect(result.dueDate).toBe('2026-04-01')
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/do not know how the papers were served/i)])
    )
  })
})

describe('calculateDeadline — rollover', () => {
  it('rolls a weekend due date to the next court day', () => {
    const result = calculateDeadline(
      answerRule,
      { anchors: { service_date: '2026-03-05' }, serviceMethod: 'personal' },
      calendar
    )
    // 2026-03-05 + 30 = Sat 2026-04-04 → Mon 2026-04-06.
    expect(result.dueDate).toBe('2026-04-06')
  })

  it('rolls off a court holiday and says which one', () => {
    const result = calculateDeadline(
      answerRule,
      { anchors: { service_date: '2026-06-03' }, serviceMethod: 'personal' },
      calendar
    )
    // 2026-06-03 + 30 = Fri 2026-07-03, the observed Independence Day → Mon 2026-07-06.
    expect(result.dueDate).toBe('2026-07-06')
    const rollStep = result.steps.at(-1)
    expect(rollStep?.detail).toMatch(/Independence Day/)
  })

  it('leaves the date alone when rollover is "none"', () => {
    const noRoll: DeadlineRule = { ...answerRule, rollover: 'none' }
    const result = calculateDeadline(
      noRoll,
      { anchors: { service_date: '2026-03-05' }, serviceMethod: 'personal' },
      calendar
    )
    expect(result.dueDate).toBe('2026-04-04') // stays on the Saturday
  })

  it('supports rolling backward for "serve by" style deadlines', () => {
    const backward: DeadlineRule = {
      ...answerRule,
      key: 'serve_before_hearing',
      anchor: 'hearing_date',
      direction: 'before',
      offset: { count: 10, unit: 'calendar_days' },
      rollover: 'previous_court_day',
      serviceExtension: undefined,
    }
    const result = calculateDeadline(backward, { anchors: { hearing_date: '2026-03-18' } }, calendar)
    // 2026-03-18 - 10 = Sun 2026-03-08 → back to Fri 2026-03-06.
    expect(result.dueDate).toBe('2026-03-06')
  })
})

describe('calculateDeadline — Rule 6(a) short periods', () => {
  it('excludes intermediate weekends when the period is under seven days', () => {
    const result = calculateDeadline(shortRule, { anchors: { service_date: '2026-04-10' } }, calendar)
    // Friday + 5 court days = Fri 2026-04-17, not Wed 2026-04-15.
    expect(result.dueDate).toBe('2026-04-17')
    expect(result.steps[1]?.detail).toMatch(/shorter than 7 days/i)
  })

  it('counts straight calendar days once the period reaches seven', () => {
    const sevenDay: DeadlineRule = { ...shortRule, offset: { count: 7, unit: 'calendar_days' } }
    const result = calculateDeadline(sevenDay, { anchors: { service_date: '2026-04-10' } }, calendar)
    expect(result.dueDate).toBe('2026-04-17') // same date, but by calendar counting
    expect(result.steps[1]?.detail).toMatch(/starting day itself/i)
  })

  it('honours explicit court-day counting', () => {
    const courtDays: DeadlineRule = { ...shortRule, offset: { count: 10, unit: 'court_days' } }
    const result = calculateDeadline(courtDays, { anchors: { service_date: '2026-04-10' } }, calendar)
    expect(result.dueDate).toBe('2026-04-24')
  })
})

describe('calculateDeadline — month offsets', () => {
  const monthly: DeadlineRule = {
    ...answerRule,
    key: 'six_month_review',
    offset: { count: 1, unit: 'months' },
    serviceExtension: undefined,
  }

  it('clamps to the last day of a shorter month', () => {
    const result = calculateDeadline(monthly, { anchors: { service_date: '2026-01-31' } }, calendar)
    // Jan 31 + 1 month has no Feb 31; clamp to Feb 28 (2026 is not a leap year),
    // which is a Saturday, so it rolls to Monday.
    expect(result.dueDate).toBe('2026-03-02')
    expect(result.steps.map((s) => s.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-02'])
  })

  it('clamps into a leap February', () => {
    const noRoll: DeadlineRule = { ...monthly, rollover: 'none' }
    const result = calculateDeadline(noRoll, { anchors: { service_date: '2024-01-31' } }, calendar)
    expect(result.dueDate).toBe('2024-02-29')
  })
})

describe('calculateDeadline — missing facts', () => {
  it('throws MissingAnchorError instead of inventing a date', () => {
    expect(() => calculateDeadline(answerRule, { anchors: {} }, calendar)).toThrow(MissingAnchorError)
    try {
      calculateDeadline(answerRule, { anchors: {} }, calendar)
    } catch (err) {
      expect(err).toBeInstanceOf(MissingAnchorError)
      expect((err as MissingAnchorError).anchor).toBe('service_date')
      expect((err as MissingAnchorError).ruleKey).toBe('answer_due')
    }
  })

  it('reports the missing fact in batch mode without failing the whole set', () => {
    const outcomes = calculateDeadlines(
      [answerRule, { ...shortRule, anchor: 'judgment_date' }],
      { anchors: { service_date: '2026-03-02' }, serviceMethod: 'personal' },
      calendar
    )
    expect(outcomes[0]).toMatchObject({ ok: true })
    expect(outcomes[1]).toMatchObject({ ok: false, missingAnchor: 'judgment_date' })
  })
})

describe('calculateDeadline — verification warnings', () => {
  it('warns that both the rule and the holiday calendar are unverified', () => {
    const result = calculateDeadline(
      answerRule,
      { anchors: { service_date: '2026-03-02' }, serviceMethod: 'personal' },
      calendar
    )
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/holiday calendar .* has not been verified/i),
        expect.stringMatching(/pending attorney review/i),
      ])
    )
  })

  it('drops the rule warning once an attorney verifies it', () => {
    const verified: DeadlineRule = {
      ...answerRule,
      verification: {
        status: 'attorney_verified',
        verifiedBy: 'Reviewing Counsel',
        verifiedAt: '2026-07-01',
      },
    }
    const result = calculateDeadline(
      verified,
      { anchors: { service_date: '2026-03-02' }, serviceMethod: 'personal' },
      calendar
    )
    expect(result.warnings).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/pending attorney review/i)])
    )
  })
})

describe('reminder scheduling', () => {
  it('defaults to the 14/7/2/1-day cadence, in ascending date order', () => {
    const result = calculateDeadline(
      answerRule,
      { anchors: { service_date: '2026-03-02' }, serviceMethod: 'personal' },
      calendar
    )
    expect(DEFAULT_REMINDER_OFFSETS_DAYS).toEqual([14, 7, 2, 1])
    expect(result.reminderDates).toEqual([
      '2026-03-18', // 14 days out
      '2026-03-25', // 7
      '2026-03-30', // 2
      '2026-03-31', // 1
    ])
  })

  it('drops reminders already in the past when today is supplied', () => {
    const result = calculateDeadline(
      answerRule,
      { anchors: { service_date: '2026-03-02' }, serviceMethod: 'personal' },
      calendar,
      { today: '2026-03-26' }
    )
    expect(result.reminderDates).toEqual(['2026-03-30', '2026-03-31'])
  })

  it('honours a custom cadence', () => {
    const custom: DeadlineRule = { ...answerRule, reminderOffsetsDays: [3] }
    const result = calculateDeadline(
      custom,
      { anchors: { service_date: '2026-03-02' }, serviceMethod: 'personal' },
      calendar
    )
    expect(result.reminderDates).toEqual(['2026-03-29'])
  })
})

describe('urgency', () => {
  it('measures days remaining', () => {
    expect(daysUntilDue('2026-04-01', '2026-03-25')).toBe(7)
    expect(daysUntilDue('2026-03-25', '2026-04-01')).toBe(-7)
  })

  it.each([
    ['2026-03-24', 'overdue'],
    ['2026-03-25', 'due_today'],
    ['2026-03-26', 'critical'],
    ['2026-03-27', 'critical'],
    ['2026-03-28', 'soon'],
    ['2026-04-01', 'soon'],
    ['2026-04-02', 'upcoming'],
  ])('buckets a due date of %s as %s', (due, expected) => {
    expect(urgencyOf(due, '2026-03-25')).toBe(expected)
  })
})
