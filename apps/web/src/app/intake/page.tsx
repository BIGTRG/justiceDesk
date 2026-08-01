'use client'

/**
 * S3 — AI intake chat with summons photo upload.
 * S4 — the OCR confirm card.
 *
 * The confirm step is the important part. Nothing OCR reads is written to the case until
 * the litigant has looked at each field and said it is right. A misread hearing date that
 * silently became a deadline is the worst bug this flow could have.
 */

import { useAuth } from '@clerk/nextjs'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { api } from '@/lib/api'
import { UnverifiedContentBanner } from '@/components/Disclosure'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface Extraction {
  courtCaseNumber: string | null
  courtName: string | null
  county: string | null
  plaintiffName: string | null
  defendantName: string | null
  hearingDate: string | null
  summonsIssuedDate: string | null
  servedDate: string | null
  documentType: string | null
  legibilityNotes: string
}

const FIELD_LABELS: Array<[keyof Extraction, string, string]> = [
  ['courtCaseNumber', 'Case number', 'Top right of the first page'],
  ['courtName', 'Court', ''],
  ['county', 'County', ''],
  ['plaintiffName', 'Who is suing', ''],
  ['defendantName', 'Who is being sued', ''],
  ['servedDate', 'Date you were served', 'The day the papers reached you'],
  ['summonsIssuedDate', 'Date the summons was issued', ''],
  ['hearingDate', 'Hearing date', 'If one is printed on the papers'],
]

