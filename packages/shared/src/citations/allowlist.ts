/**
 * Citation allowlist — the hard rule from the spec:
 *
 *   "Phase 1 documents cite only statutes/rules stored in our templates table (curated,
 *    verified). The model must never emit a case citation that is not in our curated
 *    source set. Reject/strip any citation not found in the library."
 *
 * A hallucinated citation in a court filing is the single worst failure mode this
 * product has: it can get a pro se litigant's filing struck, and it is the exact conduct
 * that has drawn sanctions against represented parties. So the enforcement is a
 * deny-by-default allowlist over extracted citations, not a model instruction.
 *
 * Case citations are refused wholesale in Phase 1 — the curated library holds statutes
 * and court rules only, so any `X v. Y` reporter citation is by definition off-list.
 */

export type CitationKind = 'statute' | 'rule' | 'case' | 'form' | 'unknown'

export interface CuratedCitation {
  /** Canonical citation text, e.g. "N.C. Gen. Stat. § 1A-1, Rule 12". */
  citation: string
  kind: CitationKind
  /** Plain-language summary shown alongside the citation. */
  summary: string
  /** Alternate spellings the model may emit that should normalise to `citation`. */
  aliases?: string[]
  url?: string
}

export interface ExtractedCitation {
  text: string
  kind: CitationKind
  index: number
  length: number
}

/**
 * Extraction patterns. Deliberately over-inclusive: a false positive gets checked against
 * the allowlist and passes if it is curated, whereas a false negative would let an
 * uncurated citation through unexamined.
 */
const CITATION_PATTERNS: Array<{ kind: CitationKind; pattern: RegExp }> = [
  // N.C. Gen. Stat. § 42-28  /  NCGS 1A-1  /  G.S. § 7A-228
  // The trailing `, Rule 12(a)(1)` is part of the citation, not a separate one — the
  // Rules of Civil Procedure are codified inside § 1A-1, so splitting them would send a
  // half-citation to the allowlist and reject a curated source.
  {
    kind: 'statute',
    pattern: /\b(?:N\.?\s?C\.?\s*(?:Gen\.?\s*Stat\.?|General\s+Statutes?)|NCGS|G\.?S\.?)\s*§{0,2}\s*[\d]+[A-Z]?-[\d.]+(?:\([a-z0-9]+\))*(?:,?\s*Rule\s*\d+(?:\([a-z0-9]+\))*)?/gi,
  },
  // N.C. R. Civ. P. 12(b)(6)  /  Rule 6(e)  /  N.C. Gen. Stat. § 1A-1, Rule 12
  {
    kind: 'rule',
    pattern: /\b(?:N\.?\s?C\.?\s*R\.?\s*Civ\.?\s*P\.?\s*|Rule\s+)\d+(?:\([a-z0-9]+\))*/gi,
  },
  // Smith v. Jones, 123 N.C. App. 456 (2001) — and any bare "X v. Y"
  {
    kind: 'case',
    pattern: /\b[A-Z][A-Za-z.'’&-]+(?:\s+[A-Z][A-Za-z.'’&-]+){0,4}\s+v\.?\s+[A-Z][A-Za-z.'’&-]+(?:\s+[A-Z][A-Za-z.'’&-]+){0,4}(?:,\s*\d+\s+[A-Z][A-Za-z.\s]*\d+)?(?:\s*\(\d{4}\))?/g,
  },
  // AOC-CVM-102, AOC-G-106
  { kind: 'form', pattern: /\bAOC-[A-Z]{1,4}-\d{2,4}\b/g },
]

