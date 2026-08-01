import {
  composeMessage,
  offsetsToRecord,
  reminderFor,
  runReminderPass,
  type DueDeadline,
  type SmsSender,
} from './reminders.js'

function deadline(over: Partial<DueDeadline> = {}): DueDeadline {
  return {
    id: 'd1',
    caseId: 'c1',
    title: 'File your written Answer',
    dueDate: '2026-04-01',
    jurisdictional: true,
    reminderSchedule: { offsetsDays: [14, 7, 2, 1], sentOffsets: [] },
    phone: '+19195550123',
    timeZone: 'America/New_York',
    ...over,
  }
}

describe('reminderFor — when a reminder is due', () => {
  it('sends nothing before the first offset', () => {
    expect(reminderFor(deadline(), '2026-03-17')).toBeNull() // 15 days out
  })

  it('sends the 14-day notice on the day it comes due', () => {
    expect(reminderFor(deadline(), '2026-03-18')).toMatchObject({ offsetDays: 14, daysRemaining: 14 })
  })

  it('sends the 1-day notice the day before', () => {
    expect(reminderFor(deadline(), '2026-03-31')).toMatchObject({ offsetDays: 1, daysRemaining: 1 })
  })

  it('sends on the due date itself', () => {
    expect(reminderFor(deadline(), '2026-04-01')).toMatchObject({ offsetDays: 1, daysRemaining: 0 })
  })

  it('stops once the deadline has passed', () => {
    // A "your deadline is due in -3 days" text is worse than silence.
    expect(reminderFor(deadline(), '2026-04-04')).toBeNull()
  })

  it('sends nothing when there is no phone number', () => {
    expect(reminderFor(deadline({ phone: null }), '2026-03-18')).toBeNull()
  })
})

describe('reminderFor — no duplicates', () => {
  it('does not resend an offset already sent', () => {
    const d = deadline({ reminderSchedule: { offsetsDays: [14, 7, 2, 1], sentOffsets: [14] } })
    expect(reminderFor(d, '2026-03-18')).toBeNull()
  })

  it('moves on to the next offset once the previous one is spent', () => {
    const d = deadline({ reminderSchedule: { offsetsDays: [14, 7, 2, 1], sentOffsets: [14] } })
    expect(reminderFor(d, '2026-03-25')).toMatchObject({ offsetDays: 7 })
  })

  it('goes quiet once every offset is spent', () => {
    const d = deadline({ reminderSchedule: { offsetsDays: [14, 7, 2, 1], sentOffsets: [14, 7, 2, 1] } })
    expect(reminderFor(d, '2026-03-31')).toBeNull()
  })
})

describe('reminderFor — catching up after downtime', () => {
  it('still sends when the worker missed the exact day', () => {
    // Down over a weekend: the 7-day notice was never sent and it is now 5 days out.
    // Silence here means the litigant simply never got warned.
    const result = reminderFor(deadline(), '2026-03-27')
    expect(result).not.toBeNull()
    expect(result!.daysRemaining).toBe(5)
  })

  it('sends only the most urgent outstanding notice, not a burst', () => {
    // Down for three weeks: 14, 7 and 2 are all outstanding at 2 days out. Firing three
    // texts in one minute reads as a malfunction.
    const result = reminderFor(deadline(), '2026-03-30')
    expect(result!.offsetDays).toBe(2)
  })

  it('marks the superseded offsets as spent so they never fire late', () => {
    expect(offsetsToRecord(deadline(), 2)).toEqual([14, 7, 2])
  })

  it('keeps offsets already recorded when marking more', () => {
    const d = deadline({ reminderSchedule: { offsetsDays: [14, 7, 2, 1], sentOffsets: [14] } })
    expect(offsetsToRecord(d, 1)).toEqual([14, 7, 2, 1])
  })
})

