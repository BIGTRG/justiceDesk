'use client'

import { useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface CaseSummary {
  id: string
  status: string
  caseTypeName: string
  currentStageKey: string
  courtCaseNumber: string | null
  openedAt: string
}

export default function CasesPage() {
  const { getToken } = useAuth()
  const [cases, setCases] = useState<CaseSummary[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void (async () => {
      const token = await getToken()
      if (!token) return
      const data = await api.listCases(token)
      setCases(data.cases as unknown as CaseSummary[])
      setLoaded(true)
    })()
  }, [getToken])

  return (
    <div className="container-readable py-8">
      <h1 className="text-2xl font-bold">My cases</h1>

      {loaded && cases.length === 0 && (
        <div className="card mt-6">
          <p className="text-ink-muted">You do not have any cases yet.</p>
          <Link href="/" className="btn-primary mt-4 w-full">
            Start a case
          </Link>
        </div>
      )}

      <ul className="mt-6 space-y-3">
        {cases.map((c) => (
          <li key={c.id}>
            <Link href={`/cases/${c.id}`} className="card block hover:bg-paper-sunk">
              <span className="text-lg font-semibold">{c.caseTypeName}</span>
              {c.courtCaseNumber && (
                <span className="block text-sm text-ink-muted">Case {c.courtCaseNumber}</span>
              )}
              <span className="mt-1 block text-sm text-ink-faint capitalize">{c.status}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
