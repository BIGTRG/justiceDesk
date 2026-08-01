import {
  addDays,
  compareDates,
  daysBetween,
  dayOfWeek,
  easterSunday,
  fromEpochUtc,
  InvalidDateError,
  isValidDate,
  isWeekend,
  lastWeekdayOfMonth,
  maxDate,
  nthWeekdayOfMonth,
  todayInZone,
  toEpochUtc,
} from './dates.js'

describe('PlainDate parsing', () => {
  it('accepts a well-formed calendar date', () => {
    expect(isValidDate('2026-03-02')).toBe(true)
    expect(fromEpochUtc(toEpochUtc('2026-03-02'))).toBe('2026-03-02')
  })

  it.each(['2026-3-2', '03-02-2026', '2026-13-01', '2026-00-10', '', 'today', '2026-03-32'])(
    'rejects %p',
    (bad) => {
      expect(isValidDate(bad)).toBe(false)
      expect(() => toEpochUtc(bad)).toThrow(InvalidDateError)
    }
  )

  it('rejects dates that look valid but do not exist', () => {
    // 2026 is not a leap year, so Feb 29 must not silently roll to Mar 1.
    expect(isValidDate('2026-02-29')).toBe(false)
    expect(isValidDate('2024-02-29')).toBe(true)
    expect(isValidDate('2026-04-31')).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isValidDate(20260302)).toBe(false)
    expect(isValidDate(null)).toBe(false)
    expect(isValidDate(new Date())).toBe(false)
  })
})

describe('date arithmetic', () => {
  it('adds and subtracts days across month and year boundaries', () => {
    expect(addDays('2026-03-02', 30)).toBe('2026-04-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
  })

  it('is immune to daylight-saving transitions', () => {
    // US DST springs forward 2026-03-08 and falls back 2026-11-01. A Date-based
    // implementation drifts by an hour here and can land a day early or late.
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08')
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
    expect(daysBetween('2026-03-01', '2026-03-31')).toBe(30)
    expect(addDays('2026-10-31', 2)).toBe('2026-11-02')
    expect(daysBetween('2026-10-25', '2026-11-05')).toBe(11)
  })

  it('measures signed distance between dates', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30)
    expect(daysBetween('2026-01-31', '2026-01-01')).toBe(-30)
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0)
  })

  it('compares and picks the later date', () => {
    expect(compareDates('2026-01-01', '2026-01-02')).toBe(-1)
    expect(compareDates('2026-01-02', '2026-01-01')).toBe(1)
    expect(compareDates('2026-01-01', '2026-01-01')).toBe(0)
    expect(maxDate('2026-01-01', '2026-06-01')).toBe('2026-06-01')
    expect(maxDate('2026-06-01', '2026-01-01')).toBe('2026-06-01')
  })
})

describe('weekday helpers', () => {
  it('identifies weekdays correctly', () => {
    expect(dayOfWeek('2026-01-01')).toBe(4) // Thursday
    expect(isWeekend('2026-07-04')).toBe(true) // Saturday
    expect(isWeekend('2026-07-05')).toBe(true) // Sunday
    expect(isWeekend('2026-07-06')).toBe(false) // Monday
  })

  it('finds the nth weekday of a month', () => {
    // Third Monday of January 2026 = MLK Day.
    expect(nthWeekdayOfMonth(2026, 1, 1, 3)).toBe('2026-01-19')
    // First Monday of September 2026 = Labor Day.
    expect(nthWeekdayOfMonth(2026, 9, 1, 1)).toBe('2026-09-07')
    // Fourth Thursday of November 2026 = Thanksgiving.
    expect(nthWeekdayOfMonth(2026, 11, 4, 4)).toBe('2026-11-26')
  })

  it('finds the last weekday of a month', () => {
    // Last Monday of May 2026 = Memorial Day.
    expect(lastWeekdayOfMonth(2026, 5, 1)).toBe('2026-05-25')
    expect(lastWeekdayOfMonth(2026, 2, 6)).toBe('2026-02-28') // last Saturday of Feb
  })
})

describe('easterSunday', () => {
  it('matches known Gregorian Easter dates', () => {
    expect(easterSunday(2024)).toBe('2024-03-31')
    expect(easterSunday(2025)).toBe('2025-04-20')
    expect(easterSunday(2026)).toBe('2026-04-05')
    expect(easterSunday(2027)).toBe('2027-03-28')
    expect(easterSunday(2030)).toBe('2030-04-21')
  })
})

describe('todayInZone', () => {
  it('returns the calendar date in the court’s zone, not the server’s', () => {
    // 03:30 UTC on Mar 3 is still Mar 2 in North Carolina. A litigant filing at
    // 10:30pm must not be told the deadline moved.
    const instant = new Date('2026-03-03T03:30:00Z')
    expect(todayInZone('America/New_York', instant)).toBe('2026-03-02')
    expect(todayInZone('UTC', instant)).toBe('2026-03-03')
  })
})
