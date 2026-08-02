'use client'

/**
 * S9 — documents vault.
 * S8 — the review / print / filing-instructions view, rendered as a modal from here.
 *
 * Documents are never embedded from a stored URL. Every view, print and download asks the
 * API for a fresh short-lived signed URL, and the API writes an audit row before minting
 * it — so a document cannot be opened without a record of who opened it.
 */

import { useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { api, formatDate } from '@/lib/api'

interface Doc {
  id: string
  kind: string
  title: string
  version: number
  status: string
  watermark: boolean
  byteSize: number | null
  createdAt: string
}

export default function DocumentsPage({ params }: { params: { caseId: string } }) {
  const { getToken } = useAuth()
  const [documents, setDocuments] = useState<Doc[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [instructionsFor, setInstructionsFor] = useState<Doc | null>(null)

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      if (!token) return
      const data = await api.documents(token, params.caseId)
      setDocuments(data.documents as unknown as Doc[])
    } catch (err) {
      setError((err as Error).message)
    }
  }, [getToken, params.caseId])

  useEffect(() => {
    void load()
    // Rendering happens in a background job, so poll while one may still be in flight.
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [load])

  async function open(doc: Doc, intent: 'view' | 'download' | 'print') {
    setBusyId(doc.id)
    try {
      const token = await getToken()
      if (!token) return
      const { url } = await api.downloadUrl(token, params.caseId, doc.id, intent)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="container-readable py-8">
      <Link href={`/cases/${params.caseId}`} className="text-brand underline">
        ← Back to my case
      </Link>
      <h1 className="mt-4 text-2xl">My documents</h1>
      <p className="mt-2 text-ink-muted">
        Everything you have made or uploaded. Drafts are watermarked until you are ready to file.
      </p>

      {error && <p className="mt-4 text-urgent">{error}</p>}

      {documents.length === 0 ? (
        <div className="card mt-6">
          <p className="text-ink-muted">
            No documents yet. When you finish a set of questions, your document appears here — it
            usually takes a few seconds.
          </p>
        </div>
      ) : (
        <ul className="mt-6 space-y-4">
          {documents.map((doc) => (
            <li key={doc.id} className="card">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg">{doc.title}</h2>
                  <p className="text-sm text-ink-muted">
                    Version {doc.version} · {formatDate(doc.createdAt.slice(0, 10))}
                  </p>
                </div>
                {doc.status === 'draft' && (
                  <span className="shrink-0 rounded-full bg-warn-light px-3 py-1 text-sm font-semibold text-warn">
                    Draft
                  </span>
                )}
                {doc.status === 'filed' && (
                  <span className="shrink-0 rounded-full bg-ok-light px-3 py-1 text-sm font-semibold text-ok">
                    Filed
                  </span>
                )}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  className="btn-secondary flex-1"
                  disabled={busyId === doc.id}
                  onClick={() => void open(doc, 'view')}
                >
                  Read it
                </button>
                <button
                  className="btn-secondary flex-1"
                  disabled={busyId === doc.id}
                  onClick={() => void open(doc, 'print')}
                >
                  Print
                </button>
                <button
                  className="btn-secondary flex-1"
                  disabled={busyId === doc.id}
                  onClick={() => void open(doc, 'download')}
                >
                  Download
                </button>
              </div>

              <button
                className="btn-primary mt-3 w-full"
                onClick={() => setInstructionsFor(doc)}
              >
                How do I file this?
              </button>
            </li>
          ))}
        </ul>
      )}

      {instructionsFor && (
        <FilingInstructions doc={instructionsFor} onClose={() => setInstructionsFor(null)} />
      )}
    </div>
  )
}

/** S8 — filing instructions. Procedure only; never what to file or whether to. */
function FilingInstructions({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="filing-heading"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
    >
      <div className="max-h-[90dvh] w-full max-w-readable overflow-y-auto rounded-t-2xl bg-paper-card p-6 sm:rounded-2xl">
        <h2 id="filing-heading" className="text-xl">
          Filing {doc.title}
        </h2>

        <ol className="mt-4 space-y-4">
          <li>
            <span className="font-semibold">1. Print it.</span>
            <p className="text-ink-muted">
              Print the document plus one copy for the other side, and one for yourself.
            </p>
          </li>
          <li>
            <span className="font-semibold">2. Sign it.</span>
            <p className="text-ink-muted">
              Sign and date where the signature line is. You must sign it yourself — JusticeDesk
              cannot sign or file anything for you.
            </p>
          </li>
          <li>
            <span className="font-semibold">3. Take it to the Clerk of Court.</span>
            <p className="text-ink-muted">
              File it at the courthouse for the county on your papers. Ask the clerk to stamp your
              copy so you have proof of the date.
            </p>
          </li>
          <li>
            <span className="font-semibold">4. Send a copy to the other side.</span>
            <p className="text-ink-muted">
              Ask the clerk what your county requires for this. Keep proof of what you sent and when.
            </p>
          </li>
        </ol>

        <div className="mt-5 rounded-lg bg-warn-light p-4 text-sm text-warn">
          <p className="font-semibold">Before you go</p>
          <p className="mt-1">
            The courthouse address and hours in this app have not been verified yet. Check them on
            the North Carolina Judicial Branch website or call the clerk before you travel.
          </p>
        </div>

        <button className="btn-primary mt-6 w-full" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  )
}
