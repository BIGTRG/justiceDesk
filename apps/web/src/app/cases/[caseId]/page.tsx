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
    return (
      <div className="container-readable py-8">
        <p className="text-ink-muted">Loading your case…</p>
      </div>
    )
  }

  // Collected once at the top so the caveat appears whether or not a deadline exists.
  const contentWarnings = [...new Set(view.timeline.flatMap((e) => e.contentWarnings))]

  return (
    <div className="container-readable py-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-wide text-ink-faint">Your case</p>
        <h1 className="mt-1 text-2xl font-bold">{view.title}</h1>
        {view.case.courtCaseNumber && (
          <p className="mt-1 text-ink-muted">Case number {view.case.courtCaseNumber}</p>
        )}
        <p className="mt-3 text-ink-muted">
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

      <section className="mt-10">
        <h2 className="text-xl font-bold">What happens in a case like yours</h2>
        <p className="mt-1 text-sm text-ink-muted">
          These steps do not change once your case is open, even if we update our guidance later.
        </p>
        <div className="mt-5">
          <Timeline entries={view.timeline} />
        </div>
      </section>
    </div>
  )
}
