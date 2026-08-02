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

/**
 * Deadline urgency, expressed as colour weight rather than volume.
 *
 * Only the two states that mean "today or already missed" get a filled chip. Everything
 * else is tinted. If every date shouts, the one that matters stops being legible — and
 * this audience is already frightened enough without the interface adding to it.
 */
const URGENCY_STYLES: Record<string, { chip: string; label: string }> = {
  overdue: { chip: 'bg-urgent text-white', label: 'Past due' },
  due_today: { chip: 'bg-urgent text-white', label: 'Due today' },
  critical: { chip: 'bg-urgent-light text-urgent', label: 'Due very soon' },
  soon: { chip: 'bg-accent-soft text-accent-ink', label: 'Coming up' },
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
    <span
      className={clsx(
        'inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold',
        style.chip
      )}
    >
      {style.label}
      <span aria-hidden className="opacity-40">
        ·
      </span>
      <span className="font-serif tracking-tight">{formatDate(dueDate)}</span>
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
    // An empty state that still tells the litigant where they stand. "Nothing to do" is
    // reassuring only if it also says the case is not stalled and unattended.
    return (
      <div className="card">
        <p className="eyebrow">Your next step</p>
        <h2 className="mt-1 text-lg sm:text-xl">Nothing is waiting on you</h2>
        <p className="mt-2 text-ink-muted">
          There is no step for you to take right now. We are still watching your dates, and this
          card will change if anything moves.
        </p>
      </div>
    )
  }

  const urgent =
    action.urgency === 'overdue' || action.urgency === 'due_today' || action.urgency === 'critical'

  // A left rule and a lift, not a heavy outline. This is the loudest thing on the screen;
  // everything below it is deliberately quieter so it stays that way.
  return (
    <section
      aria-labelledby="next-action-heading"
      className={clsx(
        'rounded-xl border border-paper-edge border-l-4 bg-paper-card p-6 shadow-lift',
        urgent ? 'border-l-urgent' : 'border-l-accent'
      )}
    >
      <p className={clsx('eyebrow', urgent && 'text-urgent')}>Your next step</p>
      <h2 id="next-action-heading" className="mt-1.5 text-xl sm:text-2xl">
        {action.title}
      </h2>

      {action.dueDate && (
        <p className="mt-3">
          <DeadlineBadge urgency={action.urgency} dueDate={action.dueDate} />
        </p>
      )}

      {action.needsFact && (
        <p className="notice-info mt-4 p-4 text-sm text-brand-dark">
          To work out this date we still need to know your{' '}
          <strong>{action.needsFact.replace(/_/g, ' ')}</strong>.{' '}
          <Link
            href={`/cases/${caseId}/facts`}
            className="font-semibold underline underline-offset-2"
          >
            Add it now
          </Link>
        </p>
      )}

      <p className="prose-legal mt-4">
        <AutoTerms text={action.explainer} />
      </p>

      {action.courtFeeCents != null && (
        <p className="mt-4 text-sm">
          <span className="font-semibold">Court fee:</span>{' '}
          <span className="font-serif">{formatMoney(action.courtFeeCents)}</span>
        </p>
      )}

      {action.requiredDocuments.length > 0 && (
        <div className="mt-5">
          <p className="eyebrow">What you need</p>
          <ul className="mt-2 space-y-2">
            {action.requiredDocuments.map((doc) => (
              <li key={doc.templateKey} className="panel">
                <p className="font-semibold">
                  {doc.title}
                  {!doc.required && <span className="font-normal text-ink-faint"> (optional)</span>}
                </p>
                <p className="mt-0.5 text-sm text-ink-muted">{doc.purpose}</p>
                <Link
                  href={`/cases/${caseId}/interview/new?template=${doc.templateKey}`}
                  className="mt-2 inline-block font-semibold text-brand underline underline-offset-4
                             hover:text-brand-dark"
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
    <ol className="relative space-y-0 border-l border-paper-edge pl-6">
      {entries.map((entry) => (
        <li key={entry.stageKey} className="relative pb-8 last:pb-0">
          {/*
            The current stage gets a gold ring; completed stages are filled green; pending
            stages are hollow. Three states, readable at a glance and without colour alone
            carrying the meaning — the "You are here" label repeats it in words.
          */}
          <span
            aria-hidden
            className={clsx(
              'absolute -left-[8.5px] top-1.5 h-4 w-4 rounded-full border-2 bg-paper',
              entry.status === 'complete' && 'border-ok bg-ok',
              entry.status === 'current' && 'border-accent bg-paper ring-4 ring-accent-soft',
              entry.status === 'pending' && 'border-paper-edge bg-paper'
            )}
          />
          <h3
            className={clsx(
              'font-serif text-base',
              entry.status === 'pending' && 'text-ink-faint',
              entry.status === 'current' && 'text-brand-dark',
              entry.status === 'complete' && 'text-ink-muted'
            )}
          >
            {entry.title}
            {entry.status === 'current' && (
              <span className="ml-2 rounded bg-accent-soft px-2 py-0.5 font-sans text-xs font-bold uppercase tracking-wide text-accent-ink">
                You are here
              </span>
            )}
            {entry.status === 'complete' && <span className="sr-only"> (done)</span>}
          </h3>

          <p
            className={clsx(
              'mt-1 text-sm',
              entry.status === 'pending' ? 'text-ink-faint' : 'text-ink-muted'
            )}
          >
            <AutoTerms text={entry.plainLanguageExplainer} />
          </p>

          {entry.deadline && (
            <p className="mt-2">
              <DeadlineBadge urgency={entry.urgency} dueDate={entry.deadline.dueDate} />
            </p>
          )}

          {/* Showing our working is a trust feature, not a debug view — so it is styled
              like an exhibit rather than a code block. */}
          {entry.deadline && (
            <details className="group mt-2 text-sm">
              <summary
                className="cursor-pointer list-none font-semibold text-brand underline
                           underline-offset-4 hover:text-brand-dark"
              >
                How we worked out this date
                <span aria-hidden className="ml-1 inline-block group-open:rotate-90">
                  ›
                </span>
              </summary>
              <ol className="panel mt-2 space-y-1.5">
                {entry.deadline.steps.map((step, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{step.label}</span>
                    <span aria-hidden className="text-ink-faint">
                      →
                    </span>
                    <span className="font-serif">{formatDate(step.date)}</span>
                    {step.detail && (
                      <span className="block w-full text-ink-faint">{step.detail}</span>
                    )}
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
              <span className="font-semibold">Court fee:</span>{' '}
              <span className="font-serif">{formatMoney(entry.courtFeeCents)}</span>
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
    // Deliberately quieter than a card: no shadow, no white fill. These are ways to get
    // somewhere else, and nothing here should pull attention off the next action.
    <nav aria-label="Case sections" className="grid grid-cols-2 gap-3">
      {tiles.map((tile) => (
        <Link
          key={tile.href}
          href={tile.href}
          className="flex min-h-[88px] flex-col justify-center rounded-xl border border-paper-edge
                     bg-paper-tint p-4 no-underline transition-colors
                     hover:border-brand/30 hover:bg-paper-card"
        >
          <span className="font-semibold text-ink">{tile.label}</span>
          <span className="mt-0.5 text-sm text-ink-muted">{tile.hint}</span>
        </Link>
      ))}
    </nav>
  )
}

export { Term }
