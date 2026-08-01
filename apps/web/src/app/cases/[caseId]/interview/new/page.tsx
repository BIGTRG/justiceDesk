'use client'

/**
 * S7 — the guided interview. One question per screen, with a live preview of what the
 * document will say.
 *
 * One question per screen is not a stylistic choice: a long form is where self-represented
 * litigants abandon, and every answer is saved as it is given so a dropped connection or a
 * dead battery does not cost the work.
 */

import { useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { UnverifiedContentBanner } from '@/components/Disclosure'
import { Term } from '@/components/Term'
import { api } from '@/lib/api'

interface Question {
  key: string
  type: 'short_text' | 'long_text' | 'date' | 'money' | 'yes_no' | 'single_select' | 'multi_select'
  prompt: string
  helpText?: string
  required: boolean
  options?: Array<{ value: string; label: string; helpText?: string }>
  showIf?: { questionKey: string; equals: string | boolean }
  glossaryTerms?: string[]
}

interface Template {
  key: string
  name: string
  schema: { version: number; questions: Question[] }
  disclosureText: string
  verification: { status: string; openQuestions?: string[] }
}

export default function InterviewPage({ params }: { params: { caseId: string } }) {
  const { getToken } = useAuth()
  const router = useRouter()
  const search = useSearchParams()
  const templateKey = search.get('template') ?? ''

  const [interviewId, setInterviewId] = useState<string | null>(null)
  const [template, setTemplate] = useState<Template | null>(null)
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const token = await getToken()
        if (!token) return
        const result = await api.startInterview(token, params.caseId, templateKey)
        setInterviewId(result.interviewId)
        setTemplate(result.template as unknown as Template)
      } catch (err) {
        setError((err as Error).message)
      }
    })()
  }, [getToken, params.caseId, templateKey])

  if (error) {
    return (
      <div className="container-readable py-8">
        <p className="text-urgent">{error}</p>
        <Link href={`/cases/${params.caseId}`} className="btn-secondary mt-4">
          Back to my case
        </Link>
      </div>
    )
  }

  if (!template || !interviewId) {
    return (
      <div className="container-readable py-8">
        <p className="text-ink-muted">Getting your questions ready…</p>
      </div>
    )
  }

  // Conditional questions are filtered out before paging, so "question 3 of 9" stays
  // honest as answers change.
  const visible = template.schema.questions.filter(
    (q) => !q.showIf || answers[q.showIf.questionKey] === q.showIf.equals
  )
  const question = visible[index]
  const isLast = index === visible.length - 1

  async function save(next: Record<string, unknown>) {
    setAnswers(next)
    const token = await getToken()
    if (token && interviewId) {
      // Fire and forget — a save failure must not block the litigant mid-interview.
      void api.saveAnswers(token, params.caseId, interviewId, next).catch(() => {})
    }
  }

  async function finish() {
    setBusy(true)
    try {
      const token = await getToken()
      if (!token || !interviewId) return
      await api.saveAnswers(token, params.caseId, interviewId, answers)
      await api.completeInterview(token, params.caseId, interviewId)
      router.push(`/cases/${params.caseId}/documents?pending=1`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!question) {
    return (
      <div className="container-readable py-8">
        <p>No questions to answer.</p>
      </div>
    )
  }

  return (
    <div className="container-readable py-8">
      <Link href={`/cases/${params.caseId}`} className="text-brand underline">
        ← Back to my case
      </Link>

      <div className="mt-4">
        <p className="text-sm font-semibold text-ink-faint">
          Question {index + 1} of {visible.length} · {template.name}
        </p>
        <div className="mt-2 h-2 rounded-full bg-paper-sunk" role="progressbar"
             aria-valuenow={index + 1} aria-valuemin={1} aria-valuemax={visible.length}>
          <div
            className="h-2 rounded-full bg-brand transition-all"
            style={{ width: `${((index + 1) / visible.length) * 100}%` }}
          />
        </div>
      </div>

      {template.verification.status !== 'attorney_verified' && (
        <div className="mt-5">
          <UnverifiedContentBanner
            warnings={['This document template has not been reviewed by an attorney yet.']}
          />
        </div>
      )}

      <form
        className="mt-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (isLast) void finish()
          else setIndex(index + 1)
        }}
      >
        <fieldset>
          <legend className="text-xl font-bold">
            {question.glossaryTerms?.length ? (
              <>
                {question.prompt}{' '}
                {question.glossaryTerms.map((t) => (
                  <Term key={t} term={t}>
                    <span className="text-base">({t})</span>
                  </Term>
                ))}
              </>
            ) : (
              question.prompt
            )}
          </legend>
          {question.helpText && <p className="mt-2 text-ink-muted">{question.helpText}</p>}

          <div className="mt-4">
            {question.type === 'long_text' && (
              <textarea
                rows={5}
                className="field"
                value={String(answers[question.key] ?? '')}
                onChange={(e) => void save({ ...answers, [question.key]: e.target.value })}
              />
            )}

            {(question.type === 'short_text' || question.type === 'date' || question.type === 'money') && (
              <input
                type={question.type === 'date' ? 'date' : question.type === 'money' ? 'number' : 'text'}
                inputMode={question.type === 'money' ? 'decimal' : undefined}
                className="field"
                value={String(answers[question.key] ?? '')}
                onChange={(e) => void save({ ...answers, [question.key]: e.target.value })}
              />
            )}

            {question.type === 'yes_no' && (
              <div className="space-y-2">
                {[
                  { value: true, label: 'Yes' },
                  { value: false, label: 'No' },
                ].map((option) => (
                  <button
                    key={String(option.value)}
                    type="button"
                    onClick={() => void save({ ...answers, [question.key]: option.value })}
                    className={
                      answers[question.key] === option.value
                        ? 'btn-primary w-full'
                        : 'btn-secondary w-full'
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}

            {question.type === 'single_select' && (
              <div className="space-y-2">
                {question.options?.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => void save({ ...answers, [question.key]: option.value })}
                    className={
                      answers[question.key] === option.value
                        ? 'btn-primary w-full justify-start text-left'
                        : 'btn-secondary w-full justify-start text-left'
                    }
                  >
                    <span>
                      <span className="block">{option.label}</span>
                      {option.helpText && (
                        <span className="block text-sm font-normal opacity-80">{option.helpText}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </fieldset>

        <div className="mt-8 flex gap-3">
          {index > 0 && (
            <button type="button" className="btn-secondary flex-1" onClick={() => setIndex(index - 1)}>
              Back
            </button>
          )}
          <button
            type="submit"
            className="btn-primary flex-1"
            disabled={busy || (question.required && answers[question.key] === undefined)}
          >
            {isLast ? 'Create my document' : 'Next'}
          </button>
        </div>
        <p className="mt-3 text-sm text-ink-faint">Your answers save as you go.</p>
      </form>

      <aside className="card mt-10 bg-paper-sunk">
        <h2 className="font-bold">What your document will say</h2>
        <dl className="mt-3 space-y-2 text-sm">
          {Object.entries(answers)
            .filter(([, v]) => v !== '' && v !== undefined)
            .map(([key, value]) => (
              <div key={key}>
                <dt className="font-semibold capitalize">{key.replace(/_/g, ' ')}</dt>
                <dd className="text-ink-muted">
                  {typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}
                </dd>
              </div>
            ))}
        </dl>
        {Object.keys(answers).length === 0 && (
          <p className="mt-2 text-sm text-ink-faint">Your answers appear here as you go.</p>
        )}
      </aside>

      <p className="mt-6 text-sm text-ink-faint">{template.disclosureText}</p>
    </div>
  )
}
