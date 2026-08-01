'use client'

/**
 * Admin console (Phase 1, minimal): pricing board, workflow editor, template manager and
 * the UPL review queue, in one screen with tabs.
 *
 * Built for a small internal team, so it is deliberately plain: dense, no styling
 * flourishes, and every destructive-ish action states its consequence before you take it.
 */

import { useAuth } from '@clerk/nextjs'
import { useCallback, useEffect, useState } from 'react'

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4101'

type Tab = 'plans' | 'workflows' | 'templates' | 'flags'

export default function AdminPage() {
  const { getToken } = useAuth()
  const [tab, setTab] = useState<Tab>('flags')
  const [data, setData] = useState<Record<string, unknown[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const call = useCallback(
    async (path: string, init?: RequestInit) => {
      const token = await getToken()
      const response = await fetch(`${BASE}/v1/admin${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error((payload as { error?: { message?: string } }).error?.message ?? 'Request failed')
      }
      return payload as Record<string, unknown[]>
    },
    [getToken]
  )

  const load = useCallback(
    async (which: Tab) => {
      setError(null)
      try {
        const path =
          which === 'plans'
            ? '/plans'
            : which === 'workflows'
              ? '/workflows'
              : which === 'templates'
                ? '/templates'
                : '/upl-flags'
        setData(await call(path))
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [call]
  )

  useEffect(() => {
    void load(tab)
  }, [tab, load])

  async function reviewFlag(id: string) {
    setBusy(true)
    try {
      await call(`/upl-flags/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ notes: 'Reviewed in admin console.' }),
      })
      await load('flags')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const tabs: Array<[Tab, string]> = [
    ['flags', 'UPL review'],
    ['plans', 'Pricing'],
    ['workflows', 'Workflows'],
    ['templates', 'Templates'],
  ]

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold">JusticeDesk admin</h1>

      <nav className="mt-4 flex flex-wrap gap-2" aria-label="Admin sections">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={tab === key ? 'btn-primary' : 'btn-secondary'}
            aria-current={tab === key ? 'page' : undefined}
          >
            {label}
          </button>
        ))}
      </nav>

      {error && <p className="mt-4 text-urgent">{error}</p>}

      {tab === 'flags' && (
        <section className="mt-6">
          <h2 className="text-lg font-bold">Unreviewed guardrail findings</h2>
          <p className="text-sm text-ink-muted">
            Blocked responses first. Reviewing does not un-block anything — the litigant already saw
            the substitute message.
          </p>
          <ul className="mt-4 space-y-3">
            {(data.flags ?? []).map((raw) => {
              const flag = raw as Record<string, string | boolean>
              return (
                <li key={String(flag.id)} className="card">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <code className="text-sm font-semibold">{String(flag.code)}</code>
                      <span
                        className={
                          flag.blocked
                            ? 'ml-2 rounded bg-urgent px-2 py-0.5 text-xs font-semibold text-white'
                            : 'ml-2 rounded bg-warn-light px-2 py-0.5 text-xs font-semibold text-warn'
                        }
                      >
                        {flag.blocked ? 'blocked' : String(flag.severity)}
                      </span>
                    </div>
                    <button
                      className="btn-secondary"
                      disabled={busy}
                      onClick={() => void reviewFlag(String(flag.id))}
                    >
                      Mark reviewed
                    </button>
                  </div>
                  <p className="mt-2 text-sm">{String(flag.reason)}</p>
                  {flag.excerpt && (
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-paper-sunk p-3 text-sm">
                      {String(flag.excerpt)}
                    </pre>
                  )}
                  <p className="mt-2 text-xs text-ink-faint">Case {String(flag.caseId)}</p>
                </li>
              )
            })}
            {(data.flags ?? []).length === 0 && (
              <li className="text-ink-muted">Nothing waiting for review.</li>
            )}
          </ul>
        </section>
      )}

      {tab === 'plans' && (
        <section className="mt-6">
          <h2 className="text-lg font-bold">Pricing board</h2>
          <p className="text-sm text-ink-muted">
            A live plan&apos;s price is frozen. Changing a price publishes a new plan and retires the
            old one — existing subscribers keep what they signed up on.
          </p>
          <table className="mt-4 w-full text-sm">
            <thead className="border-b border-paper-edge text-left">
              <tr>
                <th className="py-2">Case type</th>
                <th>Kind</th>
                <th>Price</th>
                <th>Status</th>
                <th>Subscribers</th>
              </tr>
            </thead>
            <tbody>
              {(data.plans ?? []).map((raw) => {
                const plan = raw as Record<string, string | number>
                return (
                  <tr key={String(plan.id)} className="border-b border-paper-edge">
                    <td className="py-2">{String(plan.caseTypeKey)}</td>
                    <td>{String(plan.kind)}</td>
                    <td>${(Number(plan.priceCents) / 100).toFixed(2)}</td>
                    <td>{String(plan.status)}</td>
                    <td>{String(plan.subscriberCount)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'workflows' && (
        <section className="mt-6">
          <h2 className="text-lg font-bold">Workflow definitions</h2>
          <p className="text-sm text-ink-muted">
            Publishing creates a new version. Cases already open stay on the version they started
            with.
          </p>
          <ul className="mt-4 space-y-3">
            {(data.workflows ?? []).map((raw) => {
              const wf = raw as Record<string, string | number | { status?: string }>
              const verification = wf.verification as { status?: string }
              return (
                <li key={String(wf.id)} className="card">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">
                      {String(wf.caseTypeKey)} / {String(wf.jurisdictionKey)} v{String(wf.version)}
                    </span>
                    <span className="rounded bg-paper-sunk px-2 py-0.5 text-xs">{String(wf.status)}</span>
                    {verification?.status !== 'attorney_verified' && (
                      <span className="rounded bg-warn-light px-2 py-0.5 text-xs font-semibold text-warn">
                        unverified
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-ink-faint">{String(wf.caseCount)} case(s) pinned</p>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {tab === 'templates' && (
        <section className="mt-6">
          <h2 className="text-lg font-bold">Document templates</h2>
          <p className="text-sm text-ink-muted">
            A template whose field map still has PLACEHOLDER_ names cannot be marked verified, and
            the renderer refuses to fill it.
          </p>
          <ul className="mt-4 space-y-3">
            {(data.templates ?? []).map((raw) => {
              const t = raw as Record<string, unknown>
              const fieldMap = (t.fieldMap ?? {}) as Record<string, string>
              const placeholders = Object.values(fieldMap).filter((v) =>
                String(v).startsWith('PLACEHOLDER_')
              ).length
              const verification = t.verification as { status?: string }
              return (
                <li key={String(t.id)} className="card">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{String(t.key)}</span>
                    <span className="rounded bg-paper-sunk px-2 py-0.5 text-xs">{String(t.source)}</span>
                    {verification?.status !== 'attorney_verified' && (
                      <span className="rounded bg-warn-light px-2 py-0.5 text-xs font-semibold text-warn">
                        unverified
                      </span>
                    )}
                    {placeholders > 0 && (
                      <span className="rounded bg-urgent-light px-2 py-0.5 text-xs font-semibold text-urgent">
                        {placeholders} placeholder field(s)
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-ink-muted">{String(t.name)}</p>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
