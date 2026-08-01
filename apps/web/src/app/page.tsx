'use client'

/**
 * S1 — landing.
 *
 * One input and three tiles. Someone arriving here has usually just been handed court
 * papers and is frightened; the page opens with what to do, not with marketing.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { DisclosureStrip } from '@/components/Disclosure'

const CASE_TILES = [
  {
    key: 'debt_defense',
    title: 'Someone is suing me over a debt',
    body: 'A company or collector filed a lawsuit. There is a deadline to respond in writing.',
  },
  {
    key: 'small_claims',
    title: 'Small claims (up to $10,000)',
    body: 'A dispute over money or property, decided by a magistrate in a short hearing.',
  },
  {
    key: 'eviction_tenant',
    title: 'My landlord is trying to evict me',
    body: 'These cases move fast. Your hearing may be only days away.',
  },
]

export default function LandingPage() {
  const router = useRouter()
  const [problem, setProblem] = useState('')

  function start(seed: string) {
    router.push(`/intake?q=${encodeURIComponent(seed)}`)
  }

  return (
    <>
      <DisclosureStrip />

      <div className="container-readable py-8">
        <h1 className="text-3xl font-bold leading-tight">
          Facing court without a lawyer? Start here.
        </h1>
        <p className="mt-3 text-lg text-ink-muted">
          Tell us what happened in your own words. We will show you what the process looks like,
          what your dates are, and help you prepare your paperwork.
        </p>

        <form
          className="mt-6"
          onSubmit={(e) => {
            e.preventDefault()
            if (problem.trim()) start(problem.trim())
          }}
        >
          <label htmlFor="problem" className="label">
            What is going on?
          </label>
          <textarea
            id="problem"
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            rows={4}
            className="field"
            placeholder="For example: I got papers saying a company is suing me for a credit card I don't remember."
          />
          <button type="submit" className="btn-primary mt-4 w-full" disabled={!problem.trim()}>
            Get started
          </button>
          <p className="mt-2 text-sm text-ink-faint">Free to start. No card needed yet.</p>
        </form>

        <h2 className="mt-10 text-xl font-bold">Or pick what fits best</h2>
        <div className="mt-4 space-y-3">
          {CASE_TILES.map((tile) => (
            <button
              key={tile.key}
              type="button"
              onClick={() => start(tile.title)}
              className="card w-full text-left hover:bg-paper-sunk"
            >
              <span className="block text-lg font-semibold">{tile.title}</span>
              <span className="mt-1 block text-ink-muted">{tile.body}</span>
            </button>
          ))}
        </div>

        <div className="mt-10 rounded-xl bg-paper-sunk p-5">
          <h2 className="font-bold">Already started?</h2>
          <Link href="/cases" className="mt-2 inline-block font-semibold text-brand underline">
            Go to my cases
          </Link>
        </div>

        <div className="mt-8 rounded-xl border border-urgent/30 bg-urgent-light p-5">
          <h2 className="font-bold text-urgent">If your court date is in the next few days</h2>
          <p className="mt-2 text-sm">
            Go to your hearing. Showing up matters more than any paperwork. Bring whatever proof
            you have. You can still use JusticeDesk to get ready.
          </p>
        </div>
      </div>
    </>
  )
}
