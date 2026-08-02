import type { Config } from 'tailwindcss'

/**
 * Design system — matches the approved pricing-screen mockup.
 *
 * The look is deliberate rather than decorative. v2's quality standard says the artifact
 * "should look like it came from a firm, not a form mill", and someone deciding whether to
 * trust a legal product with a court deadline reads the surface before they read a word.
 * Warm paper, a serif for headings, navy and gold: closer to a law office than to a SaaS
 * dashboard.
 *
 * Mobile-first throughout. Most litigants reach this on a phone, often an old one, often
 * on a slow connection, sometimes standing in a courthouse hallway.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm near-black, not pure black — softer against a cream page.
        ink: { DEFAULT: '#1b2733', muted: '#5c6b7a', faint: '#8b98a5' },

        // `paper` is the page; `card` is what sits on it. The contrast between warm
        // background and white card is what makes cards read as documents.
        paper: {
          DEFAULT: '#f5f3ee',
          card: '#ffffff',
          sunk: '#ece7dc',
          tint: '#faf8f3',
          edge: '#dcd8ce',
        },

        // Primary. Navy carries authority without the coldness of a product blue.
        brand: {
          DEFAULT: '#1f3a5f',
          dark: '#152a47',
          light: '#e7edf5',
        },

        // Gold is the accent — used for "important, not urgent". Never for danger.
        accent: { DEFAULT: '#b9852f', soft: '#f4e9d4', ink: '#7a5716' },

        // Deadline states. Muted rather than alarm-bright: the people reading these are
        // already frightened, and a screaming red banner does not help them act.
        urgent: { DEFAULT: '#a03434', light: '#f7e6e6' },
        warn: { DEFAULT: '#7a5716', light: '#f4e9d4' },
        ok: { DEFAULT: '#2e6b4f', light: '#e3efe8' },
      },

      fontFamily: {
        // Headings and document text.
        serif: ['Georgia', '"Times New Roman"', 'serif'],
        // Body and UI.
        sans: ['"Avenir Next"', '"Segoe UI"', 'system-ui', '-apple-system', 'sans-serif'],
      },

      fontSize: {
        // Body text is deliberately large. Small type is a barrier for the people most
        // likely to need this.
        base: ['1.0625rem', { lineHeight: '1.65' }],
        lg: ['1.1875rem', { lineHeight: '1.6' }],
      },

      maxWidth: { readable: '38rem' },

      boxShadow: {
        // Soft and navy-tinted rather than neutral grey, so cards sit on the warm page
        // instead of floating above it.
        card: '0 1px 2px rgba(31,58,95,.04), 0 6px 24px rgba(31,58,95,.06)',
        lift: '0 8px 32px rgba(31,58,95,.12)',
      },

      borderRadius: { xl: '0.875rem', '2xl': '1.25rem' },
    },
  },
  plugins: [],
} satisfies Config
