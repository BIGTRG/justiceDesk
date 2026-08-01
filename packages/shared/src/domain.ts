/**
 * Domain types shared by every service and the web app. These mirror the Postgres schema
 * in db/migrations — when a column changes, change it here in the same commit.
 */

import type { PlainDate } from './dates.js'
import type { ServiceMethod } from './deadlines/types.js'
import type { CaseTypeKey, CourtLevel, PartyRole } from './workflow/types.js'

export type UserRole = 'litigant' | 'attorney' | 'admin'
export type CaseStatus = 'draft' | 'active' | 'closed'
export type DocumentKind = 'generated' | 'uploaded' | 'filed'
export type DocumentStatus = 'draft' | 'final' | 'filed'
export type TemplateSource = 'aoc_form' | 'ai_freeform'
export type PlanKind = 'monthly' | 'one_shot'
export type PlanStatus = 'live' | 'draft'
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'incomplete' | 'trialing'
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded'
export type DeadlineStatus = 'pending' | 'met' | 'missed' | 'waived'
export type InterviewStatus = 'in_progress' | 'complete' | 'abandoned'

export interface User {
  id: string
  phone: string | null
  email: string | null
  name: string | null
  role: UserRole
  createdAt: string
}

export interface Jurisdiction {
  id: string
  state: string
  county: string
  courtLevel: CourtLevel
  efileSupported: boolean
  filingAddresses: {
    clerkOfCourt?: { name: string; street: string; city: string; state: string; zip: string }
    phone?: string
    hours?: string
  }
}

export interface CaseRecord {
  id: string
  userId: string
  caseTypeId: string
  jurisdictionId: string
  courtCaseNumber: string | null
  role: PartyRole
  status: CaseStatus
  currentStageKey: string
  /** The workflow_definitions row this case is pinned to. Never changes after open. */
  workflowDefinitionId: string
  openedAt: string
  closedAt: string | null
  outcome: string | null
  metadata: CaseMetadata
}

/** Case facts gathered from intake, OCR and interviews. Anchors the deadline calculator. */
export interface CaseMetadata {
  anchors?: Partial<Record<string, PlainDate>>
  serviceMethod?: ServiceMethod
  opposingParty?: string
  amountClaimedCents?: number
  courtName?: string
  /** Free-form notes captured during intake, never shown as legal conclusions. */
  intakeSummary?: string
  [key: string]: unknown
}

export interface CaseTypeRecord {
  id: string
  key: CaseTypeKey
  name: string
  description: string
  active: boolean
}

export interface DocumentRecord {
  id: string
  caseId: string
  kind: DocumentKind
  templateId: string | null
  title: string
  minioKey: string
  version: number
  status: DocumentStatus
  watermark: boolean
  createdAt: string
}

export interface DocumentTemplate {
  id: string
  caseTypeId: string
  jurisdictionId: string
  key: string
  name: string
  source: TemplateSource
  formPdfMinioKey: string | null
  /** Maps interview answer paths to AcroForm field names. Only for `aoc_form`. */
  fieldMap: Record<string, string>
  /** JSON Schema-ish description of the guided interview (S7). */
  interviewSchema: InterviewSchema
  disclosureText: string
}

export type InterviewQuestionType =
  | 'short_text'
  | 'long_text'
  | 'date'
  | 'money'
  | 'yes_no'
  | 'single_select'
  | 'multi_select'

export interface InterviewQuestion {
  key: string
  type: InterviewQuestionType
  /** One question per screen, at a 6th-grade reading level. */
  prompt: string
  helpText?: string
  required: boolean
  options?: Array<{ value: string; label: string; helpText?: string }>
  /** Show only when this expression over prior answers is true. */
  showIf?: { questionKey: string; equals: string | boolean }
  /** Legal terms in this question that get tap-to-define treatment. */
  glossaryTerms?: string[]
  validation?: { minLength?: number; maxLength?: number; min?: number; max?: number }
}

export interface InterviewSchema {
  version: number
  questions: InterviewQuestion[]
}

export interface Plan {
  id: string
  caseTypeId: string
  kind: PlanKind
  priceCents: number
  name: string
  stripePriceId: string | null
  status: PlanStatus
}

export interface DeadlineRecord {
  id: string
  caseId: string
  title: string
  dueDate: PlainDate
  ruleSource: string
  reminderSchedule: { offsetsDays: number[]; sentOffsets: number[] }
  status: DeadlineStatus
}

export interface AuditLogEntry {
  id: string
  actorId: string | null
  action: string
  entity: string
  entityId: string | null
  ip: string | null
  ts: string
  metadata?: Record<string, unknown>
}

/** Actions that must always produce an audit row. Enforced in svc-api. */
export const AUDITED_ACTIONS = [
  'document.view',
  'document.download',
  'document.print',
  'document.create',
  'document.finalize',
  'document.delete',
  'case.create',
  'case.close',
  'case.stage_advance',
  'ai.conversation',
  'ai.upl_flag',
  'plan.change',
  'payment.succeeded',
  'admin.workflow_publish',
  'admin.template_upload',
  'admin.upl_review',
] as const

export type AuditedAction = (typeof AUDITED_ACTIONS)[number]
