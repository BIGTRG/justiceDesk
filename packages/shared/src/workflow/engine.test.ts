import { northCarolinaCalendar } from '../deadlines/calendar.js'
import {
  advance,
  allowedTransitions,
  buildTimeline,
  canAdvance,
  collectDeadlines,
  getStage,
  IllegalTransitionError,
  nextAction,
  orderedStages,
  UnknownStageError,
  type CaseStageState,
} from './engine.js'
import { makeDefinition } from './fixtures.js'

const calendar = northCarolinaCalendar()
const definition = makeDefinition()

const servedState: CaseStageState = {
  currentStageKey: 'served',
  completedStageKeys: [],
  role: 'defendant',
}

const context = { anchors: { service_date: '2026-03-02' }, serviceMethod: 'personal' as const }

describe('stage lookup', () => {
  it('finds a stage by key', () => {
    expect(getStage(definition, 'served').title).toBe('You were served')
  })

  it('throws on an unknown key rather than returning undefined', () => {
    expect(() => getStage(definition, 'nope')).toThrow(UnknownStageError)
  })
})

describe('transitions', () => {
  it('lists the legal next stages', () => {
    expect(allowedTransitions(definition, 'served').map((s) => s.key)).toEqual([
      'answer_filed',
      'case_closed',
    ])
  })

  it('returns nothing from a terminal stage', () => {
    expect(allowedTransitions(definition, 'case_closed')).toEqual([])
  })

  it('filters branches by the litigant’s role', () => {
    const def = makeDefinition()
    def.stages[1]!.appliesToRoles = ['plaintiff']
    expect(allowedTransitions(def, 'served', 'defendant').map((s) => s.key)).toEqual(['case_closed'])
    expect(allowedTransitions(def, 'served', 'plaintiff').map((s) => s.key)).toEqual([
      'answer_filed',
      'case_closed',
    ])
  })

  it('answers canAdvance for legal and illegal moves', () => {
    expect(canAdvance(definition, 'served', 'answer_filed')).toBe(true)
    expect(canAdvance(definition, 'case_closed', 'served')).toBe(false)
    expect(canAdvance(definition, 'served', 'does_not_exist')).toBe(false)
  })
})

describe('advance', () => {
  it('moves the case and records the completed stage', () => {
    const result = advance(definition, servedState, 'answer_filed', '2026-03-10T14:00:00Z')
    expect(result.state.currentStageKey).toBe('answer_filed')
    expect(result.state.completedStageKeys).toEqual(['served'])
    expect(result.event).toEqual({
      fromStageKey: 'served',
      toStageKey: 'answer_filed',
      at: '2026-03-10T14:00:00Z',
    })
    expect(result.isTerminal).toBe(false)
  })

  it('does not mutate the state passed in', () => {
    advance(definition, servedState, 'answer_filed', '2026-03-10T14:00:00Z')
    expect(servedState.currentStageKey).toBe('served')
    expect(servedState.completedStageKeys).toEqual([])
  })

  it('flags reaching a terminal stage', () => {
    const result = advance(definition, servedState, 'case_closed', '2026-03-10T14:00:00Z')
    expect(result.isTerminal).toBe(true)
  })

  it('refuses an illegal jump instead of silently repairing it', () => {
    const atClose: CaseStageState = { currentStageKey: 'case_closed', completedStageKeys: [] }
    expect(() => advance(definition, atClose, 'served', '2026-03-10T14:00:00Z')).toThrow(
      IllegalTransitionError
    )
  })

  it('names the allowed stages in the error, so callers can recover', () => {
    try {
      advance(definition, servedState, 'case_closed_typo', '2026-03-10T14:00:00Z')
    } catch (err) {
      expect((err as Error).message).toMatch(/answer_filed, case_closed/)
    }
  })

  it('does not double-record a stage already completed', () => {
    const revisit: CaseStageState = {
      currentStageKey: 'served',
      completedStageKeys: ['served'],
      role: 'defendant',
    }
    const result = advance(definition, revisit, 'answer_filed', '2026-03-10T14:00:00Z')
    expect(result.state.completedStageKeys).toEqual(['served'])
  })
})

describe('orderedStages', () => {
  it('walks in procedural order from the initial stage, not array order', () => {
    expect(orderedStages(definition).map((s) => s.key)).toEqual([
      'served',
      'answer_filed',
      'case_closed',
    ])
  })

  it('omits stages that do not apply to the litigant’s role', () => {
    const def = makeDefinition()
    def.stages[1]!.appliesToRoles = ['plaintiff']
    expect(orderedStages(def, 'defendant').map((s) => s.key)).toEqual(['served', 'case_closed'])
  })
})

