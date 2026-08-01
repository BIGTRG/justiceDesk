/**
 * Calendar-date primitives.
 *
 * Court deadlines are calendar dates, not instants. A filing due "October 3" is due
 * October 3 in the courthouse's county regardless of where the litigant's phone thinks
 * it is. Representing these as JS `Date` invites an off-by-one every time a value
 * crosses a timezone or a DST boundary, and an off-by-one here defaults a case.
 *
 * So: dates are ISO `YYYY-MM-DD` strings, and every operation goes through UTC math on
 * a midnight-UTC anchor. No local time is ever consulted.
 */

/** An ISO-8601 calendar date with no time or zone component: `YYYY-MM-DD`. */
export type PlainDate = string

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

export class InvalidDateError extends Error {
  constructor(value: string) {
    super(`Not a valid YYYY-MM-DD calendar date: ${JSON.stringify(value)}`)
    this.name = 'InvalidDateError'
  }
}

/** Parse a `PlainDate` to its midnight-UTC epoch milliseconds. Throws on malformed input. */
export function toEpochUtc(date: PlainDate): number {
  if (!ISO_DATE.test(date)) throw new InvalidDateError(date)
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const epoch = Date.UTC(y, m - 1, d)
  // Round-trip guards against real-looking but nonexistent dates (2025-02-30).
  const back = new Date(epoch)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    throw new InvalidDateError(date)
  }
  return epoch
}

export function fromEpochUtc(epoch: number): PlainDate {
  return new Date(epoch).toISOString().slice(0, 10)
}

export function isValidDate(value: unknown): value is PlainDate {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  try {
    toEpochUtc(value)
    return true
  } catch {
    return false
  }
}

const MS_PER_DAY = 86_400_000

export function addDays(date: PlainDate, days: number): PlainDate {
  return fromEpochUtc(toEpochUtc(date) + days * MS_PER_DAY)
}

/** Whole calendar days from `a` to `b`. Negative when `b` precedes `a`. */
export function daysBetween(a: PlainDate, b: PlainDate): number {
  return Math.round((toEpochUtc(b) - toEpochUtc(a)) / MS_PER_DAY)
}

export function compareDates(a: PlainDate, b: PlainDate): -1 | 0 | 1 {
  const diff = toEpochUtc(a) - toEpochUtc(b)
  return diff < 0 ? -1 : diff > 0 ? 1 : 0
}

export function maxDate(a: PlainDate, b: PlainDate): PlainDate {
  return compareDates(a, b) >= 0 ? a : b
}

/** 0 = Sunday .. 6 = Saturday. */
export function dayOfWeek(date: PlainDate): number {
  return new Date(toEpochUtc(date)).getUTCDay()
}

export function isWeekend(date: PlainDate): boolean {
  const d = dayOfWeek(date)
  return d === 0 || d === 6
}

export function year(date: PlainDate): number {
  return Number(date.slice(0, 4))
}

/**
 * Today as a calendar date in a named IANA zone. The only place local/zoned time enters
 * the system — everything downstream is zone-free. Courts are scheduled in their own
 * county's zone, so callers pass the jurisdiction's zone (`America/New_York` for NC).
 */
export function todayInZone(timeZone: string, now: Date = new Date()): PlainDate {
  // en-CA formats as YYYY-MM-DD, which is exactly PlainDate.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** Nth occurrence of a weekday in a month, e.g. 3rd Monday of January. */
export function nthWeekdayOfMonth(
  y: number,
  month1to12: number,
  weekday: number,
  nth: number
): PlainDate {
  const first = fromEpochUtc(Date.UTC(y, month1to12 - 1, 1))
  const firstDow = dayOfWeek(first)
  const offset = (weekday - firstDow + 7) % 7
  return addDays(first, offset + (nth - 1) * 7)
}

/** Last occurrence of a weekday in a month, e.g. last Monday of May. */
export function lastWeekdayOfMonth(y: number, month1to12: number, weekday: number): PlainDate {
  const lastDay = new Date(Date.UTC(y, month1to12, 0)).getUTCDate()
  const last = fromEpochUtc(Date.UTC(y, month1to12 - 1, lastDay))
  const back = (dayOfWeek(last) - weekday + 7) % 7
  return addDays(last, -back)
}

/**
 * Western (Gregorian) Easter Sunday — Meeus/Jones/Butcher algorithm.
 * Needed because Good Friday is a NC state holiday and is Easter-relative.
 */
export function easterSunday(y: number): PlainDate {
  const a = y % 19
  const b = Math.floor(y / 100)
  const c = y % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return fromEpochUtc(Date.UTC(y, month - 1, day))
}