/** Normalise a citation for comparison: collapse whitespace, strip punctuation variance. */
export function normalizeCitation(citation: string): string {
  return citation
    .toLowerCase()
    .replace(/[§]/g, '')
    .replace(/\bn\.?\s?c\.?\s*gen\.?\s*stat\.?/g, 'ncgs')
    .replace(/\bn\.?\s?c\.?\s*general\s+statutes?/g, 'ncgs')
    .replace(/\bg\.?s\.?\s/g, 'ncgs ')
    .replace(/\bn\.?\s?c\.?\s*r\.?\s*civ\.?\s*p\.?/g, 'ncrcivp')
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractCitations(text: string): ExtractedCitation[] {
  const found: ExtractedCitation[] = []

  for (const { kind, pattern } of CITATION_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags)
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      found.push({ text: match[0].trim(), kind, index: match.index, length: match[0].length })
      if (match[0].length === 0) re.lastIndex++
    }
  }

  // Prefer the longest match at any given position so "N.C. Gen. Stat. § 1A-1, Rule 12"
  // is treated as one citation rather than a statute plus a stray rule.
  found.sort((a, b) => a.index - b.index || b.length - a.length)
  const kept: ExtractedCitation[] = []
  let consumedTo = -1
  for (const c of found) {
    if (c.index >= consumedTo) {
      kept.push(c)
      consumedTo = c.index + c.length
    }
  }
  return kept
}

export class CitationLibrary {
  private readonly byNormalized = new Map<string, CuratedCitation>()

  constructor(entries: CuratedCitation[] = []) {
    for (const entry of entries) this.add(entry)
  }

  add(entry: CuratedCitation): void {
    this.byNormalized.set(normalizeCitation(entry.citation), entry)
    for (const alias of entry.aliases ?? []) {
      this.byNormalized.set(normalizeCitation(alias), entry)
    }
  }

  lookup(citation: string): CuratedCitation | null {
    return this.byNormalized.get(normalizeCitation(citation)) ?? null
  }

  has(citation: string): boolean {
    return this.lookup(citation) !== null
  }

  get size(): number {
    return this.byNormalized.size
  }

  all(): CuratedCitation[] {
    return [...new Set(this.byNormalized.values())]
  }
}

export interface CitationViolation {
  text: string
  kind: CitationKind
  index: number
  reason: string
}

export interface CitationCheckResult {
  allowed: ExtractedCitation[]
  violations: CitationViolation[]
  ok: boolean
}

/**
 * Check every citation in `text` against the curated library.
 *
 * Case citations always violate in Phase 1: the library contains no case law, so there is
 * no set of facts under which a reporter citation could be verified here.
 */
export function checkCitations(text: string, library: CitationLibrary): CitationCheckResult {
  const allowed: ExtractedCitation[] = []
  const violations: CitationViolation[] = []

  for (const citation of extractCitations(text)) {
    if (citation.kind === 'case') {
      violations.push({
        text: citation.text,
        kind: citation.kind,
        index: citation.index,
        reason:
          'Case citations are not permitted in Phase 1. The curated source library contains statutes, court rules and AOC forms only.',
      })
      continue
    }
    if (library.has(citation.text)) {
      allowed.push(citation)
    } else {
      violations.push({
        text: citation.text,
        kind: citation.kind,
        index: citation.index,
        reason: 'Citation is not in the curated, attorney-reviewed source library.',
      })
    }
  }

  return { allowed, violations, ok: violations.length === 0 }
}

export const STRIPPED_CITATION_PLACEHOLDER = '[citation removed — not in verified source library]'

/**
 * Remove uncurated citations from text.
 *
 * Used for conversational assistant output, where a stripped sentence is still useful.
 * Generated *documents* must not be repaired this way — `checkCitations` failing on a
 * document is a hard stop, because a filing with a hole in its authority is worse than
 * no filing. svc-ai-gateway enforces that distinction.
 */
export function stripUncuratedCitations(
  text: string,
  library: CitationLibrary
): { text: string; removed: CitationViolation[] } {
  const { violations } = checkCitations(text, library)
  if (violations.length === 0) return { text, removed: [] }

  // Replace from the end so earlier indices stay valid.
  let out = text
  for (const v of [...violations].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, v.index) + STRIPPED_CITATION_PLACEHOLDER + out.slice(v.index + v.text.length)
  }
  return { text: out, removed: violations }
}
