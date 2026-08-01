/**
 * Unauthorized-practice-of-law guardrails — the deterministic layer.
 *
 * This is defence in depth, not the whole defence. Three layers guard AI output:
 *   1. the system prompt (svc-ai-gateway) — constrains generation,
 *   2. THIS module — deterministic pattern checks that cannot be talked out of firing,
 *   3. a model-based classifier (svc-ai-gateway) — catches what patterns miss.
 *
 * A regex layer exists because prompt-level constraints are probabilistic and a
 * classifier is another model that can also be wrong. These rules are dumb on purpose:
 * they always fire, at zero latency, and they are auditable by a non-engineer reviewer.
 *
 * ⚠️ The line between legal information and legal advice is a legal question, not an
 * engineering one. The patterns below are a good-faith first pass and MUST be reviewed by
 * ethics counsel before anything ships to a real litigant. See COMPLIANCE.md.
 */

export type UplSeverity = 'block' | 'review' | 'note'

export interface UplPattern {
  code: string
  severity: UplSeverity
  /** What the pattern is trying to catch, for the reviewer queue. */
  reason: string
  pattern: RegExp
  /** Suggested rewrite shown to the model on a regeneration attempt. */
  remediation: string
}

/**
 * Directive-advice patterns: telling the litigant what to do, rather than laying out
 * options and what each one means.
 */
