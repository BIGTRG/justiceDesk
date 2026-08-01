/**
 * Typed client for svc-api.
 *
 * Every call carries the Clerk session token. Errors surface the API's user-facing
 * message, which is written for a litigant, not a developer.
 */

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4101'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token: string | null }
): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'unknown',
      payload?.error?.message ?? 'Something went wrong. Please try again.'
    )
  }

  return (await response.json()) as T
}

export interface DeadlineView {
  ruleKey: string
  title: string
  dueDate: string
  source: { citation: string; summary: string }
  warnings: string[]
  jurisdictional: boolean
  steps: Array<{ label: string; date: string; detail?: string }>
}

export interface TimelineEntryView {
  stageKey: string
  title: string
  plainLanguageExplainer: string
  status: 'pending' | 'current' | 'complete' | 'skipped'
  courtFeeCents: number | null
  requiredDocuments: Array<{ templateKey: string; title: string; required: boolean; purpose: string }>
  deadline: DeadlineView | null
  blockedOnFact: string | null
  urgency: 'overdue' | 'due_today' | 'critical' | 'soon' | 'upcoming' | null
  terminal: boolean
  contentWarnings: string[]
}

export interface NextActionView {
  stageKey: string
  title: string
  explainer: string
  dueDate: string | null
  urgency: TimelineEntryView['urgency']
  requiredDocuments: TimelineEntryView['requiredDocuments']
  courtFeeCents: number | null
  needsFact: string | null
  warnings: string[]
}

export interface CaseView {
  case: {
    id: string
    status: string
    role: string
    courtCaseNumber: string | null
    currentStageKey: string
    caseTypeKey: string
    jurisdictionKey: string
    metadata: Record<string, unknown>
  }
  title: string
  overview: string
  today: string
  timeline: TimelineEntryView[]
  nextAction: NextActionView | null
}

export const api = {
  listCases: (token: string) => request<{ cases: unknown[] }>('/v1/cases', { token }),

  createCase: (token: string, body: { caseTypeKey: string; jurisdictionKey: string; role: string }) =>
    request<{ caseId: string }>('/v1/cases', { method: 'POST', body, token }),

  getCase: (token: string, caseId: string) => request<CaseView>(`/v1/cases/${caseId}`, { token }),

  saveFacts: (token: string, caseId: string, body: Record<string, unknown>) =>
    request<{ timeline: TimelineEntryView[]; nextAction: NextActionView | null; today: string }>(
      `/v1/cases/${caseId}/facts`,
      { method: 'POST', body, token }
    ),

  advance: (token: string, caseId: string, toStageKey: string) =>
    request<{ currentStageKey: string; isTerminal: boolean }>(`/v1/cases/${caseId}/advance`, {
      method: 'POST',
      body: { toStageKey },
      token,
    }),

  closeCase: (token: string, caseId: string, outcome: string) =>
    request<{ closed: boolean; activeSubscriptions: Array<{ id: string }> }>(
      `/v1/cases/${caseId}/close`,
      { method: 'POST', body: { outcome }, token }
    ),

  deadlines: (token: string, caseId: string) =>
    request<{ today: string; deadlines: Array<Record<string, unknown>> }>(
      `/v1/cases/${caseId}/deadlines`,
      { token }
    ),

  documents: (token: string, caseId: string) =>
    request<{ documents: Array<Record<string, unknown>> }>(`/v1/cases/${caseId}/documents`, { token }),

  downloadUrl: (token: string, caseId: string, documentId: string, intent: 'view' | 'download' | 'print') =>
    request<{ url: string; filename: string }>(
      `/v1/cases/${caseId}/documents/${documentId}/download`,
      { method: 'POST', body: { intent }, token }
    ),

  startInterview: (token: string, caseId: string, templateKey: string) =>
    request<{ interviewId: string; template: Record<string, unknown> }>(
      `/v1/cases/${caseId}/interviews`,
      { method: 'POST', body: { templateKey }, token }
    ),

  saveAnswers: (token: string, caseId: string, interviewId: string, answers: Record<string, unknown>) =>
    request<{ saved: boolean }>(`/v1/cases/${caseId}/interviews/${interviewId}`, {
      method: 'PATCH',
      body: { answers },
      token,
    }),

  completeInterview: (token: string, caseId: string, interviewId: string) =>
    request<{ queued: boolean }>(`/v1/cases/${caseId}/interviews/${interviewId}/complete`, {
      method: 'POST',
      token,
    }),

  chat: (token: string, caseId: string, question: string) =>
    request<{ reply: string; blocked: boolean }>(`/v1/cases/${caseId}/chat`, {
      method: 'POST',
      body: { question },
      token,
    }),

  classifyIntake: (token: string | null, transcript: Array<{ role: string; content: string }>) =>
    request<{ classification: Record<string, unknown> }>('/v1/intake/classify', {
      method: 'POST',
      body: { transcript },
      token,
    }),

  readSummons: (token: string, imageBase64: string, mediaType: string) =>
    request<{ extraction: Record<string, unknown> }>('/v1/intake/summons', {
      method: 'POST',
      body: { imageBase64, mediaType },
      token,
    }),

  plans: (token: string, caseTypeKey: string) =>
    request<{ plans: Array<Record<string, unknown>>; paymentsLive: boolean }>(
      `/v1/plans?caseTypeKey=${encodeURIComponent(caseTypeKey)}`,
      { token }
    ),

  checkout: (token: string, planId: string, caseId: string) =>
    request<{ checkoutUrl: string }>('/v1/billing/checkout', {
      method: 'POST',
      body: { planId, caseId },
      token,
    }),
}

export function formatMoney(cents: number | null | undefined): string {
  if (cents == null) return '—'
  if (cents === 0) return 'No fee'
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`
}

/** Dates are rendered in the court's terms, never localised away from the filing date. */
export function formatDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}
