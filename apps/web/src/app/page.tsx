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
            className="rounded-lg border border-paper-edge bg-paper-card px-3 py-2 text-sm
                       font-semibold transition-colors hover:border-brand/40"
            lang={lang === 'en' ? 'es' : 'en'}
          >
            {t.toggle}
          </button>
        </div>

        <h1 className="mt-4 leading-tight">{t.headline}</h1>
        <p className="mt-3 max-w-[34rem] text-lg text-ink-muted">{t.sub}</p>

        {/*
          Door 1 — CALL. Largest element on the page, and a real tel: link.
          Filled navy rather than a tinted panel: it is the only element on the page that
          should be unmissable, and the number is set in the serif so it reads as a
          nameplate rather than a button label.
        */}
        <a
          href={`tel:${dial}`}
          className="group mt-7 block rounded-2xl bg-brand p-7 text-center no-underline
                     shadow-card transition-shadow hover:shadow-lift"
        >
          <span className="block text-[0.6875rem] font-bold uppercase tracking-[0.14em] text-accent">
            {t.callLabel}
          </span>
          <span className="mt-3 block font-serif text-4xl tracking-tight text-white sm:text-5xl">
            {display}
          </span>
          <span aria-hidden className="mx-auto mt-4 block h-px w-10 bg-accent/60" />
          <span className="mt-4 block text-sm text-white/75">{t.callHint}</span>
        </a>

        {/* Doors 2 and 3 */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => router.push('/intake')}
            className="card-interactive text-left"
          >
            <span className="block font-serif text-lg text-ink">{t.chat}</span>
            <span className="mt-1 block text-sm text-ink-muted">{t.chatHint}</span>
          </button>
          <button
            type="button"
            onClick={() => router.push('/intake?start=1')}
            className="card-interactive text-left"
          >
            <span className="block font-serif text-lg text-ink">{t.start}</span>
            <span className="mt-1 block text-sm text-ink-muted">{t.startHint}</span>
          </button>
        </div>

        {/* Placed above the marketing, on purpose. */}
        <div className="notice-urgent mt-8">
          <h2 className="text-lg text-urgent sm:text-xl">{t.urgentTitle}</h2>
          <p className="mt-2 text-sm">{t.urgentBody}</p>
        </div>

        <section className="mt-12">
          <p className="eyebrow">{t.howTitle}</p>
          {/* Numbered and ruled, so it reads as a sequence rather than a feature list. */}
          <ol className="mt-4 divide-y divide-paper-edge border-y border-paper-edge">
            {t.how.map(([title, body], i) => (
              <li key={title} className="flex gap-4 py-4">
                <span className="font-serif text-lg text-accent" aria-hidden>
                  {i + 1}
                </span>
                <span className="block">
                  <span className="block font-semibold">{title}</span>
                  <span className="mt-0.5 block text-sm text-ink-muted">{body}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        {/* Stated plainly and given its own heading rather than buried in a footer. */}
        <section className="panel mt-10">
          <h2 className="text-lg sm:text-xl">{t.notTitle}</h2>
          <p className="mt-2 text-sm text-ink-muted">{t.not}</p>
        </section>

        <div className="rule mt-10 pt-6">
          <h2 className="text-lg sm:text-xl">{t.already}</h2>
          <Link
            href="/cases"
            className="mt-2 inline-block font-semibold text-brand underline underline-offset-4
                       hover:text-brand-dark"
          >
            {t.goToCases}
          </Link>
        </div>
      </div>
    </>
  )
}
