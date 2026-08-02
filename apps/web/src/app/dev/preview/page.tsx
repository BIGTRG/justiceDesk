/**
 * Design preview — DEVELOPMENT ONLY.
 *
 * The case portal sits behind Clerk, so reviewing how S6 looks normally means having a
 * real signed-in session with a real case. That is a slow loop for a visual change, and
 * it is the reason the frontend was able to drift off the approved mockup without anyone
 * noticing until it was built.
 *
 * This route renders the portal's components against fixed sample data so the design can
 * be looked at directly. It is a design surface, not a functional one.
 *
 * Three guards, because a page full of realistic-looking case data must never be mistaken
 * for a real case or reachable in production:
 *   1. notFound() unless NODE_ENV is development — the route does not exist otherwise.
 *   2. Every string is visibly fictional (Sample County, ACME Funding LLC).
 *   3. A permanent banner at the top of the page says so.
 */

import { notFound } from 'next/navigation'
import { NextActionCard, QuickTiles, Timeline } from '@/components/CaseUi'
import type { NextActionView, TimelineEntryView } from '@/lib/api'

const SAMPLE_NEXT_ACTION: NextActionView = {
  stageKey: 'file_answer',
  title: 'File your Answer with the Clerk of Court',
  explainer:
    'An Answer is your written response to the Complaint. It tells the court which of the claims you agree with, which you dispute, and any defenses you want to raise. If you do not file one in time, the court can enter a default judgment against you without hearing your side.',
  dueDate: '2026-09-14',
  urgency: 'soon',
  requiredDocuments: [
    {
      templateKey: 'answer_debt',
      title: 'Answer to Complaint',
      required: true,
      purpose: 'Your written response to each claim made against you.',
    },
    {
      templateKey: 'fee_waiver',
      title: 'Petition to Proceed as an Indigent',
      required: false,
      purpose: 'Asks the court to waive the filing fee if you cannot afford it.',
    },
  ],
  courtFeeCents: 0,
  needsFact: null,
  warnings: [
    'The filing deadline shown here is based on content that has not yet been reviewed by counsel.',
  ],
}

const SAMPLE_TIMELINE: TimelineEntryView[] = [
  {
    stageKey: 'served',
    title: 'You were served',
    plainLanguageExplainer:
      'The other side delivered the Summons and Complaint to you. This is the date the clock starts from.',
    status: 'complete',
    courtFeeCents: null,
    requiredDocuments: [],
    deadline: null,
    blockedOnFact: null,
    urgency: null,
    terminal: false,
    contentWarnings: [],
  },
  {
    stageKey: 'file_answer',
    title: 'File your Answer',
    plainLanguageExplainer:
      'Your written response to the Complaint, filed with the Clerk of Court and sent to the other side.',
    status: 'current',
    courtFeeCents: 0,
    requiredDocuments: [],
    deadline: {
      ruleKey: 'answer_30_day',
      title: 'Answer due',
      dueDate: '2026-09-14',
      source: {
        citation: 'N.C. R. Civ. P. 12(a)(1)',
        summary: 'A defendant must serve an answer within 30 days after service of the summons.',
      },
      warnings: [],
      jurisdictional: true,
      steps: [
        { label: 'Date you were served', date: '2026-08-13' },
        { label: 'Add 30 days', date: '2026-09-12', detail: 'N.C. R. Civ. P. 12(a)(1)' },
        {
          label: 'Roll forward off the weekend',
          date: '2026-09-14',
          detail: '12 September 2026 is a Saturday, so the deadline moves to the next business day.',
        },
      ],
    },
    blockedOnFact: null,
    urgency: 'soon',
    terminal: false,
    contentWarnings: [],
  },
  {
    stageKey: 'discovery',
    title: 'Exchange information',
    plainLanguageExplainer:
      'Both sides can ask each other for documents and written answers about the debt.',
    status: 'pending',
    courtFeeCents: null,
    requiredDocuments: [],
    deadline: null,
    blockedOnFact: 'discovery_served_date',
    urgency: null,
    terminal: false,
    contentWarnings: [],
  },
  {
    stageKey: 'hearing',
    title: 'Go to your hearing',
    plainLanguageExplainer:
      'You and the other side each explain your position to the judge, who then decides.',
    status: 'pending',
    courtFeeCents: 2000,
    requiredDocuments: [],
    deadline: null,
    blockedOnFact: null,
    urgency: null,
    terminal: false,
    contentWarnings: [],
  },
]

