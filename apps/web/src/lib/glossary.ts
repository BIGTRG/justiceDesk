/**
 * Legal glossary for tap-to-define.
 *
 * Definitions are legal INFORMATION — what a word means in general — never how it applies
 * to the reader's case. "A statute of limitations is a time limit for bringing a lawsuit"
 * is a definition. "Your debt is past the statute of limitations" is advice.
 *
 * ⚠️ UNVERIFIED. Reviewed for tone but not for legal accuracy. Ethics counsel reviews
 * these alongside the disclosure copy — see COMPLIANCE.md.
 */

export interface GlossaryEntry {
  term: string
  definition: string
  aliases?: string[]
}

export const GLOSSARY: GlossaryEntry[] = [
  {
    term: 'summons',
    definition:
      'The court paper that tells you a case has been filed against you and when you have to respond or appear. It usually comes with a complaint.',
  },
  {
    term: 'complaint',
    definition:
      'The paper that starts a lawsuit. It says who is suing, who they are suing, and what they say happened.',
  },
  {
    term: 'answer',
    definition:
      'Your written response to a complaint. You go through what the other side said and state whether you agree, disagree, or do not know.',
  },
  {
    term: 'default judgment',
    definition:
      'A decision the court can make against you without a hearing, because you did not respond in time.',
    aliases: ['default'],
  },
  {
    term: 'service',
    definition:
      'The official way court papers are delivered to you — by a sheriff, by mail, or in person. The date you were served often starts a deadline.',
    aliases: ['served', 'service of process'],
  },
  {
    term: 'statute of limitations',
    definition:
      'A time limit for bringing a lawsuit. Different kinds of claims have different limits. Whether one applies to a case depends on the facts.',
  },
  {
    term: 'magistrate',
    definition:
      'The judicial official who hears small claims and eviction cases in North Carolina. Hearings are usually short and less formal than other courts.',
  },
  {
    term: 'summary ejectment',
    definition: 'The legal name in North Carolina for a court case to evict a tenant.',
    aliases: ['eviction'],
  },
  {
    term: 'writ of possession',
    definition:
      'The court order that allows the sheriff to remove a tenant from a property after an eviction case is decided.',
  },
  {
    term: 'appeal',
    definition:
      'Asking a higher court to look at the case again. From a magistrate, an appeal usually means a completely new hearing in District Court.',
  },
  {
    term: 'standing',
    definition:
      'Whether the person or company suing has the legal right to bring this particular claim. A company that bought a debt generally has to show it owns it.',
  },
  {
    term: 'chain of title',
    definition:
      'The paper trail showing how a debt passed from the original lender to whoever is suing now.',
  },
  {
    term: 'affirmative defense',
    definition:
      'A reason the other side should not win, even if some of what they say is true. Some must be raised in your written answer or they are lost.',
    aliases: ['defense'],
  },
  {
    term: 'case number',
    definition:
      'The number the court uses to identify your case. It is usually at the top right of the first page of your papers.',
    aliases: ['file number'],
  },
  {
    term: 'clerk of court',
    definition:
      'The court office where papers are filed. Clerks can tell you about procedure and deadlines, but they cannot give you legal advice.',
    aliases: ['clerk'],
  },
  {
    term: 'identity theft',
    definition:
      'When someone uses your personal information without permission — for example, to open an account in your name.',
  },
  {
    term: 'implied warranty of habitability',
    definition:
      'A landlord’s duty to keep a rental fit and safe to live in. What it covers depends on the situation.',
  },
]

const index = new Map<string, GlossaryEntry>()
for (const entry of GLOSSARY) {
  index.set(entry.term.toLowerCase(), entry)
  for (const alias of entry.aliases ?? []) index.set(alias.toLowerCase(), entry)
}

export function lookupTerm(term: string): GlossaryEntry | null {
  return index.get(term.trim().toLowerCase()) ?? null
}

export function knownTerms(): string[] {
  return [...index.keys()].sort((a, b) => b.length - a.length)
}