export const DIRECTIVE_ADVICE_PATTERNS: UplPattern[] = [
  {
    code: 'upl.directive_you_should',
    severity: 'block',
    reason: 'Tells the litigant what to do rather than presenting options.',
    pattern: /\byou\s+(?:should|ought\s+to|need\s+to|must)\s+(?!read|know|be\s+aware|check|ask|talk|contact|bring|attend|show\s+up|arrive|sign|keep|save)/i,
    remediation:
      'Present this as options with plain-language consequences, e.g. "People in this situation usually have two choices: … Here is what each one means."',
  },
  {
    code: 'upl.recommendation',
    severity: 'block',
    reason: 'States a recommendation, which is legal advice.',
    pattern: /\bI\s+(?:recommend|advise|suggest|would\s+(?:recommend|advise|suggest))\b/i,
    remediation: 'Remove the recommendation. Describe the available options neutrally and offer attorney review.',
  },
  {
    code: 'upl.best_option',
    severity: 'block',
    reason: 'Ranks one legal course of action above another.',
    pattern: /\b(?:your\s+best\s+(?:option|bet|move|strategy|defense)|the\s+best\s+(?:option|approach|defense|strategy)\s+(?:is|would\s+be)|strongest\s+(?:defense|argument|claim))\b/i,
    remediation: 'Do not rank options. List them and explain what each one involves.',
  },
  {
    code: 'upl.outcome_prediction',
    severity: 'block',
    reason: 'Predicts the outcome of the case.',
    pattern: /\byou(?:'ll|\s+will|\s+would)?\s+(?:win|lose|prevail|be\s+awarded)\b|\b(?:you\s+have\s+a\s+(?:strong|weak|good|bad)\s+case)\b|\bthe\s+(?:judge|court|magistrate)\s+will\s+(?:rule|find|decide|grant|deny)\b/i,
    remediation:
      'Never predict outcomes. Say what the court considers and that outcomes depend on the specific facts and the judge.',
  },
  {
    code: 'upl.legal_opinion',
    severity: 'block',
    reason: 'Offers a legal opinion or conclusion about this litigant’s case.',
    pattern: /\b(?:in\s+my\s+(?:legal\s+)?opinion|legally\s+speaking,?\s+you|you\s+are\s+(?:legally\s+)?(?:liable|not\s+liable|entitled|in\s+the\s+(?:right|wrong))|this\s+debt\s+is\s+(?:not\s+)?(?:valid|enforceable|yours))\b/i,
    remediation:
      'Do not state legal conclusions about this case. Explain what the law says generally and offer attorney review.',
  },
  {
    code: 'upl.attorney_relationship',
    severity: 'block',
    reason: 'Implies an attorney-client relationship or that the assistant is a lawyer.',
    pattern: /\b(?:as\s+your\s+(?:lawyer|attorney)|I(?:'m|\s+am)\s+(?:a|your)\s+(?:lawyer|attorney)|my\s+client|attorney[-\s]client\s+privilege\s+(?:applies|protects\s+(?:this|us|you)))\b/i,
    remediation:
      'State plainly that this platform is not a law firm and does not provide legal advice, and offer attorney review.',
  },
  {
    code: 'upl.deadline_reassurance',
    severity: 'block',
    reason: 'Reassures the litigant about a deadline, which can cause a default.',
    pattern: /\b(?:you\s+(?:have\s+plenty\s+of\s+time|don'?t\s+(?:need\s+to\s+(?:worry|rush)|have\s+to\s+(?:respond|answer|file)))|no\s+need\s+to\s+(?:respond|answer|file|hurry)|missing\s+(?:the\s+)?deadline\s+(?:is\s+)?(?:fine|okay|not\s+a\s+big\s+deal))\b/i,
    remediation:
      'Never minimise a deadline. State the date, what happens if it passes, and that dates should be confirmed with the court.',
  },
  {
    code: 'upl.settlement_amount',
    severity: 'review',
    reason: 'Suggests a specific settlement or payment figure.',
    pattern: /\b(?:offer|settle\s+for|counter[- ]?offer|pay)\s+(?:them\s+)?\$[\d,]+/i,
    remediation:
      'Do not name figures. Explain how settlement works and that the amount is the litigant’s decision, ideally with attorney review.',
  },
  {
    code: 'upl.form_choice_directive',
    severity: 'review',
    reason: 'Directs which form to file, which can be a legal judgment.',
    pattern: /\b(?:file|use)\s+(?:the\s+)?(?:AOC-[A-Z]{1,3}-\d{2,4})\s+(?:instead|rather\s+than|not)\b/i,
    remediation: 'Describe what each form is for and let the litigant choose, with attorney review offered.',
  },
]

/**
 * The absolute floor: the AI drafts, a human signs. Any output implying the platform
 * files, serves, or signs on the litigant's behalf is blocked outright.
 */
export const AUTHORITATIVE_ACTION_PATTERNS: UplPattern[] = [
  {
    code: 'upl.claims_to_file',
    severity: 'block',
    reason: 'Implies the platform will file, serve, sign, or submit on the litigant’s behalf.',
    pattern: /\b(?:I(?:'ll|\s+will)|we(?:'ll|\s+will))\s+(?:file|submit|serve|send|sign|e-?file|deliver)\s+(?:this|it|the\s+\w+)\s*(?:for\s+you|on\s+your\s+behalf|with\s+the\s+court)?/i,
    remediation:
      'The platform prepares documents; the litigant files and signs them. Say what the litigant needs to do and where.',
  },
  {
    code: 'upl.signature_offer',
    severity: 'block',
    reason: 'Offers to sign a document.',
    pattern: /\b(?:I(?:'ll|\s+will)\s+sign|signed\s+on\s+your\s+behalf|we\s+have\s+signed)\b/i,
    remediation: 'Only the litigant may sign. Explain where the signature goes.',
  },
]

export const ALL_UPL_PATTERNS: UplPattern[] = [
  ...DIRECTIVE_ADVICE_PATTERNS,
  ...AUTHORITATIVE_ACTION_PATTERNS,
]

export interface UplFinding {
  code: string
  severity: UplSeverity
  reason: string
  remediation: string
  /** The matched span, truncated. Stored on `upl_flags` for the review queue. */
  excerpt: string
  index: number
}

export interface UplScanResult {
  findings: UplFinding[]
  /** True when at least one `block`-severity pattern matched. */
  blocked: boolean
  /** True when anything matched, at any severity — routes to the review queue. */
  flagged: boolean
  highestSeverity: UplSeverity | null
}

const EXCERPT_RADIUS = 60

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS)
  const end = Math.min(text.length, index + length + EXCERPT_RADIUS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

const SEVERITY_ORDER: Record<UplSeverity, number> = { note: 0, review: 1, block: 2 }

/** Scan model output for unauthorized-practice-of-law risk. Deterministic; no I/O. */
export function scanForUpl(text: string, patterns: UplPattern[] = ALL_UPL_PATTERNS): UplScanResult {
  const findings: UplFinding[] = []

  for (const p of patterns) {
    // Fresh regex per scan: shared `lastIndex` on a global pattern would skip matches.
    const re = new RegExp(p.pattern.source, p.pattern.flags.includes('g') ? p.pattern.flags : `${p.pattern.flags}g`)
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      findings.push({
        code: p.code,
        severity: p.severity,
        reason: p.reason,
        remediation: p.remediation,
        excerpt: excerptAround(text, match.index, match[0].length),
        index: match.index,
      })
      if (match[0].length === 0) re.lastIndex++ // guard against zero-width loops
    }
  }

  findings.sort((a, b) => a.index - b.index)
  const highestSeverity =
    findings.length === 0
      ? null
      : findings.reduce<UplSeverity>(
          (acc, f) => (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[acc] ? f.severity : acc),
          'note'
        )

  return {
    findings,
    blocked: findings.some((f) => f.severity === 'block'),
    flagged: findings.length > 0,
    highestSeverity,
  }
}

/**
 * The disclosure appended to every AI response. Final copy is pending ethics counsel —
 * `DISCLOSURE_COPY_STATUS` is read by the compliance check so this cannot silently ship
 * as final.
 */
export type DisclosureCopyStatus = 'draft_pending_counsel' | 'approved'

export const DISCLOSURE_COPY_STATUS: DisclosureCopyStatus = 'draft_pending_counsel'

export const DEFAULT_DISCLOSURE_FOOTER =
  'This is legal information, not legal advice. JusticeDesk is not a law firm and cannot ' +
  'tell you what to do in your case. Deadlines and rules can change — check them with the ' +
  'clerk of court. You can ask a licensed attorney to review anything here.'

export const DEFAULT_PERSISTENT_FOOTER =
  'This platform is not a law firm and does not provide legal advice.'

export interface DisclosureConfig {
  aiResponseFooter: string
  persistentFooter: string
  copyStatus: DisclosureCopyStatus
}

export function defaultDisclosureConfig(): DisclosureConfig {
  return {
    aiResponseFooter: DEFAULT_DISCLOSURE_FOOTER,
    persistentFooter: DEFAULT_PERSISTENT_FOOTER,
    copyStatus: DISCLOSURE_COPY_STATUS,
  }
}

/** Append the disclosure footer if it is not already present. Idempotent. */
export function withDisclosure(text: string, config: DisclosureConfig): string {
  const trimmed = text.trimEnd()
  if (trimmed.includes(config.aiResponseFooter)) return trimmed
  return `${trimmed}\n\n---\n${config.aiResponseFooter}`
}

/** The message shown when output is blocked. Never leaks the blocked text. */
export const UPL_BLOCK_MESSAGE =
  'I started to answer in a way that would have crossed into legal advice, which I am not ' +
  'able to give. Let me try a different way: I can explain how this step works, what your ' +
  'options are, and what each one involves. I can also set up a review by a licensed attorney.'
