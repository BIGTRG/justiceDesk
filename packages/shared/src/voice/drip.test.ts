import {
  DEFAULT_DRIP_POLICY,
  DRIP_OPT_OUT_FOOTER,
  explainSuppression,
  hasOptOutFooter,
  isOptOutMessage,
  shouldSendDrip,
  type DripCandidate,
} from './drip.js'

const NOW = new Date('2026-08-01T15:00:00Z')

function candidate(over: Partial<DripCandidate> = {}): DripCandidate {
  return {
    phoneE164: '+19195550123',
    consentGranted: true,
    consentedAt: new Date('2026-07-25T12:00:00Z'),
    optedOut: false,
    campaignLive: true,
    copyApproved: true,
    stepIndex: 0,
    stepOffsetHours: 24,
    enrolledAt: new Date('2026-07-30T12:00:00Z'),
    alreadySentSteps: [],
    sendsInWindow: 0,
    recipientLocalHour: 11,
    ...over,
  }
}

describe('the default is not to send', () => {
  it('sends only when every condition is met', () => {
    expect(shouldSendDrip(candidate(), NOW)).toEqual({ send: true, reasons: [] })
  })

  it('refuses without express consent (#4)', () => {
    expect(shouldSendDrip(candidate({ consentGranted: false }), NOW).reasons).toContain('no_consent')
  })

  it('refuses to a number that opted out, globally', () => {
    // Opt-out is honoured across every tenant and channel.
    expect(shouldSendDrip(candidate({ optedOut: true }), NOW).reasons).toContain('opted_out')
  })

  it('refuses when consent has gone stale', () => {
    const old = new Date(NOW.getTime() - DEFAULT_DRIP_POLICY.consentMaxAgeMs - 1)
    expect(shouldSendDrip(candidate({ consentedAt: old }), NOW).reasons).toContain('consent_too_old')
  })

  it('refuses while the campaign copy is unapproved', () => {
    // Placeholder marketing copy going to a real person is the failure this prevents.
    expect(shouldSendDrip(candidate({ copyApproved: false }), NOW).reasons).toContain(
      'copy_not_approved'
    )
  })

  it('refuses while the campaign is unpublished', () => {
    expect(shouldSendDrip(candidate({ campaignLive: false }), NOW).reasons).toContain(
      'campaign_not_live'
    )
  })

  it('collects every reason rather than stopping at the first', () => {
    const result = shouldSendDrip(
      candidate({ consentGranted: false, optedOut: true, campaignLive: false }),
      NOW
    )
    expect(result.reasons).toEqual(
      expect.arrayContaining(['no_consent', 'opted_out', 'campaign_not_live'])
    )
    expect(explainSuppression(result.reasons)).toHaveLength(result.reasons.length)
  })
})

describe('quiet hours', () => {
  it('does not text in the middle of the night', () => {
    for (const hour of [20, 22, 0, 3, 7]) {
      expect(shouldSendDrip(candidate({ recipientLocalHour: hour }), NOW).reasons).toContain(
        'quiet_hours'
      )
    }
  })

  it('sends during the day', () => {
    for (const hour of [8, 12, 19]) {
      expect(shouldSendDrip(candidate({ recipientLocalHour: hour }), NOW).send).toBe(true)
    }
  })

  it('handles the window wrapping midnight', () => {
    // 20:00 → 08:00 spans the date boundary; a naive range check gets this backwards.
    expect(shouldSendDrip(candidate({ recipientLocalHour: 23 }), NOW).reasons).toContain('quiet_hours')
    expect(shouldSendDrip(candidate({ recipientLocalHour: 9 }), NOW).send).toBe(true)
  })

  it('uses the RECIPIENT’s local hour, not the server’s', () => {
    // NOW is 15:00 UTC, which is the middle of the night in some places we may expand to.
    expect(shouldSendDrip(candidate({ recipientLocalHour: 2 }), NOW).reasons).toContain('quiet_hours')
  })
})

describe('cadence', () => {
  it('does not send a step before it is due', () => {
    const notYet = new Date(candidate().enrolledAt.getTime() + 23 * 3_600_000)
    expect(shouldSendDrip(candidate(), notYet).reasons).toContain('not_due')
  })

  it('sends once the step is due', () => {
    const due = new Date(candidate().enrolledAt.getTime() + 24 * 3_600_000)
    expect(shouldSendDrip(candidate({ recipientLocalHour: 12 }), due).send).toBe(true)
  })

  it('never sends the same step twice', () => {
    expect(shouldSendDrip(candidate({ alreadySentSteps: [0] }), NOW).reasons).toContain('already_sent')
  })

  it('respects the frequency cap across campaigns', () => {
    // Four campaigns each sending "just one" is still four texts to one person.
    expect(shouldSendDrip(candidate({ sendsInWindow: 4 }), NOW).reasons).toContain('frequency_cap')
    expect(shouldSendDrip(candidate({ sendsInWindow: 3 }), NOW).send).toBe(true)
  })
})

describe('recognising an opt-out', () => {
  it.each([
    'STOP',
    'stop',
    ' Stop ',
    'UNSUBSCRIBE',
    'cancel',
    'quit',
    'opt out',
    'optout',
    'remove me',
    'please stop texting me',
    'no more texts',
    'leave me alone',
    "don't text me",
  ])('treats %p as an opt-out', (message) => {
    // Requiring the exact keyword to honour a plain request would be indefensible.
    expect(isOptOutMessage(message)).toBe(true)
  })

  it.each(['yes', 'ok thanks', 'what is my deadline', 'I need help', ''])(
    'does not treat %p as an opt-out',
    (message) => {
      expect(isOptOutMessage(message)).toBe(false)
    }
  )
})

describe('every message carries a way out', () => {
  it('has a standard footer', () => {
    expect(DRIP_OPT_OUT_FOOTER).toMatch(/reply stop/i)
  })

  it('detects the footer regardless of casing', () => {
    expect(hasOptOutFooter('Your deadline is soon. Reply STOP to end these texts.')).toBe(true)
    expect(hasOptOutFooter('reply stop anytime')).toBe(true)
    expect(hasOptOutFooter('Your deadline is soon.')).toBe(false)
  })
})