export default function IntakePage() {
  const { getToken, isSignedIn } = useAuth()
  const router = useRouter()
  const params = useSearchParams()

  const seed = params.get('q') ?? ''
  const [messages, setMessages] = useState<Message[]>(
    seed ? [{ role: 'user', content: seed }] : []
  )
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [classification, setClassification] = useState<Record<string, unknown> | null>(null)
  const [extraction, setExtraction] = useState<Extraction | null>(null)
  const [confirmed, setConfirmed] = useState<Record<string, string>>({})

  async function send(content: string) {
    setError(null)
    setBusy(true)
    const next = [...messages, { role: 'user' as const, content }]
    setMessages(next)
    setDraft('')

    try {
      const token = await getToken()
      const result = await api.classifyIntake(token, next)
      const c = result.classification as Record<string, unknown>
      setClassification(c)

      const question = String(c.nextQuestion ?? '')
      const summary = String(c.summary ?? '')
      setMessages([...next, { role: 'assistant', content: question || summary }])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function uploadPhoto(file: File) {
    setError(null)
    setBusy(true)
    try {
      const token = await getToken()
      if (!token) {
        router.push('/sign-in')
        return
      }
      const base64 = await fileToBase64(file)
      const result = await api.readSummons(token, base64, file.type || 'image/jpeg')
      const data = result.extraction as unknown as Extraction
      setExtraction(data)
      // Pre-fill the confirm form, but nothing is saved until the litigant submits it.
      setConfirmed(
        Object.fromEntries(
          FIELD_LABELS.map(([key]) => [key, (data[key] as string | null) ?? ''])
        )
      )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function createCase() {
    setBusy(true)
    setError(null)
    try {
      const token = await getToken()
      if (!token) {
        router.push('/sign-in')
        return
      }

      const caseTypeKey = String(classification?.caseType ?? '')
      const jurisdictionKey =
        caseTypeKey === 'debt_defense' ? 'NC-WAKE-DISTRICT' : 'NC-WAKE-MAGISTRATE'

      const { caseId } = await api.createCase(token, {
        caseTypeKey,
        jurisdictionKey,
        role: String(classification?.role ?? 'defendant'),
      })

      const anchors: Record<string, string> = {}
      if (confirmed.servedDate) anchors.service_date = confirmed.servedDate
      if (confirmed.summonsIssuedDate) anchors.summons_issued_date = confirmed.summonsIssuedDate
      if (confirmed.hearingDate) anchors.hearing_date = confirmed.hearingDate

      await api.saveFacts(token, caseId, {
        anchors,
        courtCaseNumber: confirmed.courtCaseNumber || undefined,
        opposingParty: confirmed.plaintiffName || undefined,
        courtName: confirmed.courtName || undefined,
      })

      router.push(`/cases/${caseId}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const readyToOpen =
    classification &&
    ['debt_defense', 'small_claims', 'eviction_tenant'].includes(String(classification.caseType))

  // ---------------------------------------------------------------- S4
  if (extraction) {
    return (
      <div className="container-readable py-8">
        <h1 className="text-2xl font-bold">Check what we read</h1>
        <p className="mt-2 text-ink-muted">
          We read these from your photo. Please check each one against your papers and fix anything
          that is wrong. Your dates depend on these being right.
        </p>

        {extraction.legibilityNotes && (
          <div className="mt-4">
            <UnverifiedContentBanner warnings={[extraction.legibilityNotes]} />
          </div>
        )}

        <form
          className="mt-6 space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            void createCase()
          }}
        >
          {FIELD_LABELS.map(([key, label, hint]) => {
            const isDate = key.toLowerCase().includes('date')
            const wasBlank = !extraction[key]
            return (
              <div key={key}>
                <label htmlFor={key} className="label">
                  {label}
                  {wasBlank && (
                    <span className="ml-2 text-sm font-normal text-warn">
                      we could not read this
                    </span>
                  )}
                </label>
                {hint && <p className="-mt-1 mb-2 text-sm text-ink-faint">{hint}</p>}
                <input
                  id={key}
                  type={isDate ? 'date' : 'text'}
                  className="field"
                  value={confirmed[key] ?? ''}
                  onChange={(e) => setConfirmed({ ...confirmed, [key]: e.target.value })}
                />
              </div>
            )
          })}

          {error && <p className="text-urgent">{error}</p>}

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Setting up your case…' : 'These look right — open my case'}
          </button>
          <button
            type="button"
            className="btn-secondary w-full"
            onClick={() => setExtraction(null)}
          >
            Go back
          </button>
        </form>
      </div>
    )
  }

  // ---------------------------------------------------------------- S3
  return (
    <div className="container-readable py-8">
      <h1 className="text-2xl font-bold">Tell us what happened</h1>

      <div className="mt-6 space-y-4" role="log" aria-live="polite">
        {messages.map((message, i) => (
          <div
            key={i}
            className={
              message.role === 'user'
                ? 'ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-brand px-4 py-3 text-white'
                : 'mr-auto max-w-[90%] rounded-xl rounded-bl-sm bg-paper-sunk px-4 py-3'
            }
          >
            {message.content}
          </div>
        ))}
        {busy && <p className="text-ink-faint">Thinking…</p>}
      </div>

      {error && <p className="mt-4 text-urgent">{error}</p>}

      {readyToOpen ? (
        <div className="card mt-6">
          <h2 className="font-bold">We think this is the right process</h2>
          <p className="mt-2 text-ink-muted">{String(classification?.summary ?? '')}</p>
          <button className="btn-primary mt-4 w-full" onClick={() => void createCase()} disabled={busy}>
            Open my case
          </button>
        </div>
      ) : (
        <form
          className="mt-6"
          onSubmit={(e) => {
            e.preventDefault()
            if (draft.trim()) void send(draft.trim())
          }}
        >
          <label htmlFor="reply" className="label">
            Your answer
          </label>
          <textarea
            id="reply"
            rows={3}
            className="field"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="btn-primary mt-3 w-full" disabled={busy || !draft.trim()}>
            Send
          </button>
        </form>
      )}

      <div className="card mt-8">
        <h2 className="font-bold">Have the papers with you?</h2>
        <p className="mt-1 text-ink-muted">
          Take a photo of the first page. We will read the dates and the case number, then ask you
          to check them.
        </p>
        <label className="btn-secondary mt-3 w-full cursor-pointer">
          Take or choose a photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            disabled={busy || !isSignedIn}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void uploadPhoto(file)
            }}
          />
        </label>
        {!isSignedIn && (
          <p className="mt-2 text-sm text-ink-faint">Sign in first so we can save your case.</p>
        )}
      </div>
    </div>
  )
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      // Strip the data: prefix — the API takes bare base64.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('We could not read that photo. Please try again.'))
    reader.readAsDataURL(file)
  })
}
