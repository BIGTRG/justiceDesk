import {
  addCourtDays,
  createCourtCalendar,
  nextCourtDay,
  northCarolinaCalendar,
  northCarolinaHolidays,
  previousCourtDay,
} from './calendar.js'

describe('northCarolinaHolidays', () => {
  const dates2026 = northCarolinaHolidays(2026).map((h) => h.date)

  it('includes the fixed and computed state holidays for 2026', () => {
    expect(dates2026).toEqual(expect.arrayContaining(['2026-01-01'])) // New Year's Day, Thu
    expect(dates2026).toEqual(expect.arrayContaining(['2026-01-19'])) // MLK, 3rd Mon
    expect(dates2026).toEqual(expect.arrayContaining(['2026-04-03'])) // Good Friday
    expect(dates2026).toEqual(expect.arrayContaining(['2026-05-25'])) // Memorial Day
    expect(dates2026).toEqual(expect.arrayContaining(['2026-06-19'])) // Juneteenth, Fri
    expect(dates2026).toEqual(expect.arrayContaining(['2026-09-07'])) // Labor Day
    expect(dates2026).toEqual(expect.arrayContaining(['2026-11-11'])) // Veterans Day, Wed
    expect(dates2026).toEqual(expect.arrayContaining(['2026-11-26', '2026-11-27'])) // Thanksgiving
  })

  it('shifts a Saturday holiday to the preceding Friday', () => {
    // 2026-07-04 is a Saturday; the courts close Friday 2026-07-03 instead.
    expect(dates2026).toContain('2026-07-03')
    expect(dates2026).not.toContain('2026-07-04')
  })

  it('shifts a Sunday holiday to the following Monday', () => {
    // 2027-07-04 is a Sunday.
    const dates2027 = northCarolinaHolidays(2027).map((h) => h.date)
    expect(dates2027).toContain('2027-07-05')
    expect(dates2027).not.toContain('2027-07-04')
  })

  it('records what an observed holiday stands in for', () => {
    const july = northCarolinaHolidays(2026).find((h) => h.date === '2026-07-03')
    expect(july).toMatchObject({ name: 'Independence Day', observedFor: '2026-07-04' })
  })

  describe('the three Christmas closure days', () => {
    it('uses Dec 24/25/26 when Christmas falls midweek', () => {
      // 2025-12-25 is a Thursday.
      const dec = northCarolinaHolidays(2025).filter((h) => h.date.startsWith('2025-12'))
      expect(dec.map((h) => h.date)).toEqual(['2025-12-24', '2025-12-25', '2025-12-26'])
    })

    it('skips the weekend when Christmas falls on a Friday', () => {
      // 2026-12-25 is a Friday, so the third day moves to Monday 2026-12-28
      // rather than colliding on Saturday.
      const dec = northCarolinaHolidays(2026).filter((h) => h.date.startsWith('2026-12'))
      expect(dec.map((h) => h.date)).toEqual(['2026-12-24', '2026-12-25', '2026-12-28'])
    })

    it('never produces two holidays on the same date', () => {
      for (let y = 2024; y <= 2035; y++) {
        const dates = northCarolinaHolidays(y).map((h) => h.date)
        expect(new Set(dates).size).toBe(dates.length)
      }
    })

    it('never places a closure day on a weekend', () => {
      const cal = northCarolinaCalendar()
      for (let y = 2024; y <= 2035; y++) {
        for (const h of northCarolinaHolidays(y)) {
          expect(cal.isCourtDay(h.date)).toBe(false)
          // A holiday landing on a weekend is wasted — it should have been shifted.
          const dow = new Date(`${h.date}T00:00:00Z`).getUTCDay()
          expect([0, 6]).not.toContain(dow)
        }
      }
    })
  })
})

