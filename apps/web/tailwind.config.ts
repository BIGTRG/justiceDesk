import type { Config } from 'tailwindcss'

/**
 * Mobile-first by default. Most litigants reach this on a phone, often an old one, often
 * on a slow connection, sometimes standing in a courthouse hallway.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#12151a', muted: '#4a5261', faint: '#6b7480' },
        paper: { DEFAULT: '#ffffff', sunk: '#f5f6f8', edge: '#e3e6ea' },
        brand: { DEFAULT: '#1c4f8b', dark: '#153c6b', light: '#e8f0fa' },
        urgent: { DEFAULT: '#a4232b', light: '#fdeaea' },
        warn: { DEFAULT: '#8a5a00', light: '#fdf3e0' },
        ok: { DEFAULT: '#1d6b45', light: '#e7f4ed' },
      },
      fontSize: {
        // Body text is deliberately large. Small type is a barrier for the people
        // most likely to need this.
        base: ['1.0625rem', { lineHeight: '1.65' }],
        lg: ['1.1875rem', { lineHeight: '1.6' }],
      },
      maxWidth: { readable: '38rem' },
    },
  },
  plugins: [],
} satisfies Config
