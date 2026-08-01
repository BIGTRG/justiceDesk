/**
 * Disclosure surfaces.
 *
 * The persistent footer is required on every screen by the build spec. It is rendered in
 * the root layout rather than per-page so a new page cannot ship without it.
 *
 * ⚠️ Final copy is pending ethics counsel — see COMPLIANCE.md.
 */

export const PERSISTENT_DISCLOSURE =
  'This platform is not a law firm and does not provide legal advice.'

export function DisclosureFooter() {
  return (
    <footer className="mt-auto border-t border-paper-edge bg-paper-sunk">
      <div className="container-readable py-5 text-sm text-ink-muted">
        <p className="font-semibold text-ink">{PERSISTENT_DISCLOSURE}</p>
        <p className="mt-2">
          JusticeDesk gives legal information and helps you prepare your own paperwork. It cannot
          tell you what to do in your case. Deadlines and court rules can change — check anything
          important with the Clerk of Court.
        </p>
        <p className="mt-2">
          If you need advice about your situation, talk to a licensed attorney.
        </p>
      </div>
    </footer>
  )
}

/** The strip on the landing page, above the fold. */
export function DisclosureStrip() {
  return (
    <div className="border-b border-paper-edge bg-brand-light">
      <p className="container-readable py-3 text-sm font-medium text-brand-dark">
        {PERSISTENT_DISCLOSURE} We help you understand the process and prepare your own documents.
      </p>
    </div>
  )
}

/**
 * The caveat shown whenever content on screen came from unverified legal material.
 *
 * Deliberately not dismissible and not visually quiet: while the compliance gate is
 * closed this is the honest state of the content, and a litigant should see it.
 */
export function UnverifiedContentBanner({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null
  return (
    <div
      role="note"
      className="rounded-lg border border-warn/30 bg-warn-light p-4 text-sm text-warn"
    >
      <p className="font-semibold">Please double-check this with the court.</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  )
}
