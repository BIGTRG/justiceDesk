'use client'

/**
 * Tap-to-define legal terms.
 *
 * Every legal term in the interface is tappable. Implemented as a real <button> with a
 * disclosure pattern rather than a hover tooltip: hover does not exist on a phone, which
 * is where most of this product's users are.
 */

import { useId, useState } from 'react'
import { lookupTerm } from '@/lib/glossary'

export function Term({ children, term }: { children: React.ReactNode; term?: string }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()

  const key = term ?? (typeof children === 'string' ? children : '')
  const entry = lookupTerm(key)

  // An unknown term renders as plain text rather than a control that explains nothing.
  if (!entry) return <>{children}</>

  return (
    <span className="relative inline">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline border-b-2 border-dotted border-brand text-brand-dark
                   underline-offset-4 hover:bg-brand-light focus-visible:bg-brand-light"
      >
        {children}
        <span className="sr-only"> — tap for a definition</span>
      </button>
      {open && (
        <span
          id={panelId}
          role="note"
          className="absolute left-0 top-full z-20 mt-1 block w-72 max-w-[85vw] rounded-lg
                     border border-paper-edge bg-white p-3 text-sm font-normal text-ink shadow-lg"
        >
          <span className="block font-semibold capitalize">{entry.term}</span>
          <span className="mt-1 block text-ink-muted">{entry.definition}</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-2 text-sm font-semibold text-brand"
          >
            Close
          </button>
        </span>
      )}
    </span>
  )
}

/**
 * Wrap known glossary terms in body text automatically.
 *
 * Only the first occurrence of each term is linked — marking up every instance of
 * "summons" in a paragraph is noise, and noise is what people stop reading.
 */
export function AutoTerms({ text }: { text: string }) {
  const terms = ['summary ejectment', 'statute of limitations', 'default judgment', 'writ of possession',
                 'clerk of court', 'case number', 'summons', 'complaint', 'magistrate', 'appeal']
  const used = new Set<string>()
  const parts: React.ReactNode[] = []
  let rest = text

  while (rest.length) {
    let earliest: { index: number; term: string } | null = null
    for (const term of terms) {
      if (used.has(term)) continue
      const index = rest.toLowerCase().indexOf(term)
      if (index !== -1 && (!earliest || index < earliest.index)) earliest = { index, term }
    }
    if (!earliest) {
      parts.push(rest)
      break
    }
    parts.push(rest.slice(0, earliest.index))
    const matched = rest.slice(earliest.index, earliest.index + earliest.term.length)
    parts.push(
      <Term key={`${earliest.term}-${parts.length}`} term={earliest.term}>
        {matched}
      </Term>
    )
    used.add(earliest.term)
    rest = rest.slice(earliest.index + earliest.term.length)
  }

  return <>{parts}</>
}
