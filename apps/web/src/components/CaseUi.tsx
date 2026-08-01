'use client'

/**
 * Shared case-portal pieces: the Next Action card, the vertical timeline, and the
 * deadline badge. Used by S6, S10 and the close-out screen.
 */

import clsx from 'clsx'
import Link from 'next/link'
import { formatDate, formatMoney, type NextActionView, type TimelineEntryView } from '@/lib/api'
import { UnverifiedContentBanner } from './Disclosure'
import { AutoTerms, Term } from './Term'

const URGENCY_STYLES: Record<string, { chip: string; label: string }> = {
  overdue: { chip: 'bg-urgent text-white', label: 'Past due' },
  due_today: { chip: 'bg-urgent text-white', label: 'Due today' },
  critical: { chip: 'bg-urgent-light text-urgent', label: 'Due very soon' },
  soon: { chip: 'bg-warn-light text-warn', label: 'Coming up' },
  upcoming: { chip: 'bg-paper-sunk text-ink-muted', label: 'Upcoming' },
}

export function DeadlineBadge({
  urgency,
  dueDate,
}: {
  urgency: TimelineEntryView['urgency']
  dueDate: string
}) {
  const style = URGENCY_STYLES[urgency ?? 'upcoming'] ?? URGENCY_STYLES.upcoming!
  return (
    <span className={clsx('inline-flex rounded-full px-3 py-1 text-sm font-semibold', style.chip)}>
      {style.label} · {formatDate(dueDate)}
    </span>
  )
}

