/**
 * The guardrail pipeline — "no raw model passthrough" made mechanical.
 *
 * Every byte the model produces reaches a litigant through this function and no other
 * path. The routes do not have the option of skipping it: they never see the raw text,
 * only a `GuardrailResult`.
 *
 * Order matters and is not arbitrary:
 *   1. deterministic UPL scan   — cheap, cannot be talked out of firing
 *   2. citation enforcement     — strip for chat, hard-fail for documents
 *   3. model-based classifier   — catches implied advice the patterns miss
 *   4. disclosure footer        — appended last so it cannot be stripped by step 2
 *
 * Layers only ever add restrictions. A clean classifier verdict cannot clear a response
 * the pattern scan blocked.
 */

import {
  checkCitations,
  scanForUpl,
  stripUncuratedCitations,
  UPL_BLOCK_MESSAGE,
  withDisclosure,
  type CitationLibrary,
  type CitationViolation,
  type DisclosureConfig,
  type UplFinding,
} from '@justicedesk/shared'
import type { Classifier, ClassifierVerdict } from './classifier.js'

export type Surface = 'assistant' | 'intake' | 'interview_draft'

/**
 * What to do about a citation that is not in the curated library.
 *
 * `strip` — conversational surfaces. A sentence minus its citation is still useful.
 * `reject` — anything destined for a court filing. A document with a hole where its
 *   authority should be is worse than no document, and a wrong citation in a filing is
 *   the failure mode that gets a pro se litigant's paper struck.
 */
export type CitationPolicy = 'strip' | 'reject'

export interface GuardrailOptions {
  surface: Surface
  library: CitationLibrary
  disclosure: DisclosureConfig
  citationPolicy: CitationPolicy
  classifier: Classifier
  /** The litigant's question, passed to the classifier for context. */
  question?: string
  /** Skip the disclosure footer — used for document body text, which carries its own. */
  omitDisclosure?: boolean
}

export type GuardrailOutcome = 'passed' | 'repaired' | 'blocked'

export interface GuardrailResult {
  outcome: GuardrailOutcome
  /** The text safe to show. Null when blocked. */
  text: string | null
  /** Shown to the litigant in place of a blocked response. */
  blockedMessage: string | null
  findings: UplFinding[]
  citationViolations: CitationViolation[]
  verdict: ClassifierVerdict
  /** True when anything here should land in the upl_flags review queue. */
  requiresReview: boolean
  reviewReasons: string[]
}

/** Confidence below this, even on a "clean" verdict, still goes to a human. */
export const CLASSIFIER_REVIEW_CONFIDENCE = 0.6

export async function applyGuardrails(
  rawText: string,
  options: GuardrailOptions
): Promise<GuardrailResult> {
  const reviewReasons: string[] = []

  // ---- 1. deterministic scan -------------------------------------------------
  const scan = scanForUpl(rawText)
  if (scan.flagged) {
    reviewReasons.push(
      `Pattern guardrail matched: ${[...new Set(scan.findings.map((f) => f.code))].join(', ')}.`
    )
  }

  // ---- 2. citations ----------------------------------------------------------
  const citationCheck = checkCitations(rawText, options.library)
  let workingText = rawText
  let repaired = false

  if (!citationCheck.ok) {
    reviewReasons.push(
      `Uncurated citation(s) emitted: ${citationCheck.violations.map((v) => v.text).join(', ')}.`
    )
    if (options.citationPolicy === 'reject') {
      return blocked(
        scan.findings,
        citationCheck.violations,
        {
          crossesLine: false,
          category: 'none',
          rationale: 'Not reached — blocked on citation policy.',
          confidence: 1,
        },
        reviewReasons,
        'This document could not be prepared because the draft cited a source we cannot verify. ' +
          'Nothing has been saved. Please try again, or ask for an attorney to prepare this section.'
      )
    }
    const stripped = stripUncuratedCitations(workingText, options.library)
    workingText = stripped.text
    repaired = true
  }

  // A block-severity pattern match ends it here — before spending a classifier call.
  if (scan.blocked) {
    return blocked(
      scan.findings,
      citationCheck.violations,
      {
        crossesLine: true,
        category: 'directive_advice',
        rationale: 'Not reached — blocked by the deterministic pattern layer.',
        confidence: 1,
      },
      reviewReasons,
      UPL_BLOCK_MESSAGE
    )
  }

  // ---- 3. model-based classifier ---------------------------------------------
  const verdict = await options.classifier(workingText, options.question)

  if (verdict.crossesLine) {
    reviewReasons.push(`Classifier: ${verdict.category} — ${verdict.rationale}`)
    return blocked(scan.findings, citationCheck.violations, verdict, reviewReasons, UPL_BLOCK_MESSAGE)
  }

  if (verdict.confidence < CLASSIFIER_REVIEW_CONFIDENCE) {
    // Not blocked, but not confidently clear either — a human looks at it after the fact.
    reviewReasons.push(
      `Classifier was unsure (confidence ${verdict.confidence.toFixed(2)}): ${verdict.rationale}`
    )
  }

  // ---- 4. disclosure ---------------------------------------------------------
  const finalText = options.omitDisclosure
    ? workingText
    : withDisclosure(workingText, options.disclosure)

  return {
    outcome: repaired ? 'repaired' : 'passed',
    text: finalText,
    blockedMessage: null,
    findings: scan.findings,
    citationViolations: citationCheck.violations,
    verdict,
    requiresReview: reviewReasons.length > 0,
    reviewReasons,
  }
}

function blocked(
  findings: UplFinding[],
  citationViolations: CitationViolation[],
  verdict: ClassifierVerdict,
  reviewReasons: string[],
  message: string
): GuardrailResult {
  return {
    outcome: 'blocked',
    // The blocked text is never returned to the caller — it exists only in the flag row.
    text: null,
    blockedMessage: message,
    findings,
    citationViolations,
    verdict,
    requiresReview: true,
    reviewReasons,
  }
}

/** Rows to write to `upl_flags`. svc-api persists these. */
export interface FlagRow {
  code: string
  severity: 'block' | 'review' | 'note'
  reason: string
  excerpt: string | null
  blocked: boolean
}

export function flagRowsFor(result: GuardrailResult): FlagRow[] {
  const rows: FlagRow[] = result.findings.map((f) => ({
    code: f.code,
    severity: f.severity,
    reason: f.reason,
    excerpt: f.excerpt,
    blocked: result.outcome === 'blocked' && f.severity === 'block',
  }))

  for (const v of result.citationViolations) {
    rows.push({
      code: 'citation.uncurated',
      severity: result.outcome === 'blocked' ? 'block' : 'review',
      reason: v.reason,
      excerpt: v.text,
      blocked: result.outcome === 'blocked',
    })
  }

  if (result.verdict.crossesLine) {
    rows.push({
      code: `classifier.${result.verdict.category}`,
      severity: 'block',
      reason: result.verdict.rationale,
      excerpt: null,
      blocked: true,
    })
  } else if (result.verdict.confidence < CLASSIFIER_REVIEW_CONFIDENCE) {
    rows.push({
      code: 'classifier.low_confidence',
      severity: 'review',
      reason: `Confidence ${result.verdict.confidence.toFixed(2)}: ${result.verdict.rationale}`,
      excerpt: null,
      blocked: false,
    })
  }

  return rows
}
