/**
 * Content-caveat propagation.
 *
 * A stage with no deadline still shows unverified legal guidance. These tests pin the
 * rule that the caveat rides the *definition*, not the deadline.
 */

import { northCarolinaCalendar } from '../deadlines/calendar.js'
import { buildTimeline, nextAction } from './engine.js'
import { makeDefinition } from './fixtures.js'

const calendar = northCarolinaCalendar()
const verified = {
  status: 'attorney_verified' as const,
  verifiedBy: 'Reviewing Counsel',
  verifiedAt: '2026-07-01',
}

function timelineFor(defOverrides = {}, stageKey = 'served') {
  return buildTimeline({
    definition: makeDefinition(defOverrides),
    state: { currentStageKey: stageKey, completedStageKeys: [], role: 'defendant' },
    context: { anchors: { service_date: '2026-03-02' }, serviceMethod: 'personal' },
    calendar,
    today: '2026-03-10',
  })
}

describe('unverified definition', () => {
  it('caveats every stage, including ones with no deadline', () => {
    const timeline = timelineFor()
    for (const entry of timeline) {
      expect(entry.contentWarnings).toEqual([expect.stringMatching(/not been reviewed by an attorney/i)])
    }
  })

  it('surfaces the caveat on a Next Action card for a stage with no deadline', () => {
    // The regression this guards: a stage without a deadline rendering as though the
    // guidance on it were authoritative.
    const timeline = timelineFor({}, 'answer_filed')
    const action = nextAction(timeline)
    expect(action?.dueDate).toBeNull()
    expect(action?.warnings.length).toBeGreaterThan(0)
  })

  it('merges content and deadline caveats without dropping either', () => {
    const action = nextAction(timelineFor())
    expect(action?.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/not been reviewed by an attorney/i),
        expect.stringMatching(/pending attorney review/i),
      ])
    )
  })
})

describe('attorney-verified definition', () => {
  it('drops the content caveat', () => {
    const timeline = timelineFor({ verification: verified })
    for (const entry of timeline) expect(entry.contentWarnings).toEqual([])
  })

  it('still reports deadline-level caveats when the rule itself is unverified', () => {
    // Verifying the definition does not verify each rule inside it.
    const action = nextAction(timelineFor({ verification: verified }))
    expect(action?.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/pending attorney review/i)])
    )
    expect(action?.warnings).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/not been reviewed by an attorney/i)])
    )
  })
})
