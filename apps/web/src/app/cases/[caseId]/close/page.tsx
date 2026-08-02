'use client'

/**
 * S15 — case close-out and cancel-subscription prompt.
 *
 * The subscription prompt is deliberately prominent and pre-selected toward cancelling. A
 * recurring charge on a closed case, to someone who came here because they were being sued
 * over money, is not a growth tactic worth defending.
 */

import { useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

const OUTCOMES = [
  { value: 'dismissed', label: 'The case was dismissed' },
  { value: 'settled', label: 'We settled' },
  { value: 'judgment_for_me', label: 'The court decided in my favour' },
  { value: 'judgment_against_me', label: 'The court decided against me' },
  { value: 'moved_out', label: 'I moved out' },
  { value: 'other', label: 'Something else' },
  { value: 'prefer_not_to_say', label: 'I would rather not say' },
]

export default function CloseCasePage({ params }: { params: { caseId: string } }) {
  const { getToken } = useAuth()
  const router = useRouter()
  const [outcome, setOutcome] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ activeSubscriptions: Array<{ id: string }> } | null>(null)

  async function close() {
    setBusy(true)
    setError(null)
    try {
      const token = await getToken()
      if (!token) return
      const { api } = await import('@/lib/api')
      const data = await api.closeCase(token, params.caseId, outcome)
      setResult(data)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function cancelSubscription() {
    setBusy(true)
    try {
      const token = await getToken()
      const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4101'
      await fetch(`${base}/v1/cases/${params.caseId}/subscription/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      router.push('/cases')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    return (
      <div className="container-readable py-8">
        <h1 className="text-2xl">Your case is closed</h1>
        <p className="mt-2 text-ink-muted">
          Your documents stay available. You can read, print and download them any time.
        </p>

        {result.activeSubscriptions.length > 0 && (
          <div className="card mt-6 border-2 border-brand">
            <h2 className="text-lg">You still have a monthly plan on this case</h2>
            <p className="mt-2 text-ink-muted">
              Your case is over, so you probably do not need it any more. Cancelling now stops any
              further charges. You keep access to your documents either way.
            </p>
            <button className="btn-primary mt-4 w-full" onClick={() => void cancelSubscription()} disabled={busy}>
              Cancel my monthly plan
            </button>
            <Link href="/cases" className="btn-secondary mt-2 w-full">
              Keep it for now
            </Link>
          </div>
        )}

        {result.activeSubscriptions.length === 0 && (
          <Link href="/cases" className="btn-primary mt-6 w-full">
            Back to my cases
          </Link>
        )}

        {error && <p className="mt-4 text-urgent">{error}</p>}
      </div>
    )
  }

  return (
    <div className="container-readable py-8">
      <Link href={`/cases/${params.caseId}`} className="text-brand underline">
        ← Back to my case
      </Link>
      <h1 className="mt-4 text-2xl">Close this case</h1>
      <p className="mt-2 text-ink-muted">
        Closing stops your reminders. Your documents stay available to read and print.
      </p>

      <form
        className="mt-6"
        onSubmit={(e) => {
          e.preventDefault()
          void close()
        }}
      >
        <fieldset>
          <legend className="label">How did it end?</legend>
          <p className="-mt-1 mb-3 text-sm text-ink-faint">
            This is optional and helps us understand whether JusticeDesk is helping.
          </p>
          <div className="space-y-2">
            {OUTCOMES.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setOutcome(option.value)}
                className={
                  outcome === option.value
                    ? 'btn-primary w-full justify-start text-left'
                    : 'btn-secondary w-full justify-start text-left'
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        {error && <p className="mt-4 text-urgent">{error}</p>}

        <button type="submit" className="btn-primary mt-6 w-full" disabled={busy}>
          {busy ? 'Closing…' : 'Close my case'}
        </button>
      </form>
    </div>
  )
}
