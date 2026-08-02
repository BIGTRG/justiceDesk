import Link from 'next/link'

/**
 * The masthead. Rendered once in the root layout so every screen carries the same identity.
 *
 * A serif wordmark over a thin gold rule, on the warm page rather than in a coloured bar.
 * This is the element that does most of the work of making the product feel like a firm
 * instead of a form mill — it is the first thing on every screen, and it is the reason a
 * litigant decides whether to trust the deadline we are about to show them.
 *
 * Deliberately not a navigation bar. There is no menu, no account dropdown, no logo grid.
 * Someone who has just been served does not need somewhere else to go.
 */
export function Masthead() {
  return (
    <header className="border-b border-paper-edge bg-paper-card">
      <div className="container-readable flex items-baseline justify-between py-4">
        <Link href="/" className="group inline-flex items-baseline gap-2.5 no-underline">
          <span className="font-serif text-xl tracking-tight text-brand-dark">
            Justice<span className="text-accent">Desk</span>
          </span>
          {/* The rule grows on hover — the only decorative motion in the app. */}
          <span
            aria-hidden
            className="hidden h-px w-8 bg-accent transition-all duration-300 group-hover:w-12 sm:block"
          />
        </Link>

        <span className="text-[0.6875rem] font-bold uppercase tracking-[0.14em] text-ink-faint">
          North Carolina
        </span>
      </div>
    </header>
  )
}
