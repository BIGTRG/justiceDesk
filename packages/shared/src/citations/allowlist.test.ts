import {
  CitationLibrary,
  checkCitations,
  extractCitations,
  normalizeCitation,
  STRIPPED_CITATION_PLACEHOLDER,
  stripUncuratedCitations,
} from './allowlist.js'

const library = new CitationLibrary([
  {
    citation: 'N.C. Gen. Stat. § 1A-1, Rule 12',
    kind: 'rule',
    summary: 'Defenses and objections, including the time to answer.',
    aliases: ['N.C. Gen. Stat. § 1A-1', 'Rule 12'],
  },
  {
    citation: 'N.C. Gen. Stat. § 42-28',
    kind: 'statute',
    summary: 'Summons in a summary ejectment case.',
  },
  {
    citation: 'N.C. Gen. Stat. § 7A-228',
    kind: 'statute',
    summary: 'Appeal from the magistrate to district court.',
  },
  { citation: 'AOC-CVM-102', kind: 'form', summary: 'Small claims complaint form.' },
])

describe('normalizeCitation', () => {
  it('folds spelling and punctuation variants together', () => {
    const forms = [
      'N.C. Gen. Stat. § 42-28',
      'N.C. Gen. Stat. §42-28',
      'NCGS 42-28',
      'N.C. General Statutes 42-28',
      'n.c. gen. stat. § 42-28',
    ]
    const normalized = forms.map(normalizeCitation)
    expect(new Set(normalized).size).toBe(1)
  })
})

describe('extractCitations', () => {
  it('finds statutes in prose', () => {
    const found = extractCitations('Under N.C. Gen. Stat. § 42-28 the summons is returnable.')
    expect(found.map((c) => c.text)).toContain('N.C. Gen. Stat. § 42-28')
    expect(found[0]?.kind).toBe('statute')
  })

  it('finds AOC form numbers', () => {
    const found = extractCitations('Use form AOC-CVM-102 to start the case.')
    expect(found.map((c) => c.text)).toEqual(['AOC-CVM-102'])
    expect(found[0]?.kind).toBe('form')
  })

  it('finds case citations so they can be refused', () => {
    const found = extractCitations('See Smith v. Jones, 123 N.C. App. 456 (2001) for more.')
    expect(found.some((c) => c.kind === 'case')).toBe(true)
  })

  it('finds a bare party-versus-party reference', () => {
    const found = extractCitations('The holding in Brown v. Board applies here.')
    expect(found.some((c) => c.kind === 'case')).toBe(true)
  })

  it('does not split a combined statute-and-rule citation into two', () => {
    const found = extractCitations('See N.C. Gen. Stat. § 1A-1, Rule 12(a)(1).')
    expect(found).toHaveLength(1)
    expect(found[0]?.text).toMatch(/1A-1/)
  })

  it('returns nothing for text with no citations', () => {
    expect(extractCitations('Bring two copies of the form to the clerk.')).toEqual([])
  })
})

describe('CitationLibrary', () => {
  it('matches a curated citation across spelling variants', () => {
    expect(library.has('N.C. Gen. Stat. § 42-28')).toBe(true)
    expect(library.has('NCGS 42-28')).toBe(true)
    expect(library.has('G.S. 42-28')).toBe(true)
  })

  it('matches through an alias', () => {
    expect(library.lookup('Rule 12')?.citation).toBe('N.C. Gen. Stat. § 1A-1, Rule 12')
  })

  it('does not match an uncurated statute', () => {
    expect(library.has('N.C. Gen. Stat. § 99-99')).toBe(false)
  })

  it('exposes the curated set for the admin UI', () => {
    expect(library.all().length).toBeGreaterThan(0)
    expect(library.all().every((c) => c.summary.length > 0)).toBe(true)
  })
})

describe('checkCitations', () => {
  it('passes text citing only curated sources', () => {
    const result = checkCitations(
      'Under N.C. Gen. Stat. § 42-28, the summons is returnable. Use AOC-CVM-102.',
      library
    )
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.allowed).toHaveLength(2)
  })

  it('rejects a statute that is not in the library', () => {
    const result = checkCitations('See N.C. Gen. Stat. § 99-1234 for details.', library)
    expect(result.ok).toBe(false)
    expect(result.violations[0]?.reason).toMatch(/not in the curated/i)
  })

  it('always rejects a case citation, curated or not', () => {
    const result = checkCitations('See Smith v. Jones, 123 N.C. App. 456 (2001).', library)
    expect(result.ok).toBe(false)
    expect(result.violations[0]?.kind).toBe('case')
    expect(result.violations[0]?.reason).toMatch(/not permitted in Phase 1/i)
  })

  it('rejects a plausible-looking hallucinated citation', () => {
    // The exact failure mode this allowlist exists to stop: a real-looking cite to a
    // statute that does not exist, emitted confidently.
    const result = checkCitations(
      'North Carolina law bars this under N.C. Gen. Stat. § 75-1.2(c).',
      library
    )
    expect(result.ok).toBe(false)
  })

  it('reports each offending citation separately', () => {
    const result = checkCitations('See N.C. Gen. Stat. § 99-1 and N.C. Gen. Stat. § 99-2.', library)
    expect(result.violations).toHaveLength(2)
  })
})

describe('stripUncuratedCitations', () => {
  it('leaves clean text untouched', () => {
    const text = 'Under N.C. Gen. Stat. § 42-28, the summons is returnable.'
    expect(stripUncuratedCitations(text, library)).toEqual({ text, removed: [] })
  })

  it('replaces an uncurated citation with a placeholder', () => {
    const { text, removed } = stripUncuratedCitations('See N.C. Gen. Stat. § 99-1234 here.', library)
    expect(text).toContain(STRIPPED_CITATION_PLACEHOLDER)
    expect(text).not.toContain('99-1234')
    expect(removed).toHaveLength(1)
  })

  it('keeps curated citations while removing uncurated ones from the same sentence', () => {
    const { text } = stripUncuratedCitations(
      'Compare N.C. Gen. Stat. § 42-28 with N.C. Gen. Stat. § 99-1234.',
      library
    )
    expect(text).toContain('N.C. Gen. Stat. § 42-28')
    expect(text).not.toContain('99-1234')
  })

  it('handles several removals without corrupting offsets', () => {
    const { text, removed } = stripUncuratedCitations(
      'First N.C. Gen. Stat. § 99-1, then N.C. Gen. Stat. § 99-2, then N.C. Gen. Stat. § 99-3.',
      library
    )
    expect(removed).toHaveLength(3)
    expect(text).not.toMatch(/99-[123]/)
    expect(text.match(/citation removed/g)).toHaveLength(3)
  })
})
