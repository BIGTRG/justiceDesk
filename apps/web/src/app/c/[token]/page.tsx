'use client'

/**
 * The post-call landing page (v2 §4).
 *
 * Target of the SMS sent during or after a call. Shows the caller their own summary and
 * one-tap options to continue.
 *
 * Two things it deliberately is not:
 *   * It is not the case portal. The link is a capability held by a phone, not a
 *     signed-in identity, so it shows nothing that would need authentication to learn —
 *     no transcript, no recording, no deadlines, no documents.
 *   * It is not a paywall dead-end. Someone who cannot pay leaves with something.
 */

import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { DisclosureStrip } from '@/components/Disclosure'

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4101'

interface Offer {
  kind: 'one_shot_document' | 'subscription' | 'call_credit'
  feeKey: string
  title: string
  description: string
  priceCents: number
}

interface Landing {
  callId: string
  summaryText: string
  detectedCaseType: string | null
  offers: Offer[]
  alreadyPaidCents: number
  expiresAt: string
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`
}

export default function PostCallLandingPage() {
  const params = useParams<{ token: string }>()
  const search = useSearchParams()
  const justPaid = search.get('paid') === '1'

  const [landing, setLanding] = useState<Landing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${BASE}/v1/landing/${params.token}`, { cache: 'no-store' })
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as
            | { error?: { message?: string } }
            | null
          throw new Error(payload?.error?.message ?? 'This link is no longer available.')
        }
        setLanding((await response.json()) as Landing)
      } catch (err) {
        setError((err as Error).message)
      }
    })()
  }, [params.token])

  async function choose(feeKey: string) {
    setBusy(feeKey)
    setError(null)
    try {
      const response = await fetch(`${BASE}/v1/landing/${params.token}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feeKey }),
      })
      if (!response.ok) throw new Error('That option is not available right now.')
      const { checkoutUrl } = (await response.json()) as { checkoutUrl: string }
      window.location.href = checkoutUrl
    } catch (err) {
      setError((err as Error).message)
      setBusy(null)
    }
  }

  if (error) {
    return (
      <>
        <DisclosureStrip />
        <div className="container-readable py-10">
          <h1 className="text-2xl">This link has expired</h1>
          <p className="mt-3 text-ink-muted">{error}</p>
          <p className="mt-4">
            Call us back and we will text you a new one, or{' '}
            <a href="/" className="font-semibold text-brand underline">
              start your case here
            </a>
            .
          </p>
        </div>
      </>
    )
  }

  if (!landing) {
    // This page is opened from a text message, often seconds after hanging up the phone,
    // usually on cellular. It must never look like a dead link while it resolves.
    return (
      <div className="container-readable py-10" role="status" aria-busy="true">
        <span className="sr-only">Loading</span>
        <div className="skeleton h-3 w-28" />
        <div className="skeleton mt-3 h-8 w-2/3" />
        <div className="skeleton mt-6 h-32 rounded-xl" />
        <div className="skeleton mt-4 h-12 rounded-lg" />
      </div>
    )
  }

  return (
    <>
      <DisclosureStrip />
      <div className="container-readable py-8">
        {justPaid && (
          <div className="mb-6 rounded-xl border border-ok/30 bg-ok-light p-4">
            <p className="font-semibold text-ok">Payment received.</p>
            <p className="mt-1 text-sm">
              We are preparing your document now. We will text you when it is ready — usually a
              couple of minutes.
            </p>
          </div>
        )}

        <h1 className="text-2xl">Here is what we talked about</h1>

        <div className="card mt-4">
          <p className="text-ink-muted">{landing.summaryText}</p>
        </div>

        {landing.alreadyPaidCents > 0 && (
          <p className="mt-3 text-sm text-ink-faint">
            You have already paid {money(landing.alreadyPaidCents)} on this call. That comes off
            your first month if you set this up as a case.
          </p>
        )}

        {landing.offers.length > 0 ? (
          <>
            <h2 className="mt-8 text-xl">What would you like to do?</h2>
            <div className="mt-4 space-y-3">
              {landing.offers.map((offer) => (
                <div key={offer.feeKey} className="card">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-lg font-semibold">{offer.title}</h3>
                    <span className="shrink-0 text-lg font-bold">
                      {money(offer.priceCents)}
                      {offer.kind === 'subscription' && (
                        <span className="text-sm font-normal text-ink-muted">/mo</span>
                      )}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-ink-muted">{offer.description}</p>
                  <button
                    className="btn-primary mt-4 w-full"
                    disabled={busy !== null}
                    onClick={() => void choose(offer.feeKey)}
                  >
                    {busy === offer.feeKey ? 'Opening checkout…' : 'Choose this'}
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="card mt-8">
            <h2>Justice Desk is free right now</h2>
            <p className="mt-2 text-ink-muted">
              We are still in review, so nothing is for sale yet. You can start your case at no
              cost — all of it works.
            </p>
          </div>
        )}

        {/* Nobody leaves with nothing. */}
        <div className="panel mt-8">
          <h2>Not ready to decide?</h2>
          <p className="mt-1 text-sm text-ink-muted">
            You can start your case for free and see your dates and next steps before you pay for
            anything.
          </p>
          <a href="/" className="btn-secondary mt-3 w-full">
            Start my case for free
          </a>
        </div>

        <p className="mt-6 text-sm text-ink-faint">
          This link works until {new Date(landing.expiresAt).toLocaleDateString()}. It only shows
          this summary — to see your full case, you will sign in with your phone number.
        </p>
      </div>
    </>
  )
}
