/**
 * Spoken scripts.
 *
 * Four of these carry legal weight and are read aloud, once, at speed, to someone who is
 * frightened and probably not listening carefully:
 *
 *   recording_notice      — v2 non-negotiable #5, announced on every call
 *   paywall_notice        — the moment a free call becomes a paid one
 *   referral_disclosure   — that a participating attorney will contact them
 *   tcpa_consent_request  — express written consent for outbound contact
 *
 * ⚠️ ALL COPY BELOW IS A DRAFT PLACEHOLDER. It has not been written or reviewed by
 * counsel. `SCRIPT_STATUS` is checked at boot and svc-voice refuses to answer calls once
 * the compliance gate opens while these are still drafts — approved-sounding placeholder
 * copy going live is exactly the failure that check prevents. See HUMAN_REVIEW.md L-2.
 */

import type { SpokenLine } from '@justicedesk/shared'

export type ScriptStatus = 'draft_pending_counsel' | 'approved'

export const SCRIPT_STATUS: ScriptStatus = 'draft_pending_counsel'

/** Bumped whenever wording changes. Stored on every consent row as evidence. */
export const SCRIPT_VERSION = 'draft-2026-08-01'

export type Language = 'en' | 'es'

type ScriptTable = Record<SpokenLine, string>

/**
 * English drafts.
 *
 * Written at the same sixth-grade reading level as the app, and deliberately without
 * reassurance: "this call is being recorded" is not softened into something a listener
 * can mishear as optional.
 */
const EN: ScriptTable = {
  recording_notice:
    'Before we start — this call is recorded. Justice Desk is not a law firm and cannot give you legal advice. ' +
    'I can explain how the court process works and help you get your paperwork ready.',

  free_window_intro:
    'The first few minutes are free. Tell me what happened, in your own words.',

  paywall_notice:
    'We are at the end of the free time. I can keep going two ways: by the minute, or a flat session ' +
    'that covers the whole call. I can also text you a link instead, and you can decide later. ' +
    'Which would you like?',

  payment_link_sent:
    'I have texted you a link. Once it goes through we can carry on.',

  payment_failed:
    'That payment did not go through, so I have stopped the clock. Nothing more will be charged. ' +
    'I can still text you what we covered.',

  referral_disclosure:
    'This sounds like something a lawyer should handle. I can pass your details to a lawyer who takes ' +
    'cases like yours, and they would contact you directly. They pay us a flat fee to receive it, ' +
    'the same whatever happens with your case. Would you like me to do that?',

  tcpa_consent_request:
    'Can I text you about this — reminders about your dates, and how to get your paperwork ready? ' +
    'Reply STOP any time to end them. Is that a yes?',

  drip_offer:
    'No problem. I can text you a summary of what we covered and a reminder before your deadline, free.',

  goodbye:
    'You are all set. Check your texts for the link. Good luck.',

  goodbye_no_capture:
    'Understood. Justice Desk is here if you change your mind. Good luck.',
}

/**
 * Spanish drafts.
 *
 * ⚠️ Machine-drafted from the English and NOT reviewed by a native speaker or by counsel.
 * A mistranslated consent or recording notice is not a cosmetic bug — it is a defective
 * disclosure. These must be professionally translated before the Spanish line opens.
 * See HUMAN_REVIEW.md L-2a.
 */
const ES: ScriptTable = {
  recording_notice:
    'Antes de empezar — esta llamada se graba. Justice Desk no es un bufete de abogados y no puede darle ' +
    'asesoramiento legal. Puedo explicarle cómo funciona el proceso judicial y ayudarle a preparar sus documentos.',
  free_window_intro: 'Los primeros minutos son gratis. Cuénteme qué pasó, con sus propias palabras.',
  paywall_notice:
    'Se acabó el tiempo gratuito. Puedo continuar de dos maneras: por minuto, o una sesión de precio fijo ' +
    'que cubre toda la llamada. También puedo enviarle un enlace por mensaje y usted decide después. ¿Qué prefiere?',
  payment_link_sent: 'Le envié un enlace por mensaje. En cuanto se procese, seguimos.',
  payment_failed:
    'Ese pago no se procesó, así que detuve el cobro. No se le cobrará nada más. ' +
    'Aún puedo enviarle por mensaje lo que hablamos.',
  referral_disclosure:
    'Esto parece algo que debería manejar un abogado. Puedo pasar sus datos a un abogado que lleva casos como ' +
    'el suyo, y él le contactaría directamente. Nos paga una tarifa fija por recibirlo, la misma pase lo que ' +
    'pase con su caso. ¿Quiere que lo haga?',
  tcpa_consent_request:
    '¿Puedo enviarle mensajes sobre esto — recordatorios de sus fechas y cómo preparar sus documentos? ' +
    'Responda STOP en cualquier momento para terminarlos. ¿Es un sí?',
  drip_offer:
    'No hay problema. Puedo enviarle por mensaje un resumen de lo que hablamos y un recordatorio antes de su ' +
    'fecha límite, gratis.',
  goodbye: 'Todo listo. Revise sus mensajes para el enlace. Buena suerte.',
  goodbye_no_capture: 'Entendido. Justice Desk está aquí si cambia de opinión. Buena suerte.',
}

const TABLES: Record<Language, ScriptTable> = { en: EN, es: ES }

export function scriptFor(line: SpokenLine, language: Language = 'en'): string {
  return TABLES[language][line]
}

/** Lines that carry legal weight — these are the ones counsel must sign off. */
export const LEGALLY_OPERATIVE_LINES: SpokenLine[] = [
  'recording_notice',
  'paywall_notice',
  'referral_disclosure',
  'tcpa_consent_request',
]

export class ScriptsNotApprovedError extends Error {
  constructor() {
    super(
      'svc-voice will not answer calls: the spoken scripts are still drafts.\n' +
        `  ${LEGALLY_OPERATIVE_LINES.join(', ')} carry legal weight and have not been reviewed by counsel.\n` +
        '  See COMPLIANCE.md §2 and HUMAN_REVIEW.md L-2. Set SCRIPT_STATUS to "approved" after sign-off.'
    )
    this.name = 'ScriptsNotApprovedError'
  }
}

/**
 * Boot interlock.
 *
 * While the compliance gate is closed (staging), draft scripts are expected and allowed —
 * that is what staging is for. Once the gate opens, draft copy must not reach a caller.
 */
export function assertScriptsUsable(complianceReviewComplete: boolean): void {
  if (complianceReviewComplete && SCRIPT_STATUS !== 'approved') {
    throw new ScriptsNotApprovedError()
  }
}
