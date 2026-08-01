/**
 * Court calendars: which days count, and which days a deadline can land on.
 *
 * ⚠️ LEGAL CONTENT — NOT VERIFIED BY COUNSEL. The North Carolina holiday set below is
 * computed from the published State holiday schedule pattern, not transcribed from a
 * signed AOC calendar for a specific year. It is marked `unverified` and must be
 * reconciled against the official NC Judicial Branch holiday schedule, year by year,
 * before any deadline computed from it is shown to a litigant. See COMPLIANCE.md.
 */

import {
  addDays,
  dayOfWeek,
  easterSunday,
  isWeekend,
  lastWeekdayOfMonth,
  nthWeekdayOfMonth,
  year,
  type PlainDate,
} from '../dates.js'

export type VerificationStatus = 'unverified' | 'attorney_verified'

export interface CourtHoliday {
  date: PlainDate
  name: string
  /** The date the holiday nominally falls on, when observance was shifted off a weekend. */
  observedFor?: PlainDate
}

export interface CourtCalendar {
  jurisdictionKey: string
  timeZone: string
  verificationStatus: VerificationStatus
  isHoliday(date: PlainDate): boolean
  holidayName(date: PlainDate): string | null
  /** A day the clerk's office is open: not a weekend, not a holiday. */
  isCourtDay(date: PlainDate): boolean
  holidaysInYear(y: number): CourtHoliday[]
}

/**
 * Weekend observance for fixed-date holidays: Saturday → observed the preceding Friday,
 * Sunday → observed the following Monday.
 */
function observeFixed(date: PlainDate): PlainDate {
  const dow = dayOfWeek(date)
  if (dow === 6) return addDays(date, -1)
  if (dow === 0) return addDays(date, 1)
  return date
}