describe('buildTimeline', () => {
  const timeline = buildTimeline({
    definition,
    state: servedState,
    context,
    calendar,
    today: '2026-03-10',
  })

  it('marks exactly one stage current and the rest pending', () => {
    expect(timeline.map((e) => e.status)).toEqual(['current', 'pending', 'pending'])
  })

  it('computes the deadline for a stage that has a rule and the facts it needs', () => {
    expect(timeline[0]?.deadline?.dueDate).toBe('2026-04-01')
    expect(timeline[0]?.urgency).toBe('upcoming')
    expect(timeline[0]?.blockedOnFact).toBeNull()
  })

  it('leaves the deadline null for stages without a rule', () => {
    expect(timeline[1]?.deadline).toBeNull()
    expect(timeline[1]?.urgency).toBeNull()
  })

  it('reports the missing fact instead of throwing when a deadline is not yet computable', () => {
    const blocked = buildTimeline({
      definition,
      state: servedState,
      context: { anchors: {} },
      calendar,
      today: '2026-03-10',
    })
    expect(blocked[0]?.deadline).toBeNull()
    expect(blocked[0]?.blockedOnFact).toBe('service_date')
  })

  it('marks completed stages complete', () => {
    const later = buildTimeline({
      definition,
      state: { currentStageKey: 'answer_filed', completedStageKeys: ['served'], role: 'defendant' },
      context,
      calendar,
      today: '2026-03-10',
    })
    expect(later.map((e) => e.status)).toEqual(['complete', 'current', 'pending'])
  })

  it('carries the required documents and court fee through', () => {
    expect(timeline[1]?.requiredDocuments[0]?.templateKey).toBe('nc_debt_answer')
    expect(timeline[1]?.courtFeeCents).toBe(0)
    expect(timeline[0]?.courtFeeCents).toBeNull()
  })
})

describe('nextAction', () => {
  it('surfaces the current stage with its deadline', () => {
    const timeline = buildTimeline({
      definition,
      state: servedState,
      context,
      calendar,
      today: '2026-03-30',
    })
    const action = nextAction(timeline)
    expect(action).toMatchObject({
      stageKey: 'served',
      dueDate: '2026-04-01',
      urgency: 'critical',
    })
  })

  it('passes the unverified-content warnings up to the card', () => {
    const timeline = buildTimeline({
      definition,
      state: servedState,
      context,
      calendar,
      today: '2026-03-10',
    })
    expect(nextAction(timeline)?.warnings.length).toBeGreaterThan(0)
  })

  it('tells the litigant what fact is still needed', () => {
    const timeline = buildTimeline({
      definition,
      state: servedState,
      context: { anchors: {} },
      calendar,
      today: '2026-03-10',
    })
    expect(nextAction(timeline)?.needsFact).toBe('service_date')
  })

  it('falls back to the soonest upcoming deadline from a stage that has none', () => {
    const def = makeDefinition()
    // Give the later stage the deadline and leave the current one bare.
    def.stages[1]!.deadlineRule = def.stages[0]!.deadlineRule
    def.stages[0]!.deadlineRule = null
    const timeline = buildTimeline({
      definition: def,
      state: { currentStageKey: 'case_closed', completedStageKeys: ['served'], role: 'defendant' },
      context,
      calendar,
      today: '2026-03-10',
    })
    expect(nextAction(timeline)?.stageKey).toBe('answer_filed')
  })

  it('returns null when there is nothing left to do', () => {
    expect(nextAction([])).toBeNull()
  })
})

describe('collectDeadlines', () => {
  it('returns computable, not-yet-complete deadlines soonest first', () => {
    const def = makeDefinition()
    def.stages[1]!.deadlineRule = {
      ...def.stages[0]!.deadlineRule!,
      key: 'later',
      offset: { count: 60, unit: 'calendar_days' },
    }
    const timeline = buildTimeline({
      definition: def,
      state: servedState,
      context,
      calendar,
      today: '2026-03-10',
    })
    const deadlines = collectDeadlines(timeline)
    expect(deadlines.map((d) => d.ruleKey)).toEqual(['respond_due', 'later'])
    expect(deadlines[0]!.dueDate < deadlines[1]!.dueDate).toBe(true)
  })

  it('drops deadlines on stages already completed', () => {
    const timeline = buildTimeline({
      definition,
      state: { currentStageKey: 'answer_filed', completedStageKeys: ['served'], role: 'defendant' },
      context,
      calendar,
      today: '2026-03-10',
    })
    expect(collectDeadlines(timeline)).toEqual([])
  })
})
