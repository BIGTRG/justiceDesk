/**
 * The state-machine engine.
 *
 * Pure functions over a pinned workflow definition and a case's current position. The
 * engine never reads the database or the clock on its own — callers pass state in and
 * persist what comes back. That makes every transition reproducible and testable, which
 * matters because the timeline it produces is what a litigant relies on to keep a case.
 */

import { compareDates, type PlainDate } from '../dates.js'
import { calculateDeadline, urgencyOf, type DeadlineUrgency } from '../deadlines/calculator.js'
import type { CourtCalendar } from '../deadlines/calendar.js'
import { MissingAnchorError, type DeadlineComputation, type DeadlineContext } from '../deadlines/types.js'
import type { PartyRole, StageStatus, WorkflowDefinition, WorkflowStage } from './types.js'

export class UnknownStageError extends Error {
  constructor(key: string) {
    super(`No stage "${key}" in this workflow definition.`)
    this.name = 'UnknownStageError'
  }
}

export class IllegalTransitionError extends Error {
  readonly from: string
  readonly to: string
  constructor(from: string, to: string, allowed: string[]) {
    super(
      `Cannot move from "${from}" to "${to}". Allowed next stages: ${allowed.length ? allowed.join(', ') : '(none — terminal)'}.`
    )
    this.name = 'IllegalTransitionError'
    this.from = from
    this.to = to
  }
}

export function getStage(definition: WorkflowDefinition, key: string): WorkflowStage {
  const stage = definition.stages.find((s) => s.key === key)
  if (!stage) throw new UnknownStageError(key)
  return stage
}

export function stageExists(definition: WorkflowDefinition, key: string): boolean {
  return definition.stages.some((s) => s.key === key)
}

/** Stages a case in `fromKey` may legally advance to, filtered by the litigant's role. */
export function allowedTransitions(
  definition: WorkflowDefinition,
  fromKey: string,
  role?: PartyRole
): WorkflowStage[] {
  const stage = getStage(definition, fromKey)
  return stage.next
    .map((key) => getStage(definition, key))
    .filter((target) => !role || !target.appliesToRoles || target.appliesToRoles.includes(role))
}

export function canAdvance(
  definition: WorkflowDefinition,
  fromKey: string,
  toKey: string,
  role?: PartyRole
): boolean {
  if (!stageExists(definition, toKey)) return false
  return allowedTransitions(definition, fromKey, role).some((s) => s.key === toKey)
}

export interface CaseStageState {
  currentStageKey: string
  /** Stage keys already completed, oldest first. */
  completedStageKeys: string[]
  role?: PartyRole
}

export interface TransitionEvent {
  fromStageKey: string
  toStageKey: string
  at: string
}

export interface AdvanceResult {
  state: CaseStageState
  event: TransitionEvent
  /** True when the new stage ends the case. */
  isTerminal: boolean
}

/**
 * Move a case to the next stage. Throws on an illegal transition rather than silently
 * repairing it — an unexpected jump means a bug upstream, and quietly accepting it would
 * corrupt the litigant's timeline.
 */
export function advance(
  definition: WorkflowDefinition,
  state: CaseStageState,
  toStageKey: string,
  at: string
): AdvanceResult {
  const from = getStage(definition, state.currentStageKey)
  if (!canAdvance(definition, from.key, toStageKey, state.role)) {
    throw new IllegalTransitionError(
      from.key,
      toStageKey,
      allowedTransitions(definition, from.key, state.role).map((s) => s.key)
    )
  }
  const target = getStage(definition, toStageKey)
  return {
    state: {
      ...state,
      currentStageKey: target.key,
      completedStageKeys: state.completedStageKeys.includes(from.key)
        ? state.completedStageKeys
        : [...state.completedStageKeys, from.key],
    },
    event: { fromStageKey: from.key, toStageKey: target.key, at },
    isTerminal: target.terminal === true,
  }
}

export interface TimelineEntry {
  stageKey: string
  title: string
  plainLanguageExplainer: string
  status: StageStatus
  courtFeeCents: number | null
  requiredDocuments: WorkflowStage['requiredDocuments']
  /** Present when the stage has a deadline rule and the case has the fact it counts from. */
  deadline: DeadlineComputation | null
  /** Set when a deadline could not be computed, naming the fact we still need. */
  blockedOnFact: string | null
  urgency: DeadlineUrgency | null
  terminal: boolean
  /**
   * Caveats about the *content* of this stage, independent of any deadline.
   *
   * A stage's plain-language explainer is itself unverified legal content when the
   * definition is unverified. Deriving the caveat only from deadline warnings would leave
   * stages without a deadline looking authoritative — which is precisely backwards, since
   * those are the stages a litigant reads as guidance rather than as a date.
   */
  contentWarnings: string[]
}

