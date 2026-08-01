'use client'

/**
 * S11 — the persistent case-aware assistant.
 *
 * When the guardrails withhold an answer the litigant sees the substitute message and an
 * attorney-review offer, not an error. Being told "I can't answer that, but here is what
 * I can do" is a legitimate outcome, not a failure.
 */

import { useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { useRef, useState } from 'react'
import { api } from '@/lib/api'

interface Turn {
  role: 'user' | 'assistant'
  content: string
  blocked?: boolean
}

const SUGGESTIONS = [
  'What happens at the hearing?',
  'What should I bring with me?',
  'What does this deadline mean?',
  'What is a default judgment?',
]

export default function ChatPage({ params }: { params: { caseId: string } }) {
  const { getToken } = useAuth()
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  async function ask(question: string) {
    setBusy(true)
    setError(null)
    setTurns((t) => [...t, { role: 'user', content: question }])
    setDraft('')

    try {
      const token = await getToken()
      if (!token) return
      const result = await api.chat(token, params.caseId, question)
      setTurns((t) => [...t, { role: 'assistant', content: result.reply, blocked: result.blocked }])
      endRef.current?.scrollIntoView({ behavior: 'smooth' })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="container-readable flex min-h-[70vh] flex-col py-8">
      <Link href={`/cases/${params.caseId}`} className="text-brand underline">
        ← Back to my case
      </Link>
      <h1 className="mt-4 text-2xl font-bold">Ask about your case</h1>
      <p className="mt-2 text-ink-muted">
        We can explain how steps work, what your dates mean, and what your options are. We cannot
        tell you what to do — that is legal advice, and we are not a law firm.
      </p>

      <div className="mt-6 flex-1 space-y-4" role="log" aria-live="polite">
        {turns.length === 0 && (
          <div className="space-y-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="btn-secondary w-full justify-start text-left"
                onClick={() => void ask(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {turns.map((turn, i) => (
          <div
            key={i}
            className={
              turn.role === 'user'
                ? 'ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-brand px-4 py-3 text-white'
                : turn.blocked
                  ? 'mr-auto max-w-[92%] rounded-xl border border-warn/30 bg-warn-light px-4 py-3'
                  : 'mr-auto max-w-[92%] whitespace-pre-wrap rounded-xl rounded-bl-sm bg-paper-sunk px-4 py-3'
            }
          >
            {turn.content}
            {turn.blocked && (
              <p className="mt-3 text-sm font-semibold">
                Want a licensed attorney to look at this? Attorney review is coming in a future
                update — for now, your local legal aid office or the NC Bar referral service can
                help.
              </p>
            )}
          </div>
        ))}
        {busy && <p className="text-ink-faint">Thinking…</p>}
        <div ref={endRef} />
      </div>

      {error && <p className="mt-2 text-urgent">{error}</p>}

      <form
        className="sticky bottom-0 mt-6 bg-white pt-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (draft.trim()) void ask(draft.trim())
        }}
      >
        <label htmlFor="question" className="sr-only">
          Your question
        </label>
        <div className="flex gap-2">
          <input
            id="question"
            className="field"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask a question about your case"
          />
          <button type="submit" className="btn-primary" disabled={busy || !draft.trim()}>
            Ask
          </button>
        </div>
      </form>
    </div>
  )
}
