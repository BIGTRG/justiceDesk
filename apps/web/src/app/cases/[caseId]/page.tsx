'use client'

/** S6 — Case Home. Next Action card, vertical timeline, quick tiles. */

import { useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { NextActionCard, QuickTiles, Timeline } from '@/components/CaseUi'
import { UnverifiedContentBanner } from '@/components/Disclosure'
import { AutoTerms } from '@/components/Term'
import { api, type CaseView } from '@/lib/api'

export default function CaseHomePage({ params }: { params: { caseId: string } }) {
  const { getToken } = useAuth()
  const [view, setView] = useState<CaseView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const token = await getToken()
        if (!token) return
        const data = await api.getCase(token, params.caseId)
        if (!cancelled) setView(data)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getToken, params.caseId])

  if (error) {
    return (
      <div className="container-readable py-8">
        <p className="text-urgent">{error}</p>
        <Link href="/cases" className="btn-secondary mt-4">
          Back to my cases
        </Link>
      </div>
    )
  }

  if (!view) {
    // A skeleton in the shape of the real screen. On a slow phone this is the difference
    // between "it is coming" and "it is broken" — and this screen is often opened by
    // someone who is already anxious about what it will say.
    return (
      <div className="container-readable py-8" role="status" aria-busy="true">
        <span className="sr-only">Loading your case</span>
        <div className="skeleton h-3 w-24" />
        <div className="skeleton mt-3 h-8 w-3/4" />
        <div className="skeleton mt-3 h-4 w-full" />
        <div className="skeleton mt-2 h-4 w-5/6" />
        <div className="skeleton mt-6 h-44 rounded-xl" />
        <div className="mt-6 grid grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-[88px] rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  // Collected once at the top so the caveat appears whether or not a deadline exists.
  const contentWarnings = [...new Set(view.timeline.flatMap((e) => e.contentWarnings))]

  return (
    <div className="container-readable py-8">
      {/*
        A case caption, not a page title. The serif name over a hairline rule with the
        court case number set beside it is how the top of a filing looks, and it is the
        cheapest way to tell a litigant that this is their actual case rather than an app.
      */}
      <header className="rule border-t-0 pb-5">
        <p className="eyebrow">Your case</p>
        <h1 className="mt-1.5 text-2xl sm:text-3xl">{view.title}</h1>
        {view.case.courtCaseNumber && (
          <p className="mt-1.5 text-sm text-ink-muted">
            Case number <span className="font-serif text-ink">{view.case.courtCaseNumber}</span>
          </p>
        )}
        <p className="prose-legal mt-4">
          <AutoTerms text={view.overview} />
        </p>
      </header>

      {contentWarnings.length > 0 && (
        <div className="mt-5">
          <UnverifiedContentBanner warnings={contentWarnings} />
        </div>
      )}

      <div className="mt-6">
        <NextActionCard action={view.nextAction} caseId={params.caseId} />
      </div>

      <div className="mt-6">
        <QuickTiles caseId={params.caseId} />
      </div>

      <section className="rule mt-12 pt-6">
        <h2 className="text-xl sm:text-2xl">What happens in a case like yours</h2>
        <p className="mt-1.5 text-sm text-ink-muted">
          These steps do not change once your case is open, even if we update our guidance later.
        </p>
        <div className="mt-5">
          <Timeline entries={view.timeline} />
        </div>
      </section>
    </div>
  )
}