/**
 * Order stages for display: a breadth-first walk from the initial stage, so the timeline
 * reads in procedural order rather than array order. Branches appear after the stage that
 * forks to them.
 */
export function orderedStages(definition: WorkflowDefinition, role?: PartyRole): WorkflowStage[] {
  const byKey = new Map(definition.stages.map((s) => [s.key, s]))
  const ordered: WorkflowStage[] = []
  const seen = new Set<string>()
  const queue: string[] = [definition.initialStageKey]

  while (queue.length) {
    const key = queue.shift()!
    if (seen.has(key)) continue
    const stage = byKey.get(key)
    if (!stage) continue
    if (role && stage.appliesToRoles && !stage.appliesToRoles.includes(role)) {
      seen.add(key)
      continue
    }
    seen.add(key)
    ordered.push(stage)
    queue.push(...stage.next)
  }

  return ordered
}

export interface BuildTimelineOptions {
  definition: WorkflowDefinition
  state: CaseStageState
  context: DeadlineContext
  calendar: CourtCalendar
  today: PlainDate
}

/** Build the vertical timeline shown on Case Home (S6). */
export function buildTimeline(opts: BuildTimelineOptions): TimelineEntry[] {
  const { definition, state, context, calendar, today } = opts
  const completed = new Set(state.completedStageKeys)

  const definitionWarnings =
    definition.verification?.status === 'attorney_verified'
      ? []
      : [
          'This guidance has not been reviewed by an attorney yet. Check anything important with the clerk of court.',
        ]

  return orderedStages(definition, state.role).map((stage) => {
    const status: StageStatus =
      stage.key === state.currentStageKey
        ? 'current'
        : completed.has(stage.key)
          ? 'complete'
          : 'pending'

    let deadline: DeadlineComputation | null = null
    let blockedOnFact: string | null = null

    if (stage.deadlineRule) {
      try {
        deadline = calculateDeadline(stage.deadlineRule, context, calendar, { today })
      } catch (err) {
        if (err instanceof MissingAnchorError) {
          blockedOnFact = err.anchor
        } else {
          throw err
        }
      }
    }

    return {
      stageKey: stage.key,
      title: stage.title,
      plainLanguageExplainer: stage.plainLanguageExplainer,
      status,
      courtFeeCents: stage.courtFeeCents ?? null,
      requiredDocuments: stage.requiredDocuments,
      deadline,
      blockedOnFact,
      urgency: deadline ? urgencyOf(deadline.dueDate, today) : null,
      terminal: stage.terminal === true,
      contentWarnings: definitionWarnings,
    }
  })
}

export interface NextAction {
  stageKey: string
  title: string
  explainer: string
  dueDate: PlainDate | null
  urgency: DeadlineUrgency | null
  /** Documents the litigant still needs to produce for this stage. */
  requiredDocuments: WorkflowStage['requiredDocuments']
  courtFeeCents: number | null
  /** Set when we cannot compute the deadline because a fact is missing. */
  needsFact: string | null
  warnings: string[]
}

/**
 * The single most urgent thing to do next — the Next Action card on S6.
 *
 * Prefers the current stage. If the current stage has no deadline, falls back to the
 * soonest computable upcoming deadline, so a litigant sitting in a waiting stage still
 * sees the hearing date they need to show up for.
 */
export function nextAction(timeline: TimelineEntry[]): NextAction | null {
  const current = timeline.find((e) => e.status === 'current')
  const pick =
    current && (current.deadline || current.blockedOnFact || !current.terminal)
      ? current
      : timeline
          .filter((e) => e.status !== 'complete' && e.deadline)
          .sort((a, b) => compareDates(a.deadline!.dueDate, b.deadline!.dueDate))[0]

  if (!pick) return null

  return {
    stageKey: pick.stageKey,
    title: pick.title,
    explainer: pick.plainLanguageExplainer,
    dueDate: pick.deadline?.dueDate ?? null,
    urgency: pick.urgency,
    requiredDocuments: pick.requiredDocuments,
    courtFeeCents: pick.courtFeeCents,
    needsFact: pick.blockedOnFact,
    warnings: [...pick.contentWarnings, ...(pick.deadline?.warnings ?? [])],
  }
}

/** Every computable deadline across the case, soonest first — powers the calendar (S10). */
export function collectDeadlines(timeline: TimelineEntry[]): DeadlineComputation[] {
  return timeline
    .filter((e) => e.status !== 'complete' && e.deadline)
    .map((e) => e.deadline!)
    .sort((a, b) => compareDates(a.dueDate, b.dueDate))
}
