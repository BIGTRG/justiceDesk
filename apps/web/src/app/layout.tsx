import type { Metadata, Viewport } from 'next'
import { ClerkProvider } from '@clerk/nextjs'
import { DisclosureFooter } from '@/components/Disclosure'
import { Masthead } from '@/components/Masthead'
import './globals.css'

export const metadata: Metadata = {
  title: 'JusticeDesk — help with your court case',
  description:
    'Step-by-step help for people handling a North Carolina court case without a lawyer. Not a law firm; not legal advice.',
  // Case portals must never be indexed.
  robots: { index: false, follow: false },
}

/**
 * Nothing in this app is statically prerendered.
 *
 * Every page is per-user and auth-gated, and a case portal held in a CDN cache is a
 * disclosure risk. Forcing dynamic rendering also means the build does not need live
 * Clerk credentials, so CI can build without production secrets.
 */
export const dynamic = 'force-dynamic'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Never disable zoom. Pinch-to-zoom is an accessibility requirement, and this audience
  // includes people reading court papers on a cracked phone screen.
  maximumScale: 5,
  // Matches the warm page, so the phone's browser chrome blends into the app rather than
  // framing it in white.
  themeColor: '#f5f3ee',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className="flex min-h-dvh flex-col">
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4
                       focus:z-50 focus:rounded focus:bg-brand focus:px-4 focus:py-2 focus:text-white"
          >
            Skip to content
          </a>
          <Masthead />
          <main id="main" className="flex-1">
            {children}
          </main>
          {/* Rendered here, not per page, so no screen can ship without it. */}
          <DisclosureFooter />
        </body>
      </html>
    </ClerkProvider>
  )
}