describe('court calendar', () => {
  const calendar = northCarolinaCalendar()

  it('marks weekends and holidays closed, weekdays open', () => {
    expect(calendar.isCourtDay('2026-03-02')).toBe(true) // Monday
    expect(calendar.isCourtDay('2026-03-07')).toBe(false) // Saturday
    expect(calendar.isCourtDay('2026-03-08')).toBe(false) // Sunday
    expect(calendar.isCourtDay('2026-07-03')).toBe(false) // observed Independence Day
  })

  it('names the holiday that closes a day', () => {
    expect(calendar.holidayName('2026-11-26')).toBe('Thanksgiving Day')
    expect(calendar.holidayName('2026-03-02')).toBeNull()
  })

  it('is flagged unverified until counsel signs off on the schedule', () => {
    expect(calendar.verificationStatus).toBe('unverified')
  })

  it('accepts additional county closures', () => {
    const withClosure = northCarolinaCalendar([{ date: '2026-03-02', name: 'Hurricane closure' }])
    expect(withClosure.isCourtDay('2026-03-02')).toBe(false)
    expect(withClosure.holidayName('2026-03-02')).toBe('Hurricane closure')
    // The base calendar is unaffected.
    expect(calendar.isCourtDay('2026-03-02')).toBe(true)
  })
})

describe('nextCourtDay / previousCourtDay', () => {
  const calendar = northCarolinaCalendar()

  it('returns the same day when the court is already open', () => {
    expect(nextCourtDay(calendar, '2026-03-02')).toBe('2026-03-02')
    expect(previousCourtDay(calendar, '2026-03-02')).toBe('2026-03-02')
  })

  it('rolls a Saturday forward to Monday', () => {
    expect(nextCourtDay(calendar, '2026-03-07')).toBe('2026-03-09')
  })

  it('rolls back a Sunday to Friday', () => {
    expect(previousCourtDay(calendar, '2026-03-08')).toBe('2026-03-06')
  })

  it('skips a holiday adjacent to a weekend', () => {
    // Sat 2026-07-04 → Sun 5th → Mon 6th, but Fri 3rd is the observed holiday,
    // so going backward from the 4th lands on Thursday the 2nd.
    expect(nextCourtDay(calendar, '2026-07-04')).toBe('2026-07-06')
    expect(previousCourtDay(calendar, '2026-07-04')).toBe('2026-07-02')
  })

  it('walks the whole Thanksgiving block', () => {
    // Thu 11/26 and Fri 11/27 closed, then the weekend.
    expect(nextCourtDay(calendar, '2026-11-26')).toBe('2026-11-30')
  })

  it('throws rather than looping forever on a pathological calendar', () => {
    const alwaysClosed = createCourtCalendar({
      jurisdictionKey: 'TEST',
      timeZone: 'UTC',
      verificationStatus: 'unverified',
      holidaysForYear: (y) =>
        Array.from({ length: 366 }, (_, i) => {
          const d = new Date(Date.UTC(y, 0, 1 + i)).toISOString().slice(0, 10)
          return { date: d, name: 'closed' }
        }),
    })
    expect(() => nextCourtDay(alwaysClosed, '2026-03-02')).toThrow(/misconfigured/)
  })
})

describe('addCourtDays', () => {
  const calendar = northCarolinaCalendar()

  it('counts forward skipping weekends', () => {
    // Fri 2026-04-10 + 1 court day = Mon 2026-04-13.
    expect(addCourtDays(calendar, '2026-04-10', 1)).toBe('2026-04-13')
    expect(addCourtDays(calendar, '2026-04-10', 5)).toBe('2026-04-17')
  })

  it('counts backward', () => {
    expect(addCourtDays(calendar, '2026-04-13', -1)).toBe('2026-04-10')
  })

  it('returns the same date for a zero offset even on a closed day', () => {
    expect(addCourtDays(calendar, '2026-03-07', 0)).toBe('2026-03-07')
  })

  it('skips holidays as well as weekends', () => {
    // Wed 2026-07-01 + 3 court days: Thu 2nd, (Fri 3rd closed), Mon 6th, Tue 7th.
    expect(addCourtDays(calendar, '2026-07-01', 3)).toBe('2026-07-07')
  })
})
