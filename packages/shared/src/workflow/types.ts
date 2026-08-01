/**
 * Workflow definitions: the procedural state machine for one case type in one
 * jurisdiction, stored as JSON so new case types and states are content, not code.
 *
 * Definitions are versioned and immutable once published. A case pins the version it
 * opened on and rides it to close — editing a live definition must never move the goal
 * posts under a litigant who has already been told what happens next.
 */

import type { DeadlineRule, Verification } from '../deadlines/types.js'

export type CaseTypeKey = 'debt_defense' | 'small_claims' | 'eviction_tenant' | (string & {})
export type CourtLevel = 'magistrate' | 'district' | 'superior' | 'federal'
export type PartyRole = 'plaintiff' | 'defendant'
export type WorkflowStatus = 'draft' | 'live'

export interface RequiredDocument {
  /** Matches `document_templates.key`. */
  templateKey: string
  title: string
  required: boolean
  /** Why this document matters, in plain language. */
  purpose: string
}

export interface WorkflowStage {
  key: string
  title: string
  /** 6th-grade reading level. Shown as the body of the timeline entry and Next Action card. */
  plainLanguageExplainer: string
  /** The deadline that governs this stage, if any. Stages like "case closed" have none. */
  deadlineRule?: DeadlineRule | null
  requiredDocuments: RequiredDocument[]
  /** Court fee in cents. `null` when there is no fee; `0` means explicitly free. */
  courtFeeCents?: number | null
  /** Stage keys reachable from here. Empty means terminal. */
  next: string[]
  /** Only reachable for these party roles. Omit for "both". */
  appliesToRoles?: PartyRole[]
  /** True when reaching this stage ends the case. */
  terminal?: boolean
}

export interface WorkflowDefinition {
  caseTypeKey: CaseTypeKey
  jurisdictionKey: string
  courtLevel: CourtLevel
  version: number
  status: WorkflowStatus
  title: string
  /** Plain-language summary of the whole process, shown at the top of the case portal. */
  overview: string
  initialStageKey: string
  stages: WorkflowStage[]
  verification: Verification
  publishedAt?: string
  publishedBy?: string
}

export type IssueSeverity = 'error' | 'warning'

export interface ValidationIssue {
  severity: IssueSeverity
  code: string
  message: string
  /** Dotted path into the definition, e.g. `stages[2].next[0]`. */
  path: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

export type StageStatus = 'pending' | 'current' | 'complete' | 'skipped'