/** S6 — the single most important thing on the screen. */
export function NextActionCard({
  action,
  caseId,
}: {
  action: NextActionView | null
  caseId: string
}) {
  if (!action) {
    return (
      <div className="card">
        <h2 className="text-lg font-bold">Nothing to do right now</h2>
        <p className="mt-2 text-ink-muted">
          There is no next step waiting on you. Check back if anything changes.
        </p>
      </div>
    )
  }

  const urgent = action.urgency === 'overdue' || action.urgency === 'due_today' || action.urgency === 'critical'

  return (
    <section
      aria-labelledby="next-action-heading"
      className={clsx(
        'rounded-xl border-2 bg-white p-5',
        urgent ? 'border-urgent' : 'border-brand'
      )}
    >
      <p className="text-sm font-bold uppercase tracking-wide text-brand">Your next step</p>
      <h2 id="next-action-heading" className="mt-1 text-xl font-bold">
        {action.title}
      </h2>

      {action.dueDate && (
        <p className="mt-3">
          <DeadlineBadge urgency={action.urgency} dueDate={action.dueDate} />
        </p>
      )}

      {action.needsFact && (
        <p className="mt-3 rounded-lg bg-brand-light p-3 text-sm text-brand-dark">
          To work out this date we still need to know your{' '}
          <strong>{action.needsFact.replace(/_/g, ' ')}</strong>.{' '}
          <Link href={`/cases/${caseId}/facts`} className="font-semibold underline">
            Add it now
          </Link>
        </p>
      )}

      <p className="mt-3 text-ink-muted">
        <AutoTerms text={action.explainer} />
      </p>

      {action.courtFeeCents != null && (
        <p className="mt-3 text-sm">
          <span className="font-semibold">Court fee:</span> {formatMoney(action.courtFeeCents)}
        </p>
      )}

      {action.requiredDocuments.length > 0 && (
        <div className="mt-4">
          <h3 className="font-semibold">What you need</h3>
          <ul className="mt-2 space-y-2">
            {action.requiredDocuments.map((doc) => (
              <li key={doc.templateKey} className="rounded-lg bg-paper-sunk p-3">
                <p className="font-semibold">
                  {doc.title}
                  {!doc.required && <span className="font-normal text-ink-faint"> (optional)</span>}
                </p>
                <p className="text-sm text-ink-muted">{doc.purpose}</p>
                <Link
                  href={`/cases/${caseId}/interview/new?template=${doc.templateKey}`}
                  className="mt-2 inline-block font-semibold text-brand underline"
                >
                  Start this document
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {action.warnings.length > 0 && (
        <div className="mt-4">
          <UnverifiedContentBanner warnings={action.warnings} />
        </div>
      )}
    </section>
  )
}

/** S6 — the vertical timeline built from the pinned workflow definition. */
export function Timeline({ entries }: { entries: TimelineEntryView[] }) {
  return (
    <ol className="relative space-y-0 border-l-2 border-paper-edge pl-6">
      {entries.map((entry) => (
        <li key={entry.stageKey} className="relative pb-8 last:pb-0">
          <span
            aria-hidden
            className={clsx(
              'absolute -left-[31px] top-1 h-4 w-4 rounded-full border-2',
              entry.status === 'complete' && 'border-ok bg-ok',
              entry.status === 'current' && 'border-brand bg-brand',
              entry.status === 'pending' && 'border-paper-edge bg-white'
            )}
          />
          <h3
            className={clsx(
              'text-base font-bold',
              entry.status === 'pending' && 'text-ink-faint',
              entry.status === 'current' && 'text-brand-dark'
            )}
          >
            {entry.title}
            {entry.status === 'current' && (
              <span className="ml-2 rounded bg-brand-light px-2 py-0.5 text-xs font-semibold text-brand-dark">
                You are here
              </span>
            )}
            {entry.status === 'complete' && <span className="sr-only"> (done)</span>}
          </h3>

          <p className="mt-1 text-sm text-ink-muted">
            <AutoTerms text={entry.plainLanguageExplainer} />
          </p>

          {entry.deadline && (
            <p className="mt-2">
              <DeadlineBadge urgency={entry.urgency} dueDate={entry.deadline.dueDate} />
            </p>
          )}

          {entry.deadline && (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer font-semibold text-brand">
                How we worked out this date
              </summary>
              <ol className="mt-2 space-y-1 rounded-lg bg-paper-sunk p-3">
                {entry.deadline.steps.map((step, i) => (
                  <li key={i}>
                    <span className="font-medium">{step.label}</span> → {formatDate(step.date)}
                    {step.detail && <span className="block text-ink-faint">{step.detail}</span>}
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-ink-faint">
                Based on {entry.deadline.source.citation}. {entry.deadline.source.summary}
              </p>
            </details>
          )}

          {entry.blockedOnFact && (
            <p className="mt-2 text-sm text-ink-faint">
              We need your {entry.blockedOnFact.replace(/_/g, ' ')} before we can work out this date.
            </p>
          )}

          {entry.courtFeeCents != null && (
            <p className="mt-2 text-sm">
              <span className="font-semibold">Court fee:</span> {formatMoney(entry.courtFeeCents)}
            </p>
          )}
        </li>
      ))}
    </ol>
  )
}

/** S6 quick tiles. */
export function QuickTiles({ caseId }: { caseId: string }) {
  const tiles = [
    { href: `/cases/${caseId}/documents`, label: 'My documents', hint: 'Download or print' },
    { href: `/cases/${caseId}/deadlines`, label: 'My dates', hint: 'Calendar and reminders' },
    { href: `/cases/${caseId}/chat`, label: 'Ask a question', hint: 'About your case' },
    { href: `/cases/${caseId}/close`, label: 'Close this case', hint: 'When it is over' },
  ]
  return (
    <nav aria-label="Case sections" className="grid grid-cols-2 gap-3">
      {tiles.map((tile) => (
        <Link
          key={tile.href}
          href={tile.href}
          className="card flex min-h-[88px] flex-col justify-center hover:bg-paper-sunk"
        >
          <span className="font-semibold">{tile.label}</span>
          <span className="text-sm text-ink-muted">{tile.hint}</span>
        </Link>
      ))}
    </nav>
  )
}

export { Term }
