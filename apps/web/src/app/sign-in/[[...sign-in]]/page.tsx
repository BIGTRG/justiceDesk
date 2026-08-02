/**
 * S2 — phone-first sign in.
 *
 * Phone before email on purpose: this audience is more reliably reachable by text, and
 * deadline reminders go by SMS.
 */

import { SignIn } from '@clerk/nextjs'

export default function SignInPage() {
  return (
    <div className="container-readable py-10">
      <h1 className="text-2xl">Save your case</h1>
      <p className="mt-2 text-ink-muted">
        We will text you a code. Your number is also how we send deadline reminders.
      </p>
      <div className="mt-6">
        <SignIn
          appearance={{
            elements: {
              rootBox: 'w-full',
              card: 'shadow-none border border-paper-edge rounded-xl',
            },
          }}
        />
      </div>
      <p className="mt-6 text-sm text-ink-faint">
        Standard message and data rates may apply. Reply STOP to any text to stop reminders.
      </p>
    </div>
  )
}
