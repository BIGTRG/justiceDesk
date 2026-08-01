/**
 * Edge and failure-path coverage for the court calendar.
 */

import { addCourtDays, createCourtCalendar, northCarolinaCalendar, previousCourtDay } from './calendar.js'

const calendar = northCarolinaCalendar()

describe('holidaysInYear', () => {
  it('lists the year’s closures in date order', () => {
    const holidays = calendar.holidaysInYear(2026)
    const dates = holidays.map((h) => h.date)
    expect(dates).toEqual([...dates].sort())
    expect(holidays.every((h) => h.date.startsWith('2026'))).toBe(true)
    expect(holidays.length).toBeGreaterThanOrEqual(11)
  })

  it('includes a closure that spilled backward out of the following year', () => {
    // 2028-01-01 is a Saturday, so the courts close Friday 2027-12-31 — a 2027 date
    // produced by the 2028 generator. It must appear in the 2027 calendar.
    expect(calendar.holidaysInYear(2027).map((h) => h.date)).toContain('2027-12-31')
    expect(calendar.isCourtDay('2027-12-31')).toBe(false)
  })

  it('memoises without cross-contaminating years', () => {
    const a = calendar.holidaysInYear(2026)
    const b = calendar.holidaysInYear(2026)
    expect(b).toEqual(a)
    expect(calendar.holidaysInYear(2027).map((h) => h.date)).not.toEqual(a.map((h) => h.date))
  })
})

describe('failure paths', () => {
  const alwaysClosed = createCourtCalendar({
    jurisdictionKey: 'TEST',
    timeZone: 'UTC',
    verificationStatus: 'unverified',
    holidaysForYear: (y) =>
      Array.from({ length: 366 }, (_, i) => ({
        date: new Date(Date.UTC(y, 0, 1 + i)).toISOString().slice(0, 10),
        name: 'closed',
      })),
  })

  it('previousCourtDay throws rather than walking backward forever', () => {
    expect(() => previousCourtDay(alwaysClosed, '2026-03-02')).toThrow(/misconfigured/)
  })

  it('addCourtDays throws rather than spinning for a decade', () => {
    expect(() => addCourtDays(alwaysClosed, '2026-03-02', 1)).toThrow(/misconfigured/)
  })
})
