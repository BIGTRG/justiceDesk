/**
 * The curated citation library.
 *
 * This is the ONLY set of legal authorities the AI gateway may emit. Anything not listed
 * here is stripped from conversational output and hard-fails document generation
 * (see packages/shared/src/citations/allowlist.ts).
 *
 * ⚠️ EVERY ENTRY IS UNVERIFIED. Summaries below are plain-language paraphrases written
 * from the statutory scheme, not quotations, and they have not been checked against the
 * current text of the statute by a licensed North Carolina attorney. Each must be
 * confirmed — text, subsection, and current effective version — before the compliance
 * gate opens. See COMPLIANCE.md.
 *
 * Deliberately absent: case law. Phase 1 cites statutes, court rules and AOC forms only,
 * so a reporter citation has nothing to match against and is always refused.
 */

import type { CuratedCitation } from '@justicedesk/shared'

export const NC_CURATED_CITATIONS: CuratedCitation[] = [
  // ---------------------------------------------------------------- Civil Procedure
  {
    citation: 'N.C. Gen. Stat. § 1A-1, Rule 6',
    kind: 'rule',
    summary:
      'How to count deadlines. The day you were served is not counted, and if the last day is a weekend or holiday you get the next day the court is open.',
    aliases: ['Rule 6', 'N.C. R. Civ. P. 6'],
  },
  {
    citation: 'N.C. Gen. Stat. § 1A-1, Rule 6(e)',
    kind: 'rule',
    summary: 'When papers are served on you by mail, three days are added to your response time.',
    aliases: ['Rule 6(e)', 'N.C. R. Civ. P. 6(e)'],
  },
  {
    citation: 'N.C. Gen. Stat. § 1A-1, Rule 12',
    kind: 'rule',
    summary:
      'Your written response to a lawsuit, and the reasons you can ask the court to throw the case out.',
    aliases: ['Rule 12', 'N.C. R. Civ. P. 12'],
  },
  {
    citation: 'N.C. Gen. Stat. § 1A-1, Rule 12(a)(1)',
    kind: 'rule',
    summary: 'A defendant generally has 30 days after being served to file a written answer.',
    aliases: ['Rule 12(a)(1)', 'N.C. R. Civ. P. 12(a)(1)'],
  },
  {
    citation: 'N.C. Gen. Stat. § 1A-1, Rule 8(c)',
    kind: 'rule',
    summary:
      'Affirmative defenses. Some defenses are lost if you do not raise them in your written answer.',
    aliases: ['Rule 8(c)'],
  },
  {
    citation: 'N.C. Gen. Stat. § 1A-1, Rule 55',
    kind: 'rule',
    summary:
      'Default judgment. If you do not respond in time, the other side can ask the court to rule against you without a hearing.',
    aliases: ['Rule 55'],
  },
  {
    citation: 'N.C. Gen. Stat. § 1A-1, Rule 60(b)',
    kind: 'rule',
    summary: 'Asking the court to set aside a judgment that was already entered against you.',
    aliases: ['Rule 60(b)'],
  },

  // ---------------------------------------------------------------- Limitations
  {
    citation: 'N.C. Gen. Stat. § 1-52',
    kind: 'statute',
    summary:
      'Three-year time limit for many contract and debt claims. Whether it applies depends on the facts and on when the clock started.',
  },
  {
    citation: 'N.C. Gen. Stat. § 1-15',
    kind: 'statute',
    summary: 'A lawsuit must be started within the time limit that applies to that kind of claim.',
  },

  // ---------------------------------------------------------------- Small claims
  {
    citation: 'N.C. Gen. Stat. § 7A-210',
    kind: 'statute',
    summary: 'What makes a case a small claim that a magistrate can decide.',
  },
  {
    citation: 'N.C. Gen. Stat. § 7A-213',
    kind: 'statute',
    summary: 'How a small claim is started and assigned to a magistrate.',
  },
  {
    citation: 'N.C. Gen. Stat. § 7A-214',
    kind: 'statute',
    summary:
      'The small claims summons sets your hearing date. It is set a short time after the summons is issued.',
  },
  {
    citation: 'N.C. Gen. Stat. § 7A-218',
    kind: 'statute',
    summary: 'A defendant in small claims court does not have to file a written answer to be heard.',
  },
  {
    citation: 'N.C. Gen. Stat. § 7A-228',
    kind: 'statute',
    summary:
      'Appealing a magistrate’s decision for a new hearing in district court. There is a short deadline to give notice of appeal.',
  },

  // ---------------------------------------------------------------- Summary ejectment
  {
    citation: 'N.C. Gen. Stat. § 42-26',
    kind: 'statute',
    summary: 'The reasons a landlord can ask the court to remove a tenant.',
  },
  {
    citation: 'N.C. Gen. Stat. § 42-28',
    kind: 'statute',
    summary:
      'The summons in an eviction case. It sets a hearing a short time after the summons is issued.',
  },
  {
    citation: 'N.C. Gen. Stat. § 42-34',
    kind: 'statute',
    summary:
      'Staying an eviction while you appeal, including paying rent to the court while the appeal is pending.',
  },
  {
    citation: 'N.C. Gen. Stat. § 42-36.2',
    kind: 'statute',
    summary:
      'The writ of possession — the order that lets the sheriff remove you — and the wait before it can be issued.',
  },
  {
    citation: 'N.C. Gen. Stat. § 42-42',
    kind: 'statute',
    summary: 'A landlord’s duty to keep the property fit and safe to live in.',
  },
  {
    citation: 'N.C. Gen. Stat. § 42-46',
    kind: 'statute',
    summary: 'Limits on late fees and certain other fees a landlord can charge.',
  },

  // ---------------------------------------------------------------- Debt collection
  {
    citation: 'N.C. Gen. Stat. § 58-70-115',
    kind: 'statute',
    summary: 'Things a debt collector is not allowed to do when trying to collect from you.',
  },
  {
    citation: 'N.C. Gen. Stat. § 58-70-150',
    kind: 'statute',
    summary:
      'What a debt buyer must show the court to win a collection lawsuit, including proof it owns the debt.',
  },
  {
    citation: 'N.C. Gen. Stat. § 75-1.1',
    kind: 'statute',
    summary: 'Unfair or deceptive business practices.',
  },

  // ---------------------------------------------------------------- Fees
  {
    citation: 'N.C. Gen. Stat. § 1-110',
    kind: 'statute',
    summary:
      'Asking the court to let you file without paying the fee, if you cannot afford it.',
  },
  {
    citation: 'N.C. Gen. Stat. § 7A-305',
    kind: 'statute',
    summary: 'The fees charged for filing a civil case.',
  },

  // ---------------------------------------------------------------- AOC forms
  {
    citation: 'AOC-CVM-102',
    kind: 'form',
    summary: 'Small claims form. Exact title pending verification against the official AOC form.',
  },
  {
    citation: 'AOC-CVM-103',
    kind: 'form',
    summary: 'Small claims form. Exact title pending verification against the official AOC form.',
  },
  {
    citation: 'AOC-CVM-201',
    kind: 'form',
    summary:
      'Summary ejectment (eviction) form. Exact title pending verification against the official AOC form.',
  },
  {
    citation: 'AOC-G-106',
    kind: 'form',
    summary:
      'Petition and order to proceed without paying court costs, for people who cannot afford the filing fee.',
  },
]

/**
 * Open questions a reviewing attorney must resolve before any of the above may be
 * presented to a litigant. Surfaced by the `verify-content` script and COMPLIANCE.md.
 */
export const CITATION_OPEN_QUESTIONS: string[] = [
  'Confirm the current text and subsection numbering of every statute and rule listed, against the current General Statutes.',
  'Confirm that each plain-language summary is accurate and does not state a legal conclusion.',
  'Confirm the exact titles and current revision dates of AOC-CVM-102, AOC-CVM-103, AOC-CVM-201 and AOC-G-106, and whether these are the correct forms for the three Phase 1 case types.',
  'Confirm whether N.C. Gen. Stat. § 58-70-150 applies to all defendants in the debt_defense workflow or only to suits brought by debt buyers.',
  'Decide whether any case law is needed for Phase 1. If so, the allowlist must be extended and the blanket refusal of case citations revisited.',
]
