'use client'

/**
 * S5 — plan checkout.
 *
 * While the compliance gate is closed there are no live plans, so this screen honestly
 * says the product is free right now rather than showing prices nobody can pay.
 */

import { useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { api, formatMoney } from '@/lib/api'

interface Plan {
  id: string
  kind: 'monthly' | 'one_shot'
  name: string
  priceCents: number
}

export default function CheckoutPage({ params }: { params: { caseId: string } }) {
  const { getToken } = useAuth()
  const [plans, setPlans] = useState<Plan[]>([])
  const [paymentsLive, setPaymentsLive] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const token = await getToken()
        if (!token) return
        const view = await api.getCase(token, params.caseId)
        const data = await api.plans(token, view.case.caseTypeKey)
        setPlans(data.plans as unknown as Plan[])
        setPaymentsLive(data.paymentsLive)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoaded(true)
      }
    })()
  }, [getToken, params.caseId])

  async function choose(planId: string) {
    setBusy(true)
    setError(null)
    try {
      const token = await getToken()
      if (!token) return
      const { checkoutUrl } = await api.checkout(token, planId, params.caseId)
      window.location.href = checkoutUrl
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="container-readable py-8">
      <Link href={`/cases/${params.caseId}`} className="text-brand underline">
        ← Back to my case
      </Link>
      <h1 className="mt-4 text-2xl">Choose how to pay</h1>

      {loaded && plans.length === 0 && (
        <div className="card mt-6">
          <h2>JusticeDesk is free right now</h2>
          <p className="mt-2 text-ink-muted">
            We are still in review, so nothing is for sale yet. Keep using your case at no cost —
            all of it works.
          </p>
          <Link href={`/cases/${params.caseId}`} className="btn-primary mt-4 w-full">
            Back to my case
          </Link>
        </div>
      )}

      {plans.length > 0 && (
        <>
          <p className="mt-2 text-ink-muted">
            Pick whichever suits you. You can cancel a monthly plan any time.
          </p>
          {!paymentsLive && (
            <p className="mt-3 rounded-lg bg-warn-light p-3 text-sm text-warn">
              Test mode: no real payment will be taken.
            </p>
          )}

          <div className="mt-6 space-y-4">
            {plans.map((plan) => (
              <div key={plan.id} className="card">
                <h2 className="text-lg">{plan.name}</h2>
                <p className="mt-1 text-2xl font-bold">
                  {formatMoney(plan.priceCents)}
                  {plan.kind === 'monthly' && (
                    <span className="text-base font-normal text-ink-muted"> / month</span>
                  )}
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                  {plan.kind === 'monthly'
                    ? 'Everything for this case, for as long as it runs. Cancel any time.'
                    : 'One document, prepared and ready to print.'}
                </p>
                <button
                  className="btn-primary mt-4 w-full"
                  disabled={busy}
                  onClick={() => void choose(plan.id)}
                >
                  Choose this
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {error && <p className="mt-4 text-urgent">{error}</p>}

      <p className="mt-6 text-sm text-ink-faint">
        Court filing fees are separate and go to the court, not to JusticeDesk. If you cannot afford
        a filing fee, you can ask the court to waive it.
      </p>
    </div>
  )
}