describe('composeMessage — safe on a lock screen', () => {
  it('names the step and the date without identifying the case', () => {
    const message = composeMessage(deadline(), 7)
    expect(message).toContain('File your written Answer')
    expect(message).toContain('2026-04-01')
    expect(message).toContain('in 7 days')
  })

  it('reveals no party name, amount, or case type', () => {
    // A text saying "your eviction hearing" on a shared phone can out someone.
    const message = composeMessage(
      deadline({ title: 'Go to your eviction hearing', caseId: 'c1' }),
      2
    )
    expect(message).not.toMatch(/\$|plaintiff|defendant|debt|landlord|v\./i)
  })

  it('reads naturally at one day and zero days', () => {
    expect(composeMessage(deadline(), 1)).toContain('due tomorrow')
    expect(composeMessage(deadline(), 0)).toContain('due today')
  })

  it('adds emphasis only for a case-ending deadline that is imminent', () => {
    expect(composeMessage(deadline(), 2)).toContain('This one is important')
    expect(composeMessage(deadline(), 7)).not.toContain('This one is important')
    expect(composeMessage(deadline({ jurisdictional: false }), 1)).not.toContain('This one is important')
  })

  it('tells the recipient how to stop', () => {
    expect(composeMessage(deadline(), 7)).toMatch(/reply stop/i)
  })

  it('gives no legal advice', () => {
    const message = composeMessage(deadline(), 1)
    expect(message).not.toMatch(/you should|we recommend|your best/i)
  })
})

describe('runReminderPass', () => {
  const sent: Array<{ to: string; body: string }> = []
  const sms: SmsSender = {
    async send(to, body) {
      sent.push({ to, body })
      return { sid: 'SM123' }
    },
  }

  beforeEach(() => {
    sent.length = 0
  })

  it('sends and records in one pass', async () => {
    const recorded: Array<[string, number[]]> = []
    const result = await runReminderPass({
      deadlines: [deadline()],
      sms,
      smsEnabled: true,
      now: new Date('2026-03-18T14:00:00Z'),
      markSent: async (id, offsets) => {
        recorded.push([id, offsets])
      },
    })

    expect(result).toMatchObject({ scanned: 1, sent: 1, failed: 0 })
    expect(sent).toHaveLength(1)
    expect(recorded).toEqual([['d1', [14]]])
  })

  it('does not mark an offset as sent when sending fails', async () => {
    // Otherwise a transient Twilio error silently costs the litigant that warning.
    const recorded: string[] = []
    const failing: SmsSender = {
      async send() {
        throw new Error('twilio unavailable')
      },
    }
    const result = await runReminderPass({
      deadlines: [deadline()],
      sms: failing,
      smsEnabled: true,
      now: new Date('2026-03-18T14:00:00Z'),
      markSent: async (id) => {
        recorded.push(id)
      },
    })

    expect(result.failed).toBe(1)
    expect(recorded).toEqual([])
  })

  it('sends nothing when SMS is disabled, and leaves the offset outstanding', async () => {
    // Staging default. Marking it sent would mean the litigant never gets it in prod.
    const recorded: string[] = []
    const result = await runReminderPass({
      deadlines: [deadline()],
      sms,
      smsEnabled: false,
      now: new Date('2026-03-18T14:00:00Z'),
      markSent: async (id) => {
        recorded.push(id)
      },
    })

    expect(result).toMatchObject({ sent: 0, skipped: 1 })
    expect(sent).toEqual([])
    expect(recorded).toEqual([])
  })

  it('keeps going after one deadline fails', async () => {
    let calls = 0
    const flaky: SmsSender = {
      async send(to, body) {
        calls++
        if (calls === 1) throw new Error('boom')
        sent.push({ to, body })
        return { sid: 'SM1' }
      },
    }
    const result = await runReminderPass({
      deadlines: [deadline({ id: 'd1' }), deadline({ id: 'd2' })],
      sms: flaky,
      smsEnabled: true,
      now: new Date('2026-03-18T14:00:00Z'),
      markSent: async () => {},
    })
    expect(result).toMatchObject({ scanned: 2, sent: 1, failed: 1 })
  })

  it('uses the court’s timezone to decide what day it is', async () => {
    // 03:30 UTC on 2026-03-19 is still 2026-03-18 in North Carolina, so the 14-day
    // notice is due — a UTC-based worker would think it was 13 days and skip it.
    const result = await runReminderPass({
      deadlines: [deadline()],
      sms,
      smsEnabled: true,
      now: new Date('2026-03-19T03:30:00Z'),
      markSent: async () => {},
    })
    expect(result.sent).toBe(1)
  })
})