export default function DesignPreviewPage() {
  // Guard 1. In production this route simply does not exist.
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <div className="container-readable py-8">
      {/* Guard 3. Not dismissible. */}
      <div className="notice-warn mb-8">
        <p className="font-semibold">Design preview — not a real case.</p>
        <p className="mt-1 text-sm">
          Every name, date and figure on this page is invented so the layout can be reviewed.
          This route is only served when the app runs in development.
        </p>
      </div>

      <header className="rule border-t-0 pb-5">
        <p className="eyebrow">Your case</p>
        <h1 className="mt-1.5 text-2xl sm:text-3xl">ACME Funding LLC v. You</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Case number <span className="font-serif text-ink">26-CVD-004182</span>
        </p>
        <p className="prose-legal mt-4">
          A company says you owe money on an old account and has filed a case in Sample County
          District Court. You have a limited time to respond in writing.
        </p>
      </header>

      <div className="mt-6">
        <NextActionCard action={SAMPLE_NEXT_ACTION} caseId="preview" />
      </div>

      <div className="mt-6">
        <QuickTiles caseId="preview" />
      </div>

      <section className="rule mt-12 pt-6">
        <h2 className="text-xl sm:text-2xl">What happens in a case like yours</h2>
        <p className="mt-1.5 text-sm text-ink-muted">
          These steps do not change once your case is open, even if we update our guidance later.
        </p>
        <div className="mt-5">
          <Timeline entries={SAMPLE_TIMELINE} />
        </div>
      </section>

      {/* The remaining states, so they can be compared side by side rather than hunted for. */}
      <section className="rule mt-12 pt-6">
        <h2 className="text-xl sm:text-2xl">Other states</h2>

        <p className="eyebrow mt-6">Next action — overdue</p>
        <div className="mt-2">
          <NextActionCard
            action={{
              ...SAMPLE_NEXT_ACTION,
              title: 'File your Answer — this is past due',
              urgency: 'overdue',
              dueDate: '2026-07-20',
              warnings: [],
              requiredDocuments: [],
            }}
            caseId="preview"
          />
        </div>

        <p className="eyebrow mt-8">Next action — blocked on a missing fact</p>
        <div className="mt-2">
          <NextActionCard
            action={{
              ...SAMPLE_NEXT_ACTION,
              dueDate: null,
              urgency: null,
              needsFact: 'date_served',
              warnings: [],
              requiredDocuments: [],
            }}
            caseId="preview"
          />
        </div>

        <p className="eyebrow mt-8">Next action — nothing waiting</p>
        <div className="mt-2">
          <NextActionCard action={null} caseId="preview" />
        </div>

        <p className="eyebrow mt-8">Buttons</p>
        <div className="mt-2 flex flex-wrap gap-3">
          <button className="btn-primary">Start now</button>
          <button className="btn-secondary">Not yet</button>
          <button className="btn-accent">Pay the filing fee</button>
          <button className="btn-primary" disabled>
            Disabled
          </button>
        </div>

        <p className="eyebrow mt-8">Notices</p>
        <div className="mt-2 space-y-3">
          <div className="notice-urgent">Your hearing is tomorrow. Go to the courthouse.</div>
          <div className="notice-warn">Check this date with the Clerk of Court.</div>
          <div className="notice-ok">Your Answer was filed.</div>
          <div className="notice-info">We still need one more fact to work out this date.</div>
        </div>

        <p className="eyebrow mt-8">Loading</p>
        <div className="mt-2">
          <div className="skeleton h-3 w-24" />
          <div className="skeleton mt-3 h-8 w-3/4" />
          <div className="skeleton mt-6 h-44 rounded-xl" />
        </div>
      </section>
    </div>
  )
}
