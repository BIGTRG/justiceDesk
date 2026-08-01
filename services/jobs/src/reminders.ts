/**
 * Deadline reminders.
 *
 * Scans pending deadlines and sends SMS at 14, 7, 2 and 1 days out. The properties that
 * matter are all about not being wrong in the direction that hurts:
 *
 *   * Never send twice for the same offset. A duplicate is annoying; but the mechanism
 *     that prevents duplicates (recording the sent offset) must be transactional, or a
 *     crash between send and record produces one.
 *   * Never silently skip. If a run is missed — a worker was down over a weekend — the
 *     next run must still send the offsets it skipped, as long as the deadline has not
 *     passed. A litigant who never got their 7-day warning does not care that the cron
 *     was down.
 *   * Never send after the deadline. A reminder for a date that has passed is worse than
 *     silence; the follow-up is a different message entirely.
 */

import { remindersSent } from '@justicedesk/service-kit'
import { daysUntilDue, todayInZone, type PlainDate } from '@justicedesk/shared'

export interface DueDeadline {
  id: string
  caseId: string
  title: string
  dueDate: PlainDate
  jurisdictional: boolean
  reminderSchedule: { offsetsDays?: number[]; sentOffsets?: number[] }
  phone: string | null
  timeZone: string
}

export interface ReminderToSend {
  deadlineId: string
  caseId: string
  phone: string
  offsetDays: number
  daysRemaining: number
  message: string
}

export const DEFAULT_OFFSETS = [14, 7, 2, 1]

/**
 * Decide what to send for one deadline.
 *
 * Returns at most one reminder — the largest unsent offset that is now due. Sending the
 * 7- and 2-day notices in the same minute because a worker was down reads as a system
 * malfunction, so a catch-up sends the most urgent one only and marks the rest as spent.
 */
export function reminderFor(deadline: DueDeadline, today: PlainDate): ReminderToSend | null {
  if (!deadline.phone) return null

  const remaining = daysUntilDue(deadline.dueDate, today)
  // Past due: reminders stop. A missed-deadline message is a separate flow.
  if (remaining < 0) return null

  const offsets = (deadline.reminderSchedule.offsetsDays ?? DEFAULT_OFFSETS)
    .slice()
    .sort((a, b) => b - a)
  const sent = new Set(deadline.reminderSchedule.sentOffsets ?? [])

  // Every offset that has come due and has not been sent.
  const outstanding = offsets.filter((o) => remaining <= o && !sent.has(o))
  if (outstanding.length === 0) return null

  // The most urgent of them.
  const offsetDays = Math.min(...outstanding)

  return {
    deadlineId: deadline.id,
    caseId: deadline.caseId,
    phone: deadline.phone,
    offsetDays,
    daysRemaining: remaining,
    message: composeMessage(deadline, remaining),
  }
}

/**
 * The SMS body.
 *
 * Constraints, in order: it must be legally safe (information, never advice), it must be
 * readable on a lock screen, and it must not identify the case to someone glancing at the
 * phone. No party names, no amounts, no case type — a text saying "your eviction hearing"
 * on a shared phone can out someone.
 */
export function composeMessage(deadline: DueDeadline, daysRemaining: number): string {
  const when =
    daysRemaining === 0
      ? 'today'
      : daysRemaining === 1
        ? 'tomorrow'
        : `in ${daysRemaining} days`

  const urgency = deadline.jurisdictional && daysRemaining <= 2 ? ' This one is important.' : ''

  return (
    `JusticeDesk: "${deadline.title}" is due ${when} (${deadline.dueDate}).${urgency} ` +
    `Open your case to see what to do. Reply STOP to end texts.`
  )
}

/** Offsets to mark spent after sending — the one sent, plus any it superseded. */
export function offsetsToRecord(deadline: DueDeadline, sentOffset: number): number[] {
  const offsets = deadline.reminderSchedule.offsetsDays ?? DEFAULT_OFFSETS
  const already = deadline.reminderSchedule.sentOffsets ?? []
  const superseded = offsets.filter((o) => o >= sentOffset)
  return [...new Set([...already, ...superseded])].sort((a, b) => b - a)
}

export interface SmsSender {
  send(to: string, body: string): Promise<{ sid: string }>
}

export interface ReminderRunResult {
  scanned: number
  sent: number
  skipped: number
  failed: number
}

/**
 * Run one pass.
 *
 * The send and the record happen inside a transaction the caller supplies, and the record
 * is committed only after the send resolves — so a crash mid-flight replays the send
 * rather than losing it. Duplicate-on-crash is the safer direction than silence.
 */
export async function runReminderPass(params: {
  deadlines: DueDeadline[]
  sms: SmsSender
  now?: Date
  smsEnabled: boolean
  markSent: (deadlineId: string, offsets: number[]) => Promise<void>
  onError?: (deadlineId: string, err: unknown) => void
}): Promise<ReminderRunResult> {
  const result: ReminderRunResult = { scanned: 0, sent: 0, skipped: 0, failed: 0 }

  for (const deadline of params.deadlines) {
    result.scanned++
    const today = todayInZone(deadline.timeZone || 'America/New_York', params.now ?? new Date())
    const reminder = reminderFor(deadline, today)

    if (!reminder) {
      result.skipped++
      continue
    }

    if (!params.smsEnabled) {
      // Staging default. Marking as sent anyway would mean the litigant silently never
      // gets it, so the offset stays outstanding.
      result.skipped++
      continue
    }

    try {
      await params.sms.send(reminder.phone, reminder.message)
      await params.markSent(reminder.deadlineId, offsetsToRecord(deadline, reminder.offsetDays))
      remindersSent.inc({ channel: 'sms', offset_days: String(reminder.offsetDays) })
      result.sent++
    } catch (err) {
      params.onError?.(deadline.id, err)
      result.failed++
    }
  }

  return result
}