function iso(y: number, month: number, day: number): PlainDate {
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Walk in `step` direction until landing on a weekday not already spoken for. */
function nextFreeWeekday(from: PlainDate, step: 1 | -1, taken: Set<PlainDate>): PlainDate {
  let d = addDays(from, step)
  for (let i = 0; i < 14; i++) {
    if (!isWeekend(d) && !taken.has(d)) return d
    d = addDays(d, step)
  }
  throw new Error(`Could not find a free weekday from ${from}`)
}

/**
 * The three Christmas closure days.
 *
 * North Carolina closes for three days around Christmas, and which three shifts with the
 * weekday Christmas lands on. Encoding them as literal Dec 24/25/26 is wrong roughly half
 * the time and — worse — collides when a weekend shift lands two holidays on one date.
 *
 * Rule used here: observe Dec 25 (shifting off a weekend), then take the nearest free
 * weekday before it and the nearest free weekday after it. That reproduces the published
 * schedule for the years checked by hand (2025 → 24/25/26; 2026 → 24/25/28), but it is a
 * derived rule, not a transcription. UNVERIFIED — reconcile against the AOC schedule.
 */
function christmasClosureDays(y: number): CourtHoliday[] {
  const christmas = iso(y, 12, 25)
  const observed = observeFixed(christmas)
  const taken = new Set<PlainDate>([observed])

  const before = nextFreeWeekday(observed, -1, taken)
  taken.add(before)
  const after = nextFreeWeekday(observed, 1, taken)

  return [
    { date: before, name: 'Christmas Holiday', observedFor: iso(y, 12, 24) },
    {
      date: observed,
      name: 'Christmas Day',
      ...(observed !== christmas ? { observedFor: christmas } : {}),
    },
    { date: after, name: 'Christmas Holiday', observedFor: iso(y, 12, 26) },
  ]
}

/**
 * North Carolina state holidays observed by the courts.
 *
 * UNVERIFIED — see the file header. Every date here is derived from the published holiday
 * *pattern*, not transcribed from a signed schedule for a given year.
 */
export function northCarolinaHolidays(y: number): CourtHoliday[] {
  const goodFriday = addDays(easterSunday(y), -2)
  const thanksgiving = nthWeekdayOfMonth(y, 11, 4, 4)

  const fixed: Array<[PlainDate, string]> = [
    [iso(y, 1, 1), "New Year's Day"],
    [iso(y, 6, 19), 'Juneteenth'],
    [iso(y, 7, 4), 'Independence Day'],
    [iso(y, 11, 11), 'Veterans Day'],
  ]

  const holidays: CourtHoliday[] = fixed.map(([date, name]) => {
    const observed = observeFixed(date)
    return observed === date ? { date, name } : { date: observed, name, observedFor: date }
  })

  holidays.push(
    { date: nthWeekdayOfMonth(y, 1, 1, 3), name: 'Martin Luther King Jr. Birthday' },
    { date: goodFriday, name: 'Good Friday' },
    { date: lastWeekdayOfMonth(y, 5, 1), name: 'Memorial Day' },
    { date: nthWeekdayOfMonth(y, 9, 1, 1), name: 'Labor Day' },
    { date: thanksgiving, name: 'Thanksgiving Day' },
    { date: addDays(thanksgiving, 1), name: 'Day After Thanksgiving' },
    ...christmasClosureDays(y)
  )

  return holidays.sort((a, b) => a.date.localeCompare(b.date))
}

/** Build a calendar from a per-year holiday generator, memoized by year. */
export function createCourtCalendar(opts: {
  jurisdictionKey: string
  timeZone: string
  verificationStatus: VerificationStatus
  holidaysForYear: (y: number) => CourtHoliday[]
  /** Extra closures — storm days, county-specific closings — merged into the set. */
  additionalClosures?: CourtHoliday[]
}): CourtCalendar {
  const cache = new Map<number, Map<PlainDate, string>>()
  const extra = new Map<PlainDate, string>(
    (opts.additionalClosures ?? []).map((h) => [h.date, h.name])
  )

  function forYear(y: number): Map<PlainDate, string> {
    let m = cache.get(y)
    if (!m) {
      m = new Map<PlainDate, string>()
      // Generate the neighbouring years too, then keep only dates landing in `y`.
      //
      // Observance can push a holiday across a year boundary: New Year's Day 2028 falls
      // on a Saturday, so the courts close Friday 2027-12-31. Generating only year `y`
      // would file that closure under 2028 and leave 2027-12-31 looking like an open
      // court day — a deadline landing there would not roll, which is exactly the class
      // of off-by-one that defaults a case.
      for (const gy of [y - 1, y, y + 1]) {
        for (const h of opts.holidaysForYear(gy)) {
          // First name wins. Two holidays on one date is a generator bug; overwriting
          // would hide it, and the day is closed either way.
          if (year(h.date) === y && !m.has(h.date)) m.set(h.date, h.name)
        }
      }
      for (const [date, name] of extra) {
        if (year(date) === y) m.set(date, name)
      }
      cache.set(y, m)
    }
    return m
  }

  const holidayName = (date: PlainDate): string | null => forYear(year(date)).get(date) ?? null

  return {
    jurisdictionKey: opts.jurisdictionKey,
    timeZone: opts.timeZone,
    verificationStatus: opts.verificationStatus,
    holidayName,
    isHoliday: (date) => holidayName(date) !== null,
    isCourtDay: (date) => !isWeekend(date) && holidayName(date) === null,
    holidaysInYear: (y) =>
      [...forYear(y)].map(([date, name]) => ({ date, name })).sort((a, b) => a.date.localeCompare(b.date)),
  }
}

export const NC_TIME_ZONE = 'America/New_York'

export function northCarolinaCalendar(additionalClosures: CourtHoliday[] = []): CourtCalendar {
  return createCourtCalendar({
    jurisdictionKey: 'NC',
    timeZone: NC_TIME_ZONE,
    verificationStatus: 'unverified',
    holidaysForYear: northCarolinaHolidays,
    additionalClosures,
  })
}

/** Advance to the next day the clerk's office is open (returns `date` itself if it already is). */
export function nextCourtDay(calendar: CourtCalendar, date: PlainDate): PlainDate {
  let d = date
  // Bounded: a run of closed days longer than this means the calendar is misconfigured.
  for (let i = 0; i < 30; i++) {
    if (calendar.isCourtDay(d)) return d
    d = addDays(d, 1)
  }
  throw new Error(
    `No court day found within 30 days of ${date} for ${calendar.jurisdictionKey}; calendar is likely misconfigured`
  )
}

/** Step back to the previous open day (returns `date` itself if it already is one). */
export function previousCourtDay(calendar: CourtCalendar, date: PlainDate): PlainDate {
  let d = date
  for (let i = 0; i < 30; i++) {
    if (calendar.isCourtDay(d)) return d
    d = addDays(d, -1)
  }
  throw new Error(
    `No court day found within 30 days before ${date} for ${calendar.jurisdictionKey}; calendar is likely misconfigured`
  )
}

/** Add `count` court days, skipping weekends and holidays. `count` may be negative. */
export function addCourtDays(
  calendar: CourtCalendar,
  date: PlainDate,
  count: number
): PlainDate {
  const step = count >= 0 ? 1 : -1
  let remaining = Math.abs(count)
  let d = date
  let guard = 0
  while (remaining > 0) {
    d = addDays(d, step)
    if (calendar.isCourtDay(d)) remaining--
    if (++guard > 3650) {
      throw new Error(`addCourtDays exceeded 10 years walking from ${date}; calendar is misconfigured`)
    }
  }
  return d
}
