/**
 * Case orchestration: turning a stored case plus its pinned workflow definition into the
 * view the portal renders, and keeping the `deadlines` table in step with it.
 *
 * All the actual reasoning lives in @justicedesk/shared and is tested there. This layer
 * only moves data — deliberately, so the logic a litigant depends on is exercised by pure
 * unit tests rather than only through the database.
 */

import {
  buildTimeline,
  collectDeadlines,
  nextAction,
  northCarolinaCalendar,
  todayInZone,
  type CaseMetadata,
  type CourtCalendar,
  type DeadlineContext,
  type NextAction,
  type PlainDate,
  type TimelineEntry,
  type WorkflowDefinition,
} from '@justicedesk/shared'
import type pg from 'pg'
import type { CaseRow } from './auth.js'

/**
 * Calendar selection.
 *
 * Phase 1 is North Carolina only, so this is a single branch. It is a function rather
 * than a constant because adding a state means adding a calendar here, and a lookup that
 * silently falls back to NC for an out-of-state case would produce confidently wrong
 * dates.
 */
export function calendarFor(jurisdictionKey: string): CourtCalendar {
  if (jurisdictionKey.startsWith('NC-')) return northCarolinaCalendar()
  throw new Error(
    `No court calendar configured for jurisdiction "${jurisdictionKey}". ` +
      'Add one before opening cases there — falling back to another state would produce wrong deadlines.'
  )
}

export function deadlineContextFor(metadata: CaseMetadata): DeadlineContext {
  return {
    anchors: (metadata.anchors ?? {}) as DeadlineContext['anchors'],
    serviceMethod: metadata.serviceMethod,
  }
}

export interface CaseView {
  case: CaseRow
  definition: WorkflowDefinition
  today: PlainDate
  timeline: TimelineEntry[]
  nextAction: NextAction | null
}

export function buildCaseView(row: CaseRow): CaseView {
  const definition = row.definition as WorkflowDefinition
  const calendar = calendarFor(row.jurisdictionKey)
  const today = todayInZone(row.timeZone || 'America/New_York')

  const timeline = buildTimeline({
    definition,
    state: {
      currentStageKey: row.currentStageKey,
      completedStageKeys: completedStagesOf(row),
      role: row.role,
    },
    context: deadlineContextFor(row.metadata),
    calendar,
    today,
  })

  return { case: row, definition, today, timeline, nextAction: nextAction(timeline) }
}

/**
 * Which stages a case has already passed.
 *
 * Derived from `case_stage_events` in `syncCase`; the in-memory shortcut here reads the
 * copy kept on the case's metadata so a single-row read can render a timeline.
 */
function completedStagesOf(row: CaseRow): string[] {
  const completed = row.metadata?.completedStageKeys
  return Array.isArray(completed) ? (completed as string[]) : []
}

/**
 * Write computed deadlines into the `deadlines` table so svc-jobs can schedule reminders.
 *
 * Recomputed rather than incrementally updated: the anchors change as facts arrive (OCR
 * confirms a service date, the litigant corrects it), and a stale row would keep sending
 * reminders for a date that moved. Rows the litigant has already acted on are preserved.
 */
export async function syncDeadlines(
  db: pg.Pool | pg.PoolClient,
  caseId: string,
  view: CaseView
): Promise<number> {
  const computed = collectDeadlines(view.timeline)

  for (const deadline of computed) {
    await db.query(
      `INSERT INTO deadlines
         (case_id, rule_key, title, due_date, rule_source, reminder_schedule, warnings, jurisdictional)
       VALUES ($1, $2, $3, $4::date, $5, $6::jsonb, $7::jsonb, $8)
       ON CONFLICT (case_id, rule_key) DO UPDATE
         SET due_date   = EXCLUDED.due_date,
             title      = EXCLUDED.title,
             rule_source = EXCLUDED.rule_source,
             warnings   = EXCLUDED.warnings,
             jurisdictional = EXCLUDED.jurisdictional,
             -- Reset the sent-reminder log when the date moves, so the litigant is
             -- re-warned against the new date rather than silently skipped.
             reminder_schedule = CASE
               WHEN deadlines.due_date IS DISTINCT FROM EXCLUDED.due_date
                 THEN EXCLUDED.reminder_schedule
               ELSE deadlines.reminder_schedule
             END
         WHERE deadlines.status = 'pending'`,
      [
        caseId,
        deadline.ruleKey,
        deadline.title,
        deadline.dueDate,
        deadline.source.citation,
        JSON.stringify({
          offsetsDays: deadline.reminderDates.length ? undefined : [14, 7, 2, 1],
          sentOffsets: [],
        }),
        JSON.stringify(deadline.warnings),
        deadline.jurisdictional,
      ]
    )
  }

  return computed.length
}

/** Record a stage transition and keep the derived columns in step. */
export async function recordStageEvent(
  db: pg.Pool | pg.PoolClient,
  caseId: string,
  fromStageKey: string,
  toStageKey: string
): Promise<void> {
  await db.query(
    `UPDATE case_stage_events SET status = 'complete', completed_at = now()
      WHERE case_id = $1 AND stage_key = $2 AND status <> 'complete'`,
    [caseId, fromStageKey]
  )
  await db.query(
    `INSERT INTO case_stage_events (case_id, stage_key, status) VALUES ($1, $2, 'current')`,
    [caseId, toStageKey]
  )
}
