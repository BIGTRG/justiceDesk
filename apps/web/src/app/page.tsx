'use client'

/**
 * justicedesk.law — the new front door (v2 §4).
 *
 * Replaces the Phase 1 landing page. One hero, three doors: CALL, CHAT, APP.
 *
 * The phone number is the largest element on the page and the first thing after the
 * headline, because the call line is the front door and because someone who has just been
 * served is more likely to phone than to type. It is a real `tel:` link, so one tap dials.
 *
 * Spanish is a toggle rather than a separate site: the same brain answers both lines, and
 * a separate site would drift.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { DisclosureStrip } from '@/components/Disclosure'

type Lang = 'en' | 'es'

const COPY = {
  en: {
    toggle: 'Español',
    headline: 'Facing court without a lawyer?',
    sub: 'Talk to Justice Desk. Get answers. Take control of your own case.',
    callLabel: 'Call us — answered 24 hours',
    callHint: 'First few minutes free. Real answers, not a menu.',
    chat: 'Or chat now',
    chatHint: 'Same answers, typed.',
    start: 'Or start your case',
    startHint: 'Your dates, your documents, step by step.',
    urgentTitle: 'Is your court date in the next few days?',
    urgentBody:
      'Go to your hearing. Showing up matters more than any paperwork. Call us on the way if you want to know what to expect.',
    howTitle: 'What Justice Desk does',
    how: [
      ['Tells you what happens next', 'The steps in a case like yours, in plain English.'],
      ['Works out your dates', 'We show our working, so you can check it with the clerk.'],
      ['Prepares your paperwork', 'You read it, you sign it, you file it. It stays yours.'],
    ],
    notTitle: 'What Justice Desk is not',
    not: 'We are not a law firm and we do not give legal advice. We cannot tell you what to do or predict what a judge will decide. We explain your options and what each one involves.',
    already: 'Already started?',
    goToCases: 'Go to my cases',
  },
  es: {
    toggle: 'English',
    headline: '¿Enfrenta la corte sin abogado?',
    sub: 'Hable con Justice Desk. Obtenga respuestas. Tome control de su propio caso.',
    callLabel: 'Llámenos — contestamos 24 horas',
    callHint: 'Los primeros minutos son gratis. Respuestas reales, no un menú.',
    chat: 'O escriba ahora',
    chatHint: 'Las mismas respuestas, por escrito.',
    start: 'O empiece su caso',
    startHint: 'Sus fechas, sus documentos, paso a paso.',
    urgentTitle: '¿Su fecha en la corte es en los próximos días?',
    urgentBody:
      'Vaya a su audiencia. Presentarse importa más que cualquier documento. Llámenos en el camino si quiere saber qué esperar.',
    howTitle: 'Lo que hace Justice Desk',
    how: [
      ['Le dice qué sigue', 'Los pasos de un caso como el suyo, en palabras sencillas.'],
      ['Calcula sus fechas', 'Le mostramos cómo, para que lo confirme con la corte.'],
      ['Prepara sus documentos', 'Usted los lee, los firma y los presenta. Son suyos.'],
    ],
    notTitle: 'Lo que Justice Desk no es',
    not: 'No somos un bufete de abogados y no damos asesoramiento legal. No podemos decirle qué hacer ni predecir lo que decidirá un juez. Explicamos sus opciones y lo que implica cada una.',
    already: '¿Ya empezó?',
    goToCases: 'Ir a mis casos',
  },
} as const

/** Display and dial forms are separate so the tel: link is never broken by formatting. */
const PHONE_DISPLAY = process.env.NEXT_PUBLIC_PHONE_DISPLAY ?? '(919) 555-0100'
const PHONE_E164 = process.env.NEXT_PUBLIC_PHONE_E164 ?? '+19195550100'
const PHONE_ES_DISPLAY = process.env.NEXT_PUBLIC_PHONE_ES_DISPLAY ?? '(919) 555-0101'
const PHONE_ES_E164 = process.env.NEXT_PUBLIC_PHONE_ES_E164 ?? '+19195550101'

export default function LandingPage() {
  const router = useRouter()
  const [lang, setLang] = useState<Lang>('en')
  const t = COPY[lang]

  const display = lang === 'es' ? PHONE_ES_DISPLAY : PHONE_DISPLAY
  const dial = lang === 'es' ? PHONE_ES_E164 : PHONE_E164

  return (
    <>
      <DisclosureStrip />

      <div className="container-readable py-8">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setLang(lang === 'en' ? 'es' : 'en')}
            className="rounded-lg border border-paper-edge px-3 py-2 text-sm font-semibold"
            lang={lang === 'en' ? 'es' : 'en'}
          >
            {t.toggle}
          </button>
        </div>

        <h1 className="mt-4 text-3xl font-bold leading-tight">{t.headline}</h1>
        <p className="mt-3 text-lg text-ink-muted">{t.sub}</p>

        {/* Door 1 — CALL. Largest element on the page, and a real tel: link. */}
        <a
          href={`tel:${dial}`}
          className="mt-7 block rounded-2xl border-2 border-brand bg-brand-light p-6 text-center"
        >
          <span className="block text-sm font-bold uppercase tracking-wide text-brand-dark">
            {t.callLabel}
          </span>
          <span className="mt-2 block text-4xl font-bold tracking-tight text-brand-dark sm:text-5xl">
            {display}
          </span>
          <span className="mt-2 block text-sm text-brand-dark">{t.callHint}</span>
        </a>

        {/* Doors 2 and 3 */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => router.push('/intake')}
            className="card text-left hover:bg-paper-sunk"
          >
            <span className="block text-lg font-semibold">{t.chat}</span>
            <span className="mt-1 block text-sm text-ink-muted">{t.chatHint}</span>
          </button>
          <button
            type="button"
            onClick={() => router.push('/intake?start=1')}
            className="card text-left hover:bg-paper-sunk"
          >
            <span className="block text-lg font-semibold">{t.start}</span>
            <span className="mt-1 block text-sm text-ink-muted">{t.startHint}</span>
          </button>
        </div>

        {/* Placed above the marketing, on purpose. */}
        <div className="mt-8 rounded-xl border border-urgent/30 bg-urgent-light p-5">
          <h2 className="font-bold text-urgent">{t.urgentTitle}</h2>
          <p className="mt-2 text-sm">{t.urgentBody}</p>
        </div>

        <section className="mt-10">
          <h2 className="text-xl font-bold">{t.howTitle}</h2>
          <ul className="mt-4 space-y-4">
            {t.how.map(([title, body]) => (
              <li key={title}>
                <p className="font-semibold">{title}</p>
                <p className="text-sm text-ink-muted">{body}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* Stated plainly and given its own heading rather than buried in a footer. */}
        <section className="mt-8 rounded-xl bg-paper-sunk p-5">
          <h2 className="font-bold">{t.notTitle}</h2>
          <p className="mt-2 text-sm text-ink-muted">{t.not}</p>
        </section>

        <div className="mt-8">
          <h2 className="font-bold">{t.already}</h2>
          <Link href="/cases" className="mt-2 inline-block font-semibold text-brand underline">
            {t.goToCases}
          </Link>
        </div>
      </div>
    </>
  )
}
