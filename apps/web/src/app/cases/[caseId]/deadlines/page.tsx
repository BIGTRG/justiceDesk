'use client'

/** S10 — deadlines calendar and SMS reminder settings. */

import { useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { DeadlineBadge } from '@/components/CaseUi'
import { UnverifiedContentBanner } from '@/components/Disclosure'
import { api, formatDate } from '@/lib/api'

interface Deadline {
  id: string
  ruleKey: string
  title: string
  dueDate: string
  ruleSource: string
  status: string
  warnings: string[]
  jurisdictional: boolean
}

function urgencyOf(dueDate: string, today: string): 'overdue' | 'due_today' | 'critical' | 'soon' | 'upcoming' {
  const days = Math.round(
    (Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000
  )
  if (days < 0) return 'overdue'
  if (days === 0) return 'due_today'
  if (days <= 2) return 'critical'
  if (days <= 7) return 'soon'
  return 'upcoming'
}

export default function DeadlinesPage({ params }: { params: { caseId: string } }) {
  const { getToken } = useAuth()
  const [deadlines, setDeadlines] = useState<Deadline[]>([])
  const [today, setToday] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const token = await getToken()
        if (!token) return
        const data = await api.deadlines(token, params.caseId)
        setDeadlines(data.deadlines as unknown as Deadline[])
        setToday(data.today)
      } catch (err) {
        setError((err as Error).message)
      }
    })()
  }, [getToken, params.caseId])

  const upcoming = deadlines.filter((d) => d.status === 'pending')
  const past = deadlines.filter((d) => d.status !== 'pending')

  return (
    <div className="container-readable py-8">
      <Link href={`/cases/${params.caseId}`} className="text-brand underline">
        ← Back to my case
      </Link>
      <h1 className="mt-4 text-2xl font-bold">My dates</h1>
      {today && <p className="mt-1 text-ink-muted">Today is {formatDate(today)}.</p>}

      {error && <p className="mt-4 text-urgent">{error}</p>}

      <div className="card mt-6 bg-brand-light">
        <h2 className="font-bold">Text reminders</h2>
        <p className="mt-1 text-sm">
          We text you 14 days, 7 days, 2 days and 1 day before each date. Reply STOP to any message
          to stop them.
        </p>
      </div>

      <section className="mt-8">
        <h2 className="text-xl font-bold">Coming up</h2>
        {upcoming.length === 0 ? (
          <p className="mt-2 text-ink-muted">
            No dates yet. Once we know when you were served or when your hearing is, they appear
            here.
          </p>
        ) : (
          <ul className="mt-4 space-y-4">
            {upcoming.map((deadline) => (
              <li key={deadline.id} className="card">
                <h3 className="text-lg font-bold">{deadline.title}</h3>
                <p className="mt-2">
                  <DeadlineBadge urgency={urgencyOf(deadline.dueDate, today)} dueDate={deadline.dueDate} />
                </p>
                {deadline.jurisdictional && (
                  <p className="mt-2 text-sm font-semibold text-urgent">
                    Missing this date can end your case.
                  </p>
                )}
                <p className="mt-2 text-sm text-ink-faint">Based on {deadline.ruleSource}</p>
                {deadline.warnings?.length > 0 && (
                  <div className="mt-3">
                    <UnverifiedContentBanner warnings={deadline.warnings} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {past.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xl font-bold">Past</h2>
          <ul className="mt-4 space-y-2">
            {past.map((deadline) => (
              <li key={deadline.id} className="rounded-lg bg-paper-sunk p-3 text-sm">
                <span className="font-semibold">{deadline.title}</span> — {formatDate(deadline.dueDate)} (
                {deadline.status})
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
